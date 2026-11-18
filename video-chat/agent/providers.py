"""Picks the speech, voice, language-model and avatar services for a call from
environment settings, so services can be swapped without code changes.

Anything without credentials is left out: no speech keys means a text-only
call, no Anthropic key means a canned test model, no avatar means the browser
draws its animated face instead.
"""

from __future__ import annotations

import logging
import os
import uuid
from typing import Any

from livekit.agents import APIConnectOptions, llm
from livekit.agents.llm import ChatChunk, ChatContext, ChoiceDelta, ImageContent
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, NOT_GIVEN, NotGivenOr

from call_config import CallConfig

log = logging.getLogger("companion.providers")


def env(name: str) -> str | None:
    return os.environ.get(name) or None


# ---------- Language model ----------


def make_llm() -> llm.LLM:
    if env("ANTHROPIC_API_KEY"):
        return claude_llm()
    log.warning("No ANTHROPIC_API_KEY: characters answer with canned test replies.")
    return TestModeLLM()


def claude_llm() -> llm.LLM:
    from livekit.plugins import anthropic

    class ClaudeLLM(anthropic.LLM):
        # Same settings as the website's companions: low effort keeps spoken
        # replies quick, and a declined turn is retried on a fallback model
        # instead of the character going silent.
        def chat(self, *, extra_kwargs: NotGivenOr[dict[str, Any]] = NOT_GIVEN, **kwargs: Any) -> llm.LLMStream:
            extra: dict[str, Any] = {
                "output_config": {"effort": "low"},
                "extra_headers": {"anthropic-beta": "server-side-fallback-2026-07-01"},
                "extra_body": {"fallbacks": "default"},
            }
            if extra_kwargs:
                extra.update(extra_kwargs)
            return super().chat(extra_kwargs=extra, **kwargs)

    return ClaudeLLM(model="claude-opus-5-5", max_tokens=1000, caching="ephemeral")


class TestModeLLM(llm.LLM):
    """Answers without any API, echoing what it received, so the whole call
    (joining, camera frames, behavior events, transcripts) can be tested."""

    @property
    def model(self) -> str:
        return "test-mode"

    def chat(
        self,
        *,
        chat_ctx: ChatContext,
        tools: list[llm.Tool] | None = None,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
        **_: Any,
    ) -> llm.LLMStream:
        return _TestModeStream(self, chat_ctx=chat_ctx, tools=tools or [], conn_options=conn_options)


class _TestModeStream(llm.LLMStream):
    async def _run(self) -> None:
        last = next((m for m in reversed(self._chat_ctx.items) if m.type == "message" and m.role != "assistant"), None)
        heard = ""
        saw_frame = False
        if last is not None:
            heard = " ".join(c for c in last.content if isinstance(c, str))
            saw_frame = any(isinstance(c, ImageContent) for c in last.content)
        if last is not None and last.role == "user":
            reply = f"Test mode. I heard: {heard[:200]}."
        else:
            reply = f"Test mode. I was told: {heard[:200]}"
        if saw_frame:
            reply += " I got a picture from your camera too."
        self._event_ch.send_nowait(
            ChatChunk(id=str(uuid.uuid4()), delta=ChoiceDelta(role="assistant", content=reply))
        )


# ---------- Speech ----------


def make_stt(cfg: CallConfig):
    if not env("DEEPGRAM_API_KEY"):
        return None
    from livekit.plugins import deepgram

    return deepgram.STT(model="nova-3", language=cfg.stt_language)


def make_tts(cfg: CallConfig):
    """The character's voice. Voice IDs come from settings per character,
    e.g. CARTESIA_VOICE_TUTOR, because each provider has its own catalog."""
    voice_setting = f"_VOICE_{cfg.character.upper()}"
    if env("CARTESIA_API_KEY"):
        from livekit.plugins import cartesia

        voice = env("CARTESIA" + voice_setting)
        if not voice:
            log.warning("CARTESIA%s isn't set; using Cartesia's default voice for %s.", voice_setting, cfg.name)
        return cartesia.TTS(model="sonic-3", language=cfg.voice_lang, **({"voice": voice} if voice else {}))
    if env("ELEVEN_API_KEY"):
        from livekit.plugins import elevenlabs

        voice = env("ELEVENLABS" + voice_setting)
        if not voice:
            log.warning("ELEVENLABS%s isn't set; using ElevenLabs' default voice for %s.", voice_setting, cfg.name)
        return elevenlabs.TTS(model="eleven_flash_v2_5", **({"voice_id": voice} if voice else {}))
    return None


# ---------- Realistic avatar ----------


def make_avatar(cfg: CallConfig):
    """A photorealistic avatar service that joins the call and lip-syncs to
    the character's voice. Set AVATAR_PROVIDER and the character's avatar ID,
    e.g. AVATAR_ID_TUTOR. Returns None to fall back to the browser's drawn face."""
    provider = (env("AVATAR_PROVIDER") or "").lower()
    if not provider:
        return None
    avatar_id = env(f"AVATAR_ID_{cfg.character.upper()}")
    if not avatar_id:
        log.warning("AVATAR_PROVIDER is %s but AVATAR_ID_%s isn't set; no avatar for %s.", provider, cfg.character.upper(), cfg.name)
        return None
    identity = f"avatar-{cfg.conversation_id}"
    common = {"avatar_participant_identity": identity, "avatar_participant_name": cfg.name}
    if provider == "tavus":
        from livekit.plugins import tavus

        return tavus.AvatarSession(replica_id=avatar_id, **({"persona_id": p} if (p := env("TAVUS_PERSONA_ID")) else {}), **common)
    if provider == "simli":
        from livekit.plugins import simli

        return simli.AvatarSession(simli_config=simli.SimliConfig(api_key=env("SIMLI_API_KEY") or "", face_id=avatar_id), **common)
    if provider == "anam":
        from livekit.plugins import anam

        return anam.AvatarSession(persona_config=anam.PersonaConfig(name=cfg.name, avatarId=avatar_id), **common)
    if provider == "bey":
        from livekit.plugins import bey

        return bey.AvatarSession(avatar_id=avatar_id, **common)
    log.warning("Unknown AVATAR_PROVIDER %r; no avatar.", provider)
    return None
