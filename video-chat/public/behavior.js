// Watches the user's camera on their own device with Google's MediaPipe (face
// expressions, head direction, hand gestures) and reports behavior events.
// Only the events leave the device, never the video, for this part.

import { BehaviorDetector, yawFromMatrix } from "./behaviorEvents.js";

const BUNDLE = "/vendor/mediapipe/vision_bundle.mjs";
const WASM = "/vendor/mediapipe/wasm";
// Served from this site when `npm run models` has downloaded them, otherwise from Google.
const MODELS = {
  face: ["/models/face_landmarker.task", "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"],
  gesture: ["/models/gesture_recognizer.task", "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"],
};
const FRAMES_PER_SECOND = 6;

async function firstAvailable(urls) {
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (res.ok) return url;
    } catch {}
  }
  return urls.at(-1);
}

// Starts watching `video`; calls onEvent(kind) for each behavior event.
// Returns a stop function. Fails quietly (no events) if tracking can't load.
export async function watchBehavior(video, onEvent) {
  let stopped = false;
  let timer = null;
  try {
    const { FilesetResolver, FaceLandmarker, GestureRecognizer } = await import(BUNDLE);
    const fileset = await FilesetResolver.forVisionTasks(WASM);
    const [faceModel, gestureModel] = await Promise.all([firstAvailable(MODELS.face), firstAvailable(MODELS.gesture)]);
    const [face, gestures] = await Promise.all([
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: faceModel },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      }),
      GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: gestureModel },
        runningMode: "VIDEO",
        numHands: 1,
      }),
    ]);
    if (stopped) return () => {};

    const detector = new BehaviorDetector(onEvent);
    const tick = () => {
      if (stopped) return;
      if (video.readyState >= 2 && video.videoWidth) {
        const t = performance.now();
        const faces = face.detectForVideo(video, t);
        const hands = gestures.recognizeForVideo(video, t);
        const shapes = Object.fromEntries((faces.faceBlendshapes[0]?.categories ?? []).map((c) => [c.categoryName, c.score]));
        const matrix = faces.facialTransformationMatrixes[0]?.data;
        detector.update({
          t,
          faceVisible: faces.faceLandmarks.length > 0,
          smile: ((shapes.mouthSmileLeft ?? 0) + (shapes.mouthSmileRight ?? 0)) / 2,
          jawOpen: shapes.jawOpen ?? 0,
          yawDeg: matrix ? yawFromMatrix(matrix) : 0,
          gesture: hands.gestures[0]?.[0]?.categoryName ?? null,
        });
      }
      timer = setTimeout(tick, 1000 / FRAMES_PER_SECOND);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      face.close();
      gestures.close();
    };
  } catch (err) {
    console.warn("Camera behavior tracking unavailable:", err);
    return () => {
      stopped = true;
    };
  }
}
