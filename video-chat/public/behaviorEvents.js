// Turns per-frame camera readings (is a face visible, how much is the user
// smiling, which way are they facing, is a hand gesture showing) into a few
// meaningful events for the AI character: "smile", "laugh", "wave",
// "thumbs_up", "away", "back", "left" and "returned".
//
// Each event needs the reading to hold for a moment, so a flicker doesn't
// count, and then needs to clear before it can fire again.

const RULES = {
  smileOn: 0.6, // blendshape score, 0..1
  smileOff: 0.3,
  smileHoldMs: 500,
  laughJaw: 0.45,
  gestureHoldMs: 400,
  gestureRearmMs: 3000,
  awayYawDeg: 30,
  backYawDeg: 15,
  awayHoldMs: 3000,
  backHoldMs: 1000,
  leftHoldMs: 5000,
  returnedHoldMs: 1000,
};

export class BehaviorDetector {
  constructor(onEvent, rules = RULES) {
    this.onEvent = onEvent;
    this.r = rules;
    this.since = {}; // when each condition started holding
    this.armed = { smile: true, wave: true, thumbs_up: true };
    this.lastGesture = { wave: -Infinity, thumbs_up: -Infinity };
    this.away = false;
    this.left = false;
  }

  // True once `key`'s condition has held for `ms`; resets when it stops holding.
  held(key, condition, t, ms) {
    if (!condition) {
      delete this.since[key];
      return false;
    }
    this.since[key] ??= t;
    return t - this.since[key] >= ms;
  }

  // frame: { t (ms), faceVisible, smile, jawOpen, yawDeg, gesture: "Open_Palm" | "Thumb_Up" | null }
  update(frame) {
    const { t, faceVisible } = frame;
    const r = this.r;

    // In and out of view.
    if (!this.left && this.held("gone", !faceVisible, t, r.leftHoldMs)) {
      this.left = true;
      this.emit("left");
    } else if (this.left && this.held("seen", faceVisible, t, r.returnedHoldMs)) {
      this.left = false;
      this.away = false;
      this.emit("returned");
    }
    if (!faceVisible) return;

    // Looking away and back.
    const yaw = Math.abs(frame.yawDeg ?? 0);
    if (!this.away && this.held("turned", yaw > r.awayYawDeg, t, r.awayHoldMs)) {
      this.away = true;
      this.emit("away");
    } else if (this.away && this.held("facing", yaw < r.backYawDeg, t, r.backHoldMs)) {
      this.away = false;
      this.emit("back");
    }

    // Smiles and laughs; a laugh is a smile with an open mouth.
    const smiling = (frame.smile ?? 0) >= r.smileOn;
    if (this.armed.smile && this.held("smiling", smiling, t, r.smileHoldMs)) {
      this.armed.smile = false;
      this.emit((frame.jawOpen ?? 0) >= r.laughJaw ? "laugh" : "smile");
    } else if (!this.armed.smile && this.held("unsmiling", (frame.smile ?? 0) < r.smileOff, t, 1000)) {
      this.armed.smile = true;
    }

    // Hand gestures.
    for (const [event, gesture] of [["wave", "Open_Palm"], ["thumbs_up", "Thumb_Up"]]) {
      const showing = frame.gesture === gesture;
      if (showing) this.lastGesture[event] = t;
      if (this.armed[event] && this.held(event, showing, t, r.gestureHoldMs)) {
        this.armed[event] = false;
        this.emit(event);
      } else if (!this.armed[event] && t - this.lastGesture[event] >= r.gestureRearmMs) {
        this.armed[event] = true;
      }
    }
  }

  emit(kind) {
    this.onEvent(kind);
  }
}

// Head turn left/right in degrees, from MediaPipe's 4x4 facial transformation
// matrix (column-major). 0 means facing the camera.
export function yawFromMatrix(data) {
  return (Math.atan2(data[8], data[10]) * 180) / Math.PI;
}
