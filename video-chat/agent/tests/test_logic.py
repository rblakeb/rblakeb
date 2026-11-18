import json

import pytest

from behavior import BehaviorTracker
from call_config import parse_call_config

CONFIG = {
    "conversationId": "c1",
    "character": "tutor",
    "name": "Lucía",
    "voiceLang": "fr",
    "voiceGender": "female",
    "instructions": "You are Lucía.",
    "callbackUrl": "http://localhost:3000/internal/companions/conversations/c1/transcript",
    "callbackToken": "secret",
}


def test_parses_call_config():
    cfg = parse_call_config(json.dumps(CONFIG))
    assert cfg.name == "Lucía"
    assert cfg.stt_language == "multi"


def test_stt_language_by_character():
    assert parse_call_config(json.dumps({**CONFIG, "voiceLang": "ja"})).stt_language == "ja"
    assert parse_call_config(json.dumps({**CONFIG, "character": "music", "voiceLang": "en"})).stt_language == "en-US"


def test_missing_fields_are_rejected():
    with pytest.raises(ValueError, match="instructions"):
        parse_call_config(json.dumps({**CONFIG, "instructions": ""}))


def test_notes_collect_until_the_next_turn():
    t = BehaviorTracker()
    t.observe("smile", now=0)
    t.observe("smile", now=1)  # repeats collapse
    t.observe("away", now=2)
    assert t.take_note() == "[Camera since you last spoke: the user smiled, then looked away from the screen.]"
    assert t.take_note() is None


def test_waves_get_a_reaction_with_a_cooldown():
    t = BehaviorTracker(cooldown_s=25)
    assert "waved" in t.observe("wave", now=0)
    # Covered by the reaction, so not repeated in the next note.
    assert t.take_note() is None
    assert t.observe("wave", now=10) is None
    assert t.take_note() == "[Camera since you last spoke: the user waved at you.]"
    assert t.observe("thumbs_up", now=30) is not None


def test_no_reaction_while_the_character_is_busy():
    t = BehaviorTracker()
    assert t.observe("wave", now=0, can_react=False) is None
    assert "waved" in t.take_note()


def test_unknown_events_are_ignored():
    t = BehaviorTracker()
    assert t.observe("<script>", now=0) is None
    assert t.take_note() is None


def test_livekit_connection_respects_no_proxy(monkeypatch):
    import agent
    from livekit.agents.types import NOT_GIVEN

    monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1")
    monkeypatch.setenv("LIVEKIT_URL", "ws://localhost:7880")
    assert agent.livekit_proxy() is None
    monkeypatch.setenv("LIVEKIT_URL", "wss://example.livekit.cloud")
    assert agent.livekit_proxy() is NOT_GIVEN
