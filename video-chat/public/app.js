import { preloadModeration, watchVideo } from "./moderation.js";

const $ = (id) => document.getElementById(id);

const state = {
  token: null,
  account: null,
  config: null,
  selectedIntent: "chat",
  activeIntent: null,
  ws: null,
  pc: null,
  localStream: null,
  pendingCandidates: [],
  stopModeration: null,
  counts: {},
};

// ---------- API ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.body ? "POST" : options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : options.method === "POST" ? "{}" : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status, data });
  return data;
}

function saveToken(token) {
  state.token = token;
  try {
    localStorage.setItem("token", token);
  } catch {}
}

function loadToken() {
  try {
    return localStorage.getItem("token");
  } catch {
    return null;
  }
}

// ---------- Views ----------

function show(view) {
  for (const id of ["welcome", "lobby", "call"]) $(id).hidden = id !== view;
}

function renderAccount() {
  const a = state.account;
  if (!a) {
    $("account").innerHTML = "";
    return;
  }
  const badge = a.adult.verified ? `<span class="badge ok">18+ verified</span>` : "";
  $("account").innerHTML = `<span>${escapeHtml(a.user.displayName)}</span>${badge}`;
}

function adultStatus() {
  const access = state.account?.access?.adult;
  const price = `$${(state.config.pricing.dayPassCents / 100).toFixed(2)}`;
  if (access === null) {
    return state.account.adult.free ? "Free for you" : `Day pass active until ${formatTime(state.account.user.adultPassExpiresAt)}`;
  }
  if (access === "not_verified") return "Verify your age to enter";
  if (access === "payment_required") return `${price} / ${state.config.pricing.dayPassHours}h day pass`;
  return "Unavailable";
}

function renderIntents() {
  const el = $("intents");
  el.innerHTML = "";
  for (const intent of state.config.intents) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `intent${intent.adult ? " adult" : ""}${state.selectedIntent === intent.id ? " selected" : ""}`;
    const waiting = state.counts[intent.id] ?? 0;
    btn.innerHTML = `
      <span class="title">${escapeHtml(intent.label)}</span>
      <span class="desc">${escapeHtml(intent.description)}</span>
      <span class="meta">${waiting} waiting</span>
      ${intent.adult ? `<span class="cta">${escapeHtml(adultStatus())}</span>` : ""}`;
    btn.onclick = () => {
      state.selectedIntent = intent.id;
      renderIntents();
      updateStartButton();
    };
    el.appendChild(btn);
  }
}

function updateStartButton() {
  const access = state.account?.access?.[state.selectedIntent];
  const btn = $("start");
  btn.disabled = false;
  $("lobby-status").textContent = "";
  if (access === "not_verified") btn.textContent = "Verify my age";
  else if (access === "payment_required") btn.textContent = `Buy day pass ($${(state.config.pricing.dayPassCents / 100).toFixed(2)})`;
  else if (access === "banned") {
    btn.textContent = "Account suspended";
    btn.disabled = true;
  } else btn.textContent = "Start";
}

// ---------- Session ----------

async function refreshAccount() {
  state.account = await api("/api/me");
  renderAccount();
  renderIntents();
  updateStartButton();
}

async function init() {
  state.config = await api("/api/config");
  const token = loadToken();
  if (token) {
    state.token = token;
    try {
      await refreshAccount();
      enterLobby();
      return;
    } catch {
      state.token = null;
    }
  }
  show("welcome");
}

$("welcome-form").onsubmit = async (e) => {
  e.preventDefault();
  const data = await api("/api/session", { body: { displayName: $("display-name").value } });
  saveToken(data.token);
  state.account = data;
  renderAccount();
  enterLobby();
};

function enterLobby() {
  show("lobby");
  renderIntents();
  updateStartButton();
  connectSocket();
  preloadModeration();
}

// Returning from the vendor / checkout pages lands back here.
window.addEventListener("focus", () => {
  if (state.token && !$("lobby").hidden) refreshAccount().catch(() => {});
});

$("start").onclick = async () => {
  const access = state.account?.access?.[state.selectedIntent];
  try {
    if (access === "not_verified") {
      const { url } = await api("/api/verification/start", { method: "POST" });
      location.href = url;
      return;
    }
    if (access === "payment_required") {
      const { url } = await api("/api/billing/day-pass", { method: "POST" });
      location.href = url;
      return;
    }
    await startCamera();
    state.activeIntent = state.selectedIntent;
    show("call");
    $("messages").innerHTML = "";
    joinQueue();
  } catch (err) {
    $("lobby-status").textContent = err.name === "NotAllowedError" ? "Camera and microphone access is needed to chat." : `Something went wrong: ${err.message}`;
  }
};

// ---------- Socket ----------

function connectSocket() {
  if (state.ws && state.ws.readyState <= 1) return;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: state.token }));
  ws.onmessage = (e) => onSocketMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (state.ws === ws) setTimeout(connectSocket, 2000);
  };
}

function wsSend(msg) {
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(msg));
}

function joinQueue() {
  closePeer();
  setOverlay("Looking for someone…");
  const language = $("language").value;
  wsSend({
    type: "join",
    intent: state.activeIntent,
    languages: language ? [language] : [],
    tags: $("tags").value.split(",").map((t) => t.trim()).filter(Boolean),
  });
}

async function onSocketMessage(msg) {
  switch (msg.type) {
    case "ready":
      // Reconnected mid-session: get back in line.
      if (!$("call").hidden && state.activeIntent) joinQueue();
      break;
    case "counts":
      state.counts = msg.counts;
      if (!$("lobby").hidden) renderIntents();
      break;
    case "queued":
      setOverlay("Looking for someone…");
      break;
    case "denied":
      closePeer();
      state.activeIntent = null;
      await refreshAccount().catch(() => {});
      enterLobby();
      $("lobby-status").textContent =
        msg.reason === "payment_required" ? "Your day pass has expired." : msg.reason === "not_verified" ? "Age verification is required for this room." : "You can't join this room.";
      break;
    case "matched":
      await startPeer(msg.initiator);
      $("partner-info").textContent = msg.partner.displayName + (msg.sharedTags.length ? ` · ${msg.sharedTags.join(", ")}` : "");
      addMessage("sys", `Connected with ${msg.partner.displayName}`);
      break;
    case "signal":
      await onSignal(msg.data);
      break;
    case "partner_left":
      addMessage("sys", "They left. Finding someone new…");
      joinQueue();
      break;
    case "chat":
      addMessage("them", msg.text);
      break;
    case "error":
      if (msg.error === "banned") {
        closePeer();
        state.activeIntent = null;
        show("lobby");
        $("start").disabled = true;
        $("lobby-status").textContent = "Your account has been suspended after multiple reports.";
      } else if (msg.error === "unauthorized") {
        try {
          localStorage.removeItem("token");
        } catch {}
        location.reload();
      }
      break;
  }
}

// ---------- WebRTC ----------

async function startCamera() {
  if (state.localStream) return;
  state.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  $("local").srcObject = state.localStream;
}

async function startPeer(initiator) {
  closePeer();
  const pc = new RTCPeerConnection({ iceServers: state.config.iceServers });
  state.pc = pc;
  for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);

  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: "signal", data: { candidate: e.candidate } });
  };
  pc.ontrack = (e) => {
    $("remote").srcObject = e.streams[0];
    setOverlay(null);
    startModeration();
  };

  if (initiator) {
    await pc.setLocalDescription(await pc.createOffer());
    wsSend({ type: "signal", data: { sdp: pc.localDescription } });
  }
}

async function onSignal(data) {
  const pc = state.pc;
  if (!pc) return;
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    for (const c of state.pendingCandidates.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    if (data.sdp.type === "offer") {
      await pc.setLocalDescription(await pc.createAnswer());
      wsSend({ type: "signal", data: { sdp: pc.localDescription } });
    }
  } else if (data.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
    else state.pendingCandidates.push(data.candidate);
  }
}

function closePeer() {
  state.stopModeration?.();
  state.stopModeration = null;
  setBlurred(false);
  state.pc?.close();
  state.pc = null;
  state.pendingCandidates = [];
  $("remote").srcObject = null;
  $("partner-info").textContent = "";
}

// ---------- Moderation ----------

function startModeration() {
  const intent = state.config.intents.find((i) => i.id === state.activeIntent);
  if (!intent || intent.adult || state.stopModeration) return;
  state.stopModeration = watchVideo($("remote"), setBlurred);
}

function setBlurred(blurred) {
  $("remote").classList.toggle("blurred", blurred);
  $("blur-notice").hidden = !blurred;
}

// ---------- Controls ----------

$("next").onclick = () => {
  wsSend({ type: "skip" });
  joinQueue();
};

$("report").onclick = () => {
  if (!state.pc) return;
  const reason = prompt("What happened? (optional)") ?? "";
  wsSend({ type: "report", reason });
  addMessage("sys", "Reported. Thanks for keeping things safe.");
  joinQueue();
};

$("stop").onclick = () => {
  wsSend({ type: "leave" });
  closePeer();
  state.activeIntent = null;
  for (const track of state.localStream?.getTracks() ?? []) track.stop();
  state.localStream = null;
  $("local").srcObject = null;
  refreshAccount().catch(() => {});
  enterLobby();
};

$("chat-form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("chat-input").value.trim();
  if (!text || !state.pc) return;
  wsSend({ type: "chat", text });
  addMessage("me", text);
  $("chat-input").value = "";
};

// ---------- Helpers ----------

function setOverlay(text) {
  $("remote-overlay").textContent = text ?? "";
  $("remote-overlay").classList.toggle("hidden", !text);
}

function addMessage(kind, text) {
  const div = document.createElement("div");
  div.className = kind;
  div.textContent = kind === "me" ? `You: ${text}` : kind === "them" ? `Them: ${text}` : text;
  $("messages").appendChild(div);
  $("messages").scrollTop = $("messages").scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function formatTime(ms) {
  return ms ? new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
}

init();
