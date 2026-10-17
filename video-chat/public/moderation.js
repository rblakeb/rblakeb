// On-device nudity detection for non-adult rooms.
// Runs NSFWJS in the browser on frames of the partner's video and blurs it
// when explicit content is likely. This gives instant protection; server-side
// frame sampling (Hive, Sightengine, Rekognition) should back it up before launch,
// since a modified client can skip this check on its own side.

const NSFWJS_URL = "https://cdn.jsdelivr.net/npm/nsfwjs@4.2.1/+esm";
const CHECK_EVERY_MS = 1500;
// Probability that a frame is explicit before we blur.
const BLUR_THRESHOLD = 0.6;
// Consecutive clean frames required before un-blurring, to avoid flicker.
const CLEAN_FRAMES_TO_UNBLUR = 3;

let modelPromise = null;

function loadModel() {
  modelPromise ??= import(NSFWJS_URL)
    .then((nsfwjs) => nsfwjs.load())
    .catch((err) => {
      console.warn("Nudity detection unavailable:", err);
      modelPromise = null;
      return null;
    });
  return modelPromise;
}

// Start loading early so the first call doesn't wait on it.
export function preloadModeration() {
  loadModel();
}

// Watches `video` until the returned stop() is called. `onChange(flagged)` fires
// when the blur state should change.
export function watchVideo(video, onChange) {
  let stopped = false;
  let flagged = false;
  let cleanStreak = 0;
  const canvas = document.createElement("canvas");
  canvas.width = 224;
  canvas.height = 224;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  async function check() {
    if (stopped) return;
    const model = await loadModel();
    if (stopped) return;
    if (model && video.readyState >= 2 && video.videoWidth > 0) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        const predictions = await model.classify(canvas);
        const score = predictions
          .filter((p) => p.className === "Porn" || p.className === "Hentai")
          .reduce((sum, p) => sum + p.probability, 0);
        if (score >= BLUR_THRESHOLD) {
          cleanStreak = 0;
          if (!flagged) {
            flagged = true;
            onChange(true);
          }
        } else if (flagged && ++cleanStreak >= CLEAN_FRAMES_TO_UNBLUR) {
          flagged = false;
          onChange(false);
        }
      } catch (err) {
        console.warn("Moderation check failed:", err);
      }
    }
    if (!stopped) setTimeout(check, CHECK_EVERY_MS);
  }

  check();
  return () => {
    stopped = true;
  };
}
