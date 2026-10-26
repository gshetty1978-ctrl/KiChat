// ── state ────────────────────────────────────────────────────────────────
const COLORS = ['#3ecfb2','#7b61ff','#ff6b9d','#ff9f43','#54a0ff','#5f27cd','#00d2d3','#ff6348'];
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

let token = null;
let me = null;
let socket = null;
let users = [];
let usersById = new Map();
let online = new Set();
let unread = new Map();
let lastMsg = new Map();
let activeUser = null;
let typingTimeout = null;

let pc = null;
let localStream = null;
let pendingIce = [];
let pendingOffer = null; // { from, sdp, kind } while incoming overlay is shown
let callOtherId = null;
let callKind = null;
let callSecs = 0;
let callTimer = null;
let muted = false;
let camOff = false;

// ── boot ─────────────────────────────────────────────────────────────────
(function boot() {
  try {
    const saved = localStorage.getItem('kichat-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  } catch (e) {}

  const modified = new Date(document.lastModified).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
  ['last-modified-auth', 'last-modified-app'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = modified;
  });

  let savedToken = null;
  try { savedToken = localStorage.getItem('kichat_token'); } catch (e) {}

  if (savedToken) {
    token = savedToken;
    fetchJSON('/api/users/me')
      .then((user) => { me = user; initApp(); })
      .catch(() => { token = null; try { localStorage.removeItem('kichat_token'); } catch (e) {} });
  }
})();

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    const data = await postJSON('/api/auth/login', { username, password });
    onAuthed(data);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('register-username').value.trim();
  const password = document.getElementById('register-password').value;
  const errEl = document.getElementById('register-error');
  errEl.textContent = '';
  try {
    const data = await postJSON('/api/auth/register', { username, password });
    onAuthed(data);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function onAuthed(data) {
  token = data.token;
  me = data.user;
  try { localStorage.setItem('kichat_token', token); } catch (e) {}
  initApp();
}

function showAuthTab(tab) {
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');
  document.getElementById('login-form').hidden = tab !== 'login';
  document.getElementById('register-form').hidden = tab !== 'register';
}

function logout() {
  try { localStorage.removeItem('kichat_token'); } catch (e) {}
  if (socket) socket.disconnect();
  location.reload();
}

// ── fetch helpers ───────────────────────────────────────────────────────
async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Request failed');
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── app init ─────────────────────────────────────────────────────────────
async function initApp() {
  document.getElementById('auth-screen').hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('my-avatar').textContent = initialsOf(me.username);

  users = await fetchJSON('/api/users');
  usersById = new Map(users.map((u) => [u.id, u]));
  renderContactList();

  connectSocket();
}

function connectSocket() {
  socket = io({ auth: { token } });

  socket.on('presence:list', (ids) => {
    online = new Set(ids);
    renderContactList();
    if (activeUser) updateHeaderStatus();
  });

  socket.on('message:new', (msg) => {
    const otherId = msg.sender_id === me.id ? msg.receiver_id : msg.sender_id;
    lastMsg.set(otherId, msg);

    if (activeUser && activeUser.id === otherId) {
      appendMessage(msg);
    } else if (msg.sender_id !== me.id) {
      unread.set(otherId, (unread.get(otherId) || 0) + 1);
    }
    renderContactList();
  });

  socket.on('typing', ({ from }) => {
    if (activeUser && activeUser.id === from) showTypingBubble();
  });

  // ── call signaling ──
  socket.on('call:offer', async ({ from, sdp, kind }) => {
    if (pendingOffer || pc) {
      socket.emit('call:reject', { to: from });
      return;
    }
    pendingOffer = { from, sdp, kind };
    const user = usersById.get(from);
    document.getElementById('incoming-avatar').style.background = colorFor(from);
    document.getElementById('incoming-avatar').textContent = initialsOf(user ? user.username : '?');
    document.getElementById('incoming-name').textContent = user ? user.username : 'Unknown';
    document.getElementById('incoming-kind').textContent = kind === 'video' ? 'Incoming video call…' : 'Incoming voice call…';
    document.getElementById('incoming-overlay').hidden = false;
  });

  socket.on('call:answer', async ({ sdp }) => {
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    flushPendingIce();
    setCallConnected();
  });

  socket.on('call:ice', async ({ candidate }) => {
    if (!pc) return;
    if (!pc.remoteDescription) {
      pendingIce.push(candidate);
    } else {
      try { await pc.addIceCandidate(candidate); } catch (e) {}
    }
  });

  socket.on('call:reject', () => {
    showToast('Call declined');
    cleanupCall();
  });

  socket.on('call:end', () => {
    showToast('Call ended');
    cleanupCall();
  });
}

// ── contacts / chat ─────────────────────────────────────────────────────
function initialsOf(name) {
  return (name || '?').slice(0, 2).toUpperCase();
}
function colorFor(id) {
  return COLORS[id % COLORS.length];
}
function timeLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function renderContactList() {
  const q = document.getElementById('search-input').value.toLowerCase();
  const list = users.filter((u) => u.username.toLowerCase().includes(q));
  const el = document.getElementById('contact-list');

  if (list.length === 0) {
    el.innerHTML = `<div style="padding:24px 16px;color:var(--fg3);font-size:13px;text-align:center">No one else has signed up yet. Share the app link so others can join.</div>`;
    return;
  }

  el.innerHTML = list.map((u) => {
    const isOnline = online.has(u.id);
    const unreadCount = unread.get(u.id) || 0;
    const last = lastMsg.get(u.id);
    const preview = last ? last.body : 'Say hi 👋';
    const time = last ? timeLabel(last.created_at) : '';
    return `
      <div class="contact-item${activeUser && activeUser.id === u.id ? ' active' : ''}" onclick="openChat(${u.id})">
        <div class="contact-av" style="background:${colorFor(u.id)}">
          ${initialsOf(u.username)}<span class="dot ${isOnline ? 'online' : 'offline'}"></span>
        </div>
        <div class="contact-info">
          <div class="contact-row1">
            <span class="contact-name">${escapeHtml(u.username)}</span>
            <span class="contact-time">${time}</span>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
            <span class="contact-prev">${escapeHtml(preview)}</span>
            ${unreadCount > 0 ? `<span class="contact-unread">${unreadCount}</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function openChat(id) {
  activeUser = usersById.get(id);
  if (!activeUser) return;
  unread.set(id, 0);

  document.getElementById('header-av').style.background = colorFor(id);
  document.getElementById('header-av').textContent = initialsOf(activeUser.username);
  document.getElementById('header-name').textContent = activeUser.username;
  updateHeaderStatus();

  document.getElementById('empty-state').hidden = true;
  document.getElementById('chat-view').hidden = false;

  const history = await fetchJSON('/api/messages/' + id);
  if (history.length) lastMsg.set(id, history[history.length - 1]);
  renderMessages(history);
  renderContactList();
  document.getElementById('msg-input').focus();
}

function updateHeaderStatus() {
  if (!activeUser) return;
  document.getElementById('header-status').textContent = online.has(activeUser.id) ? '● Online' : '○ Offline';
}

function renderMessages(list) {
  const el = document.getElementById('messages');
  el.innerHTML = list.map(messageHtml).join('');
  el.scrollTop = el.scrollHeight;
}

function messageHtml(m) {
  const sent = m.sender_id === me.id;
  return `
    <div class="msg ${sent ? 'sent' : 'recv'}" data-id="${m.id}">
      <div class="msg-bubble">${escapeHtml(m.body)}</div>
      <div class="msg-meta">
        <span>${timeLabel(m.created_at)}</span>
        ${sent ? `<span class="check">${m.read ? '✓✓' : '✓'}</span>` : ''}
      </div>
    </div>
  `;
}

function appendMessage(m) {
  const el = document.getElementById('messages');
  el.insertAdjacentHTML('beforeend', messageHtml(m));
  el.scrollTop = el.scrollHeight;
}

function showTypingBubble() {
  const el = document.getElementById('messages');
  const existing = el.querySelector('.typing-bubble');
  if (existing) existing.remove();
  el.insertAdjacentHTML('beforeend', `<div class="typing-bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`);
  el.scrollTop = el.scrollHeight;
  clearTimeout(window.__typingClear);
  window.__typingClear = setTimeout(() => {
    const b = el.querySelector('.typing-bubble');
    if (b) b.remove();
  }, 2500);
}

function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || !activeUser) return;
  socket.emit('message:send', { to: activeUser.id, body: text });
  input.value = '';
  input.style.height = '';
}

document.getElementById('msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  } else if (activeUser) {
    socket.emit('typing', { to: activeUser.id });
  }
});
document.getElementById('msg-input').addEventListener('input', (e) => {
  e.target.style.height = '';
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
});

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function showToast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(window.__toastClear);
  window.__toastClear = setTimeout(() => { el.hidden = true; }, 3000);
}

function toggleTheme() {
  const root = document.documentElement;
  const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  root.setAttribute('data-theme', next);
  try { localStorage.setItem('kichat-theme', next); } catch (e) {}
}

// ── WebRTC calls ─────────────────────────────────────────────────────────
async function getMedia(kind) {
  const constraints = kind === 'video' ? { audio: true, video: true } : { audio: true, video: false };
  return navigator.mediaDevices.getUserMedia(constraints);
}

function newPeerConnection(toId) {
  const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  conn.onicecandidate = (e) => {
    if (e.candidate) socket.emit('call:ice', { to: toId, candidate: e.candidate });
  };
  conn.ontrack = (e) => {
    const stream = e.streams[0];
    if (callKind === 'video') {
      document.getElementById('remote-video').srcObject = stream;
    } else {
      document.getElementById('remote-audio').srcObject = stream;
    }
  };
  return conn;
}

async function startCall(kind) {
  if (!activeUser || pc) return;
  callOtherId = activeUser.id;
  callKind = kind;

  try {
    localStream = await getMedia(kind);
  } catch (err) {
    showToast('Could not access ' + (kind === 'video' ? 'camera/microphone' : 'microphone'));
    return;
  }

  pc = newPeerConnection(callOtherId);
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  showCallOverlay(kind, activeUser, 'Calling…');

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('call:offer', { to: callOtherId, sdp: offer, kind });
}

async function acceptCall() {
  if (!pendingOffer) return;
  const { from, sdp, kind } = pendingOffer;
  callOtherId = from;
  callKind = kind;
  document.getElementById('incoming-overlay').hidden = true;

  try {
    localStream = await getMedia(kind);
  } catch (err) {
    showToast('Could not access ' + (kind === 'video' ? 'camera/microphone' : 'microphone'));
    socket.emit('call:reject', { to: from });
    pendingOffer = null;
    return;
  }

  pc = newPeerConnection(callOtherId);
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  flushPendingIce();

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('call:answer', { to: from, sdp: answer });

  const user = usersById.get(from);
  showCallOverlay(kind, user, 'Connecting…');
  setCallConnected();
  pendingOffer = null;
}

function rejectCall() {
  if (pendingOffer) socket.emit('call:reject', { to: pendingOffer.from });
  pendingOffer = null;
  document.getElementById('incoming-overlay').hidden = true;
}

function flushPendingIce() {
  pendingIce.forEach((c) => pc.addIceCandidate(c).catch(() => {}));
  pendingIce = [];
}

function showCallOverlay(kind, user, status) {
  const name = user ? user.username : 'Unknown';
  if (kind === 'video') {
    document.getElementById('video-name').textContent = name;
    document.getElementById('video-status').textContent = status;
    document.getElementById('video-timer').hidden = true;
    document.getElementById('local-video').srcObject = localStream;
    document.getElementById('video-overlay').hidden = false;
  } else {
    document.getElementById('voice-avatar').style.background = colorFor(user ? user.id : 0);
    document.getElementById('voice-avatar').textContent = initialsOf(name);
    document.getElementById('voice-name').textContent = name;
    document.getElementById('voice-status').textContent = status;
    document.getElementById('voice-timer').hidden = true;
    document.getElementById('voice-overlay').hidden = false;
  }
}

function setCallConnected() {
  const statusEl = document.getElementById(callKind === 'video' ? 'video-status' : 'voice-status');
  const timerEl = document.getElementById(callKind === 'video' ? 'video-timer' : 'voice-timer');
  statusEl.textContent = 'Connected';
  timerEl.hidden = false;
  callSecs = 0;
  updateTimerText(timerEl);
  clearInterval(callTimer);
  callTimer = setInterval(() => { callSecs++; updateTimerText(timerEl); }, 1000);
}

function updateTimerText(el) {
  const m = Math.floor(callSecs / 60);
  const s = (callSecs % 60).toString().padStart(2, '0');
  el.textContent = m + ':' + s;
}

function endCall() {
  if (callOtherId) socket.emit('call:end', { to: callOtherId });
  cleanupCall();
}

function cleanupCall() {
  clearInterval(callTimer);
  callTimer = null;
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  pendingIce = [];
  callOtherId = null;
  callKind = null;
  muted = false;
  camOff = false;
  document.getElementById('voice-overlay').hidden = true;
  document.getElementById('video-overlay').hidden = true;
  document.getElementById('incoming-overlay').hidden = true;
}

function toggleMute() {
  if (!localStream) return;
  muted = !muted;
  localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  const btn = document.getElementById(callKind === 'video' ? 'vmute-btn' : 'mute-btn');
  btn.classList.toggle('active', muted);
}

function toggleCam() {
  if (!localStream) return;
  camOff = !camOff;
  localStream.getVideoTracks().forEach((t) => (t.enabled = !camOff));
  document.getElementById('vcam-btn').classList.toggle('active', camOff);
}
