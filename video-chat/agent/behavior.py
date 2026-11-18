"""Turns camera behavior events from the browser into context for the character.

The browser runs face and hand tracking on the user's own device and sends
short events ("smile", "wave", "away", "back"). Most just become a note the
character sees with the user's next words; a few are worth reacting to
unprompted, like a friend would when you wave at them.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

# How each event reads to the character.
NOTES = {
    "smile": "smiled",
    "laugh": "laughed",
    "wave": "waved at you",
    "thumbs_up": "gave a thumbs up",
    "away": "looked away from the screen",
    "back": "looked back at the screen",
    "left": "left the camera's view",
    "returned": "came back into view",
}

# Events the character reacts to right away, and what it's told.
REACTIONS = {
    "wave": "The user just waved at you on camera. React briefly and naturally, in one short sentence.",
    "thumbs_up": "The user just gave you a thumbs up on camera. Acknowledge it briefly, in one short sentence.",
    "returned": "The user just came back into view after stepping away. Welcome them back briefly and pick up where you left off.",
}

# Don't react unprompted more often than this, so the character doesn't nag.
REACTION_COOLDOWN_S = 25.0


@dataclass
class BehaviorTracker:
    cooldown_s: float = REACTION_COOLDOWN_S
    _pending: list[str] = field(default_factory=list)
    _last_reaction_at: float = float("-inf")

    def observe(self, kind: str, *, now: float | None = None, can_react: bool = True) -> str | None:
        """Records an event. Returns instructions for an unprompted reaction, if one is due."""
        note = NOTES.get(kind)
        if note is None:
            return None
        if not self._pending or self._pending[-1] != note:
            self._pending.append(note)
        self._pending = self._pending[-6:]
        now = time.monotonic() if now is None else now
        reaction = REACTIONS.get(kind)
        if reaction and can_react and now - self._last_reaction_at >= self.cooldown_s:
            self._last_reaction_at = now
            # The reaction covers this event; don't repeat it in the next note.
            self._pending.remove(note)
            return reaction
        return None

    def take_note(self) -> str | None:
        """The camera note to attach to the user's next turn, if anything happened."""
        if not self._pending:
            return None
        note = "[Camera since you last spoke: the user " + ", then ".join(self._pending) + ".]"
        self._pending.clear()
        return note
