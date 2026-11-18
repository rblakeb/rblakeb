#!/usr/bin/env bash
# Downloads the camera-tracking models so the site serves them itself instead
# of browsers fetching them from Google. Run once: npm run models
set -euo pipefail
cd "$(dirname "$0")/../public"
mkdir -p models
curl -fsSL -o models/face_landmarker.task https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
curl -fsSL -o models/gesture_recognizer.task https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task
ls -lh models
