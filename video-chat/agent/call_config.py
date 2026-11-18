"""What the website tells the agent about a call, sent as the dispatch metadata.

The website owns the characters (personas, rules, memory), billing and
accounts; the agent only runs the live conversation. Keeping the persona text
on the website side means there's one source of truth for each character.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

# Deepgram recognition language per companion language. The tutor uses
# Deepgram's multilingual mode so learners can mix English into their practice;
# Japanese isn't covered by that mode, so it gets its own model.
STT_LANGUAGE = {"es": "multi", "fr": "multi", "de": "multi", "it": "multi", "pt": "multi", "ja": "ja", "en": "en-US"}


@dataclass(frozen=True)
class CallConfig:
    conversation_id: str
    character: str
    name: str
    voice_lang: str
    voice_gender: str
    instructions: str
    # Where to send the transcript when the call ends, and the one-call token for it.
    callback_url: str
    callback_token: str

    @property
    def stt_language(self) -> str:
        if self.character != "tutor":
            return "en-US"
        return STT_LANGUAGE.get(self.voice_lang, "multi")


def parse_call_config(metadata: str) -> CallConfig:
    data = json.loads(metadata)
    required = ["conversationId", "character", "name", "voiceLang", "voiceGender", "instructions", "callbackUrl", "callbackToken"]
    missing = [key for key in required if not data.get(key)]
    if missing:
        raise ValueError(f"call metadata is missing {', '.join(missing)}")
    return CallConfig(
        conversation_id=data["conversationId"],
        character=data["character"],
        name=data["name"],
        voice_lang=data["voiceLang"],
        voice_gender=data["voiceGender"],
        instructions=data["instructions"],
        callback_url=data["callbackUrl"],
        callback_token=data["callbackToken"],
    )
