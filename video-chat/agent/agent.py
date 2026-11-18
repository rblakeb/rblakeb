"""The AI companion voice agent.

The website dispatches this agent into a LiveKit room for each companion call.
It hears the user (speech-to-text), sees them (camera frames plus behavior
events from the browser), replies as the character (Claude), speaks (text-to-
speech), and optionally drives a photorealistic avatar. When the call ends it
sends the transcript back to the website, which updates the character's memory.

Run:  python agent.py dev     (development, reloads on change)
      python agent.py start   (production)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.request
from urllib.parse import urlparse

import httpx
from livekit import rtc
from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli, llm
from livekit.agents.llm import ImageContent
from livekit.agents.types import NOT_GIVEN
from livekit.agents.voice.room_io import RoomOptions

from behavior import BehaviorTracker
from call_config import CallConfig, parse_call_config
from providers import make_avatar, make_llm, make_stt, make_tts

log = logging.getLogger("companion")

# AI companion laws (e.g. New York) require reminding the user they're talking
# to an AI at least every three hours.
DISCLOSURE_INTERVAL_S = 3 * 60 * 60
BEHAVIOR_TOPIC = "behavior"


class Companion(Agent):
    def __init__(self, cfg: CallConfig) -> None:
        super().__init__(instructions=cfg.instructions)
        self.cfg = cfg
        self.behavior = BehaviorTracker()
        self.latest_frame: rtc.VideoFrame | None = None

    async def llm_node(self, chat_ctx: llm.ChatContext, tools: list[llm.Tool], model_settings):
        # Runs before every reply, whether the user spoke, typed, or the
        # character is reacting on its own. The camera note and the newest
        # frame go on the latest user message in a copy of the history, so
        # only the current frame is ever sent and history stays text-only.
        chat_ctx = chat_ctx.copy()
        _strip_images(chat_ctx)
        extra: list = []
        if note := self.behavior.take_note():
            extra.append(note)
        if self.latest_frame is not None:
            extra.append(ImageContent(image=self.latest_frame, inference_width=512, inference_height=512))
        if extra:
            last_user = next((i for i in reversed(chat_ctx.items) if i.type == "message" and i.role == "user"), None)
            if last_user is None:
                chat_ctx.add_message(role="user", content=extra)
            else:
                last_user.content = [*last_user.content, *extra]
        async for chunk in Agent.default.llm_node(self, chat_ctx, tools, model_settings):
            yield chunk


def _strip_images(ctx: llm.ChatContext) -> bool:
    changed = False
    for item in ctx.items:
        if item.type == "message" and any(isinstance(c, ImageContent) for c in item.content):
            item.content = [c for c in item.content if not isinstance(c, ImageContent)]
            changed = True
    return changed


def _is_user(participant: rtc.RemoteParticipant | None) -> bool:
    # The avatar service joins as its own participant; only the human's camera matters.
    return participant is not None and participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD


async def entrypoint(ctx: JobContext) -> None:
    cfg = parse_call_config(ctx.job.metadata)
    await ctx.connect()
    # The website sends the agent in as soon as the room exists; wait for the
    # user's browser to join so the greeting isn't spoken to an empty room.
    await ctx.wait_for_participant(kind=rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD)

    stt, tts = make_stt(cfg), make_tts(cfg)
    voice = stt is not None and tts is not None
    if not voice:
        log.warning("Speech services aren't configured; %s runs as a text-only call.", cfg.name)

    session_kwargs = {"llm": make_llm()}
    if voice:
        from livekit.plugins import silero

        session_kwargs.update(stt=stt, tts=tts, vad=silero.VAD.load())
    session = AgentSession(**session_kwargs)
    companion = Companion(cfg)

    # Keep the latest camera frame from the user; it goes with their next turn.
    frame_tasks: set[asyncio.Task] = set()

    async def read_frames(track: rtc.Track) -> None:
        async for event in rtc.VideoStream(track):
            companion.latest_frame = event.frame

    def on_track(track: rtc.Track, _pub: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant) -> None:
        if track.kind == rtc.TrackKind.KIND_VIDEO and _is_user(participant):
            task = asyncio.create_task(read_frames(track))
            frame_tasks.add(task)
            task.add_done_callback(frame_tasks.discard)

    ctx.room.on("track_subscribed", on_track)
    for participant in ctx.room.remote_participants.values():
        for pub in participant.track_publications.values():
            if pub.track is not None:
                on_track(pub.track, pub, participant)

    # Camera behavior events from the browser's on-device tracking.
    def on_data(packet: rtc.DataPacket) -> None:
        if packet.topic != BEHAVIOR_TOPIC or not _is_user(packet.participant):
            return
        try:
            kind = str(json.loads(packet.data.decode())["kind"])
        except (ValueError, KeyError, UnicodeDecodeError):
            return
        idle = session.agent_state == "listening" and session.user_state != "speaking"
        if instructions := companion.behavior.observe(kind, can_react=idle):
            session.generate_reply(instructions=instructions)

    ctx.room.on("data_received", on_data)

    async def send_transcript() -> None:
        lines = [
            {"role": item.role, "text": item.text_content}
            for item in session.history.items
            if item.type == "message" and item.role in ("user", "assistant") and item.text_content
        ]
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    cfg.callback_url,
                    json={"lines": lines},
                    headers={"authorization": f"Bearer {cfg.callback_token}"},
                )
        except httpx.HTTPError as err:
            log.error("Couldn't send the transcript for %s: %s", cfg.conversation_id, err)

    ctx.add_shutdown_callback(send_transcript)

    if avatar := make_avatar(cfg):
        # The avatar joins the room, takes over the character's audio and
        # publishes a lip-synced video track the browser shows.
        await avatar.start(session, room=ctx.room)

    await session.start(
        agent=companion,
        room=ctx.room,
        room_options=RoomOptions(
            audio_input=voice,
            audio_output=voice and avatar is None,
            text_input=True,
            text_output=True,
            video_input=False,  # camera frames are read above and sent per turn
        ),
    )

    async def remind_ai() -> None:
        while True:
            await asyncio.sleep(DISCLOSURE_INTERVAL_S)
            await session.say("Just a reminder: I'm an AI, not a person. Happy to keep chatting!")

    reminder = asyncio.create_task(remind_ai())

    async def stop_reminder() -> None:
        reminder.cancel()

    ctx.add_shutdown_callback(stop_reminder)

    session.generate_reply(instructions="The call just connected. Greet the user and start the conversation.")


def livekit_proxy():
    """The worker sends its LiveKit connection through HTTPS_PROXY even when
    NO_PROXY lists the LiveKit host; respect NO_PROXY for it."""
    host = urlparse(os.environ.get("LIVEKIT_URL", "")).hostname
    if host and urllib.request.proxy_bypass(host):
        return None
    return NOT_GIVEN


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name="companion", http_proxy=livekit_proxy()))
