import { Avatar } from "./avatar.js";
import { pickVoice } from "./voices.js";

const $ = (id) => document.getElementById(id);

// Which kind of voice fits each character's face.
const VOICE_GENDER = { tutor: "female", music: "male" };

// Browser speech codes for each language the companions support.
const SPEECH_LANG = { es: "es-ES", fr: "fr-FR", de: "de-DE", it: "it-IT", pt: "pt-BR", ja: "ja-JP", en: "en-US" };

const state = {
  token: null,
  conversationId: null,
  character: null,
  voiceLang: "en",
  avatar: null,
  stream: null,
  cameraOn: true,
  // The user wants hands-free listening; recognition pauses while the character talks.
  listening: false,
  recognition: null,
  busy: false,
};

// ---------- Session ----------

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res;
}

// Reuses the main site's account if there is one; otherwise starts a guest session.
async function ensureSession() {
  try {
    state.token = localStorage.getItem("token");
  } catch {}
  if (state.token) {
    try {
      await api("/api/me");
      return;
    } catch {
      state.token = null;
    }
  }
  const data = await (await api("/api/session", { displayName: "Guest" })).json();
  state.token = data.token;
  try {
    localStorage.setItem("token", data.token);
  } catch {}
}

// ---------- Picker ----------

async function initPicker() {
  const { languages } = await (await api("/api/companions")).json();
  $("tutor-language").innerHTML = Object.entries(languages)
    .filter(([code]) => code !== "en")
    .map(([code, name]) => `<option value="${code}">${name}</option>`)
    .join("");
  for (const btn of document.querySelectorAll(".start-call")) {
    btn.onclick = () => startCall(btn.dataset.character).catch(showPickerError);
  }
}

function showPickerError(err) {
  $("picker-status").textContent =
    err.name === "NotAllowedError" ? "Camera and microphone access is needed for a call." : `Couldn't start the call: ${err.message}`;
}

// ---------- Call ----------

async function startCall(character) {
  await ensureSession();
  const language = $("tutor-language").value;
  const started = await (await api(`/api/companions/${character}/start`, { language })).json();
  state.conversationId = started.conversationId;
  state.character = character;
  state.voiceLang = started.voiceLang;

  // The microphone track is only used for the level meter; speech recognition
  // opens the mic itself. Nothing from the mic is sent to the server.
  state.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  $("local").srcObject = state.stream;
  startMicMeter(state.stream);

  $("picker").hidden = true;
  $("call").hidden = false;
  $("messages").innerHTML = "";
  $("partner-info").textContent = started.name;
  state.avatar = new Avatar($("avatar"), character);
  setupRecognition();
  setStatus("Say hello, or type below");

  // The character opens the conversation.
  await sendTurn("(The call just connected. Greet the user and start the conversation.)", { silentUser: true });
}

function hangUp() {
  state.listening = false;
  stopMicMeter();
  state.recognition?.abort();
  speechSynthesis?.cancel();
  state.avatar?.stop();
  for (const track of state.stream?.getTracks() ?? []) track.stop();
  state.stream = null;
  $("local").srcObject = null;
  $("call").hidden = true;
  $("picker").hidden = false;
  updateMicButton();
}

function setStatus(text) {
  $("call-status").textContent = text;
}

// A still from the user's camera, small enough to send with every turn.
function captureFrame() {
  const video = $("local");
  if (!state.cameraOn || !video.videoWidth) return undefined;
  const scale = Math.min(1, 512 / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
}

async function sendTurn(text, { silentUser = false } = {}) {
  if (state.busy || !state.conversationId) return;
  state.busy = true;
  pauseRecognition();
  if (!silentUser) addMessage("me", text);
  setStatus("Thinking…");

  const bubble = addMessage("them", "");
  const speaker = new Speaker(state.voiceLang, VOICE_GENDER[state.character], state.avatar, () => {
    setStatus(state.listening ? "Listening…" : "Your turn");
    state.busy = false;
    resumeRecognition();
  });

  try {
    const res = await api(`/api/companions/conversations/${state.conversationId}/turn`, { text, frame: captureFrame() });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const line = buffer.slice(0, split).replace(/^data: /, "");
        buffer = buffer.slice(split + 2);
        const event = JSON.parse(line);
        if (event.type === "text") {
          bubble.textContent += event.text;
          $("messages").scrollTop = $("messages").scrollHeight;
          speaker.add(event.text);
        } else if (event.type === "error") {
          bubble.textContent = "(Something went wrong. Try again.)";
        }
      }
    }
  } catch (err) {
    bubble.textContent = err.status === 409 ? "(Still answering your last message.)" : "(Couldn't reach the server. Try again.)";
  }
  speaker.finish();
}

// ---------- Speaking ----------

// Voices the reply sentence by sentence as it streams in, and drives the avatar's mouth.
class Speaker {
  constructor(lang, gender, avatar, onDone) {
    this.lang = SPEECH_LANG[lang] ?? "en-US";
    this.gender = gender;
    this.avatar = avatar;
    this.onDone = onDone;
    this.pending = 0;
    this.buffer = "";
    this.finished = false;
  }

  add(text) {
    this.buffer += text;
    // Speak each complete sentence as soon as it arrives.
    let match;
    while ((match = this.buffer.match(/^[\s\S]*?[.!?…。](\s|$)/)) && match[0].trim()) {
      this.speak(match[0].trim());
      this.buffer = this.buffer.slice(match[0].length);
    }
  }

  finish() {
    if (this.buffer.trim()) this.speak(this.buffer.trim());
    this.buffer = "";
    this.finished = true;
    this.checkDone();
  }

  speak(sentence) {
    this.pending++;
    let ended = false;
    const done = () => {
      if (ended) return;
      ended = true;
      clearTimeout(safety);
      this.pending--;
      if (this.pending === 0) this.avatar.setSpeaking(false);
      this.checkDone();
    };
    // Roughly how long the sentence takes to say. Without a voice the avatar
    // just mouths it for that long; with one, it's a backstop in case the
    // browser never reports the end of the utterance.
    const estimateMs = 600 + sentence.split(/\s+/).length * 330;
    // Picked per sentence because browsers load their voice list asynchronously.
    const { voice, pitch } = "speechSynthesis" in window ? pickVoice(speechSynthesis.getVoices(), this.lang, this.gender) : {};
    const canSpeak = !!voice;
    const safety = setTimeout(done, canSpeak ? estimateMs * 2 + 2000 : estimateMs);
    this.avatar.setSpeaking(true);
    setStatus("Speaking…");
    if (canSpeak) {
      const utterance = new SpeechSynthesisUtterance(sentence);
      utterance.voice = voice;
      utterance.pitch = pitch;
      utterance.lang = this.lang;
      utterance.onboundary = () => this.avatar.wordBoundary();
      utterance.onend = done;
      utterance.onerror = done;
      speechSynthesis.speak(utterance);
    }
  }

  checkDone() {
    if (this.finished && this.pending === 0 && this.onDone) {
      const cb = this.onDone;
      this.onDone = null;
      cb();
    }
  }
}

// Chrome loads voices asynchronously.
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();

// ---------- Listening ----------

function setupRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    $("mic").disabled = true;
    $("mic-note").textContent = "This browser can't do speech recognition. Type instead, or use Chrome or Edge.";
    state.recognition = null;
    return;
  }
  const recognition = new Recognition();
  recognition.lang = SPEECH_LANG[state.voiceLang] ?? "en-US";
  recognition.continuous = true;
  recognition.interimResults = true;
  let finalText = "";
  let sendTimer = null;
  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) finalText += result[0].transcript + " ";
      else interim += result[0].transcript;
    }
    if (interim) setStatus(`“${interim}”`);
    // Send once the user pauses briefly after a finished phrase.
    clearTimeout(sendTimer);
    if (finalText.trim()) {
      sendTimer = setTimeout(() => {
        const text = finalText.trim();
        finalText = "";
        sendTurn(text);
      }, 700);
    }
  };
  recognition.onerror = (event) => {
    const problems = {
      "not-allowed": "Microphone access is blocked. Allow it from the icon in your browser's address bar, then tap Start talking again.",
      "service-not-allowed": "Microphone access is blocked. Allow it from the icon in your browser's address bar, then tap Start talking again.",
      "audio-capture": "No microphone was found. Check that one is plugged in and selected in your system settings.",
      network: "Speech recognition needs an internet connection (the browser sends your speech to its own service to transcribe).",
    };
    const message = problems[event.error];
    if (!message) return; // "no-speech" and "aborted" are normal; recognition just restarts.
    $("mic-note").textContent = message;
    if (event.error !== "network") {
      state.listening = false;
      updateMicButton();
    }
  };
  // Chrome ends recognition after silence; keep it going while the user wants to talk.
  recognition.onend = () => {
    if (state.listening && !state.busy) {
      try {
        recognition.start();
      } catch {}
    }
  };
  state.recognition = recognition;
  const langName = $("tutor-language").selectedOptions[0]?.textContent;
  $("mic-note").textContent =
    state.character === "tutor" ? `Speech recognition is listening for ${langName}.` : "Speech recognition is listening for English.";
}

function pauseRecognition() {
  try {
    state.recognition?.stop();
  } catch {}
}

function resumeRecognition() {
  if (!state.listening || !state.recognition) return;
  try {
    state.recognition.start();
  } catch {}
}

function updateMicButton() {
  $("mic").textContent = state.listening ? "🎤 Listening (tap to mute)" : "🎤 Start talking";
}

$("mic").onclick = () => {
  state.listening = !state.listening;
  updateMicButton();
  if (state.listening) {
    if (!state.busy) setStatus("Listening…");
    resumeRecognition();
  } else {
    pauseRecognition();
    if (!state.busy) setStatus("Your turn");
  }
};

// A live level bar under the mic button, so the user can see they're being heard.
let meter = null;

function startMicMeter(stream) {
  stopMicMeter();
  if (!stream.getAudioTracks().length || !window.AudioContext) return;
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  meter = { context, running: true };
  const tick = () => {
    if (!meter?.running) return;
    analyser.getByteTimeDomainData(samples);
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s - 128));
    $("mic-level-fill").style.width = `${Math.min(100, (peak / 128) * 250)}%`;
    requestAnimationFrame(tick);
  };
  tick();
}

function stopMicMeter() {
  if (!meter) return;
  meter.running = false;
  meter.context.close().catch(() => {});
  meter = null;
  $("mic-level-fill").style.width = "0";
}

// ---------- Other controls ----------

$("camera").onclick = () => {
  state.cameraOn = !state.cameraOn;
  for (const track of state.stream?.getVideoTracks() ?? []) track.enabled = state.cameraOn;
  $("camera").textContent = state.cameraOn ? "Camera on" : "Camera off";
};

$("hangup").onclick = hangUp;

$("chat-form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("chat-input").value.trim();
  if (!text) return;
  $("chat-input").value = "";
  sendTurn(text);
};

function addMessage(kind, text) {
  const div = document.createElement("div");
  div.className = kind;
  div.textContent = text;
  $("messages").appendChild(div);
  $("messages").scrollTop = $("messages").scrollHeight;
  return div;
}

initPicker().catch((err) => ($("picker-status").textContent = `Couldn't load: ${err.message}`));
