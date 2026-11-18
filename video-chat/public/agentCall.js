// The browser side of a call run by the voice agent: joins the LiveKit room,
// sends the user's camera, mic, typed messages and behavior events, and
// receives the character's voice, live transcripts, state and (with a
// realistic avatar service) its video.

const LIVEKIT = "/vendor/livekit-client.esm.mjs";

export async function joinAgentCall({ url, token, stream, onTranscript, onState, onAvatarVideo, onAgentAudio, onDisconnected }) {
  const { Room, RoomEvent, Track } = await import(LIVEKIT);
  const room = new Room({ adaptiveStream: true, stopLocalTrackOnUnpublish: false });

  // Transcripts arrive as text streams; each segment updates as the words come in.
  let micTrackSid = null;
  room.registerTextStreamHandler("lk.transcription", async (reader) => {
    const attrs = reader.info.attributes ?? {};
    const segment = attrs["lk.segment_id"] ?? reader.info.id;
    const fromUser = !!micTrackSid && attrs["lk.transcribed_track_id"] === micTrackSid;
    let text = "";
    for await (const chunk of reader) {
      text += chunk;
      onTranscript({ segment, fromUser, text, final: false });
    }
    onTranscript({ segment, fromUser, text, final: attrs["lk.transcription_final"] !== "false" });
  });

  room.on(RoomEvent.ParticipantAttributesChanged, (changed) => {
    if (changed["lk.agent.state"]) onState(changed["lk.agent.state"]);
  });

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      el.hidden = true;
      document.body.appendChild(el);
      onAgentAudio?.(track.mediaStreamTrack);
    } else if (track.kind === Track.Kind.Video) {
      // Only an avatar service publishes video; the agent itself has none.
      onAvatarVideo(track);
    }
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    for (const el of track.detach()) el.remove();
  });
  room.on(RoomEvent.Disconnected, () => onDisconnected?.());

  await room.connect(url, token);
  const [audioTrack] = stream.getAudioTracks();
  const [videoTrack] = stream.getVideoTracks();
  if (audioTrack) {
    const pub = await room.localParticipant.publishTrack(audioTrack, { source: Track.Source.Microphone });
    micTrackSid = pub.trackSid;
  }
  if (videoTrack) await room.localParticipant.publishTrack(videoTrack, { source: Track.Source.Camera });

  return {
    sendText(text) {
      return room.localParticipant.sendText(text, { topic: "lk.chat" });
    },
    sendBehavior(kind) {
      return room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ kind })), { reliable: true, topic: "behavior" });
    },
    setMicEnabled(enabled) {
      if (audioTrack) audioTrack.enabled = enabled;
    },
    setCameraEnabled(enabled) {
      if (videoTrack) videoTrack.enabled = enabled;
    },
    leave() {
      return room.disconnect(false);
    },
  };
}
