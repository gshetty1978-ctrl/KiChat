// Requires common.js to be loaded first.
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const MAX_IMAGE_RAW_BYTES = 8 * 1024 * 1024; // reject before even trying to compress
const MAX_IMAGE_SENT_BYTES = 900 * 1024; // after compression, hard cap on what we actually send
const MAX_AVATAR_RAW_BYTES = 8 * 1024 * 1024;

let me = null;
let socket = null;
let users = [];
let usersById = new Map();
let groups = [];
let groupsById = new Map();
let online = new Set();
let unread = new Map();
let lastMsg = new Map();
let groupUnread = new Map();
let groupLastMsg = new Map();
let activeUser = null;
let activeGroup = null;
let sidebarTab = 'all';
let typingFrom = null;

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

(async function boot() {
  if (!requireTokenOrRedirect()) return;
  try {
    me = await fetchJSON('/api/users/me');
  } catch (e) {
    clearToken();
    location.href = '/login';
    return;
  }
  await initApp();
})();

function logout() {
  clearToken();
  if (socket) socket.disconnect();
  location.href = '/login';
}

async function initApp() {
  renderMyAvatar();

  users = await fetchJSON('/api/users');
  usersById = new Map(users.map((u) => [u.id, u]));

  groups = await fetchJSON('/api/groups');
  groupsById = new Map(groups.map((g) => [g.id, g]));

  renderContactList();
  connectSocket();
}

function connectSocket() {
  socket = io({ auth: { token: getToken() } });

  socket.on('presence:list', (ids) => {
    online = new Set(ids);
    renderContactList();
    if (activeUser) updateHeaderStatus();
    if (activeGroup) updateGroupHeaderStatus();
  });

  socket.on('message:new', (msg) => {
    if (msg.group_id) {
      groupLastMsg.set(msg.group_id, msg);
      if (activeGroup && activeGroup.id === msg.group_id) {
        appendMessage(msg);
        clearTypingFor(msg.group_id, true);
      } else if (msg.sender_id !== me.id) {
        groupUnread.set(msg.group_id, (groupUnread.get(msg.group_id) || 0) + 1);
      }
      renderContactList();
      return;
    }

    const otherId = msg.sender_id === me.id ? msg.receiver_id : msg.sender_id;
    lastMsg.set(otherId, msg);

    if (activeUser && activeUser.id === otherId) {
      appendMessage(msg);
      clearTypingFor(otherId, false);
      if (msg.sender_id !== me.id) socket.emit('messages:read', { from: otherId });
    } else if (msg.sender_id !== me.id) {
      unread.set(otherId, (unread.get(otherId) || 0) + 1);
    }
    renderContactList();
  });

  socket.on('messages:read', ({ ids }) => {
    markMessagesRead(ids);
  });

  socket.on('typing', ({ from, groupId }) => {
    const isCurrentChat = groupId
      ? (activeGroup && activeGroup.id === groupId)
      : (activeUser && activeUser.id === from);
    if (!isCurrentChat) return;

    const name = groupId
      ? ((activeGroup.members.find((m) => m.id === from) || {}).username || 'Someone')
      : activeUser.username;
    showTypingBubble(name);
  });

  socket.on('group:new', (group) => {
    if (groupsById.has(group.id)) return; // the creator already has it from the POST response
    groups.unshift(group);
    groupsById.set(group.id, group);
    renderContactList();
    showToast(`Added to "${group.name}"`);
  });

  // ── call signaling ──
  socket.on('call:offer', async ({ from, sdp, kind }) => {
    if (pendingOffer || pc) {
      socket.emit('call:reject', { to: from });
      return;
    }
    pendingOffer = { from, sdp, kind };
    const user = usersById.get(from);
    setAvatarEl(document.getElementById('incoming-avatar'), user);
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
    endCallWithStatus('Call declined');
  });

  socket.on('call:end', () => {
    endCallWithStatus('Call ended');
  });
}

// ── avatars (image or colored initials, shared everywhere) ─────────────
function setAvatarEl(el, entity, label) {
  if (!el) return;
  const name = label || (entity && (entity.username || entity.name)) || '?';
  if (entity && entity.avatar_data) {
    el.style.background = 'none';
    el.innerHTML = `<img class="avatar-img" src="${entity.avatar_data}" alt="">`;
  } else {
    const id = entity ? entity.id : 0;
    el.style.background = colorFor(id);
    el.innerHTML = '';
    el.textContent = initialsOf(name);
  }
}
function avatarInnerHtml(entity, name) {
  if (entity && entity.avatar_data) return `<img class="avatar-img" src="${entity.avatar_data}" alt="">`;
  return initialsOf(name);
}
function avatarStyle(entity, id) {
  return entity && entity.avatar_data ? '' : `background:${colorFor(id)}`;
}

function renderMyAvatar() {
  setAvatarEl(document.getElementById('my-avatar'), { ...me, id: me.id });
}

// ── sidebar: merged DMs + groups ────────────────────────────────────────
function setSidebarTab(tab, btn) {
  sidebarTab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  renderContactList();
}

function renderContactList() {
  const q = document.getElementById('search-input').value.toLowerCase();

  const dmEntries = users
    .filter((u) => u.username.toLowerCase().includes(q))
    .map((u) => ({
      type: 'dm', id: u.id, name: u.username, entity: u,
      unreadCount: unread.get(u.id) || 0,
      last: lastMsg.get(u.id),
      online: online.has(u.id),
    }));

  const groupEntries = groups
    .filter((g) => g.name.toLowerCase().includes(q))
    .map((g) => ({
      type: 'group', id: g.id, name: g.name, entity: g,
      unreadCount: groupUnread.get(g.id) || 0,
      last: groupLastMsg.get(g.id),
    }));

  let list;
  if (sidebarTab === 'groups') list = groupEntries;
  else if (sidebarTab === 'unread') list = [...dmEntries, ...groupEntries].filter((e) => e.unreadCount > 0);
  else list = [...dmEntries, ...groupEntries];

  list.sort((a, b) => {
    const at = a.last ? new Date(a.last.created_at).getTime() : 0;
    const bt = b.last ? new Date(b.last.created_at).getTime() : 0;
    return bt - at;
  });

  const el = document.getElementById('contact-list');

  if (list.length === 0) {
    const msg = sidebarTab === 'groups'
      ? 'No groups yet. Tap + to start one.'
      : sidebarTab === 'unread'
        ? "You're all caught up! 🎉"
        : 'No one else has signed up yet. Share the app link so others can join.';
    el.innerHTML = `<div style="padding:24px 16px;color:var(--fg3);font-size:13px;text-align:center">${msg}</div>`;
    return;
  }

  el.innerHTML = list.map((item) => {
    const isActive = item.type === 'dm'
      ? (activeUser && activeUser.id === item.id)
      : (activeGroup && activeGroup.id === item.id);
    const preview = item.last
      ? (item.last.body.startsWith('[[img]]') ? '📷 Photo' : item.last.body)
      : (item.type === 'group' ? 'No messages yet' : 'Say hi 👋');
    const time = item.last ? timeLabel(item.last.created_at) : '';
    const dot = item.type === 'dm' ? `<span class="dot ${item.online ? 'online' : 'offline'}"></span>` : '';
    const onclick = item.type === 'dm' ? `openChat(${item.id})` : `openGroup(${item.id})`;

    return `
      <div class="contact-item${isActive ? ' active' : ''}" onclick="${onclick}">
        <div class="contact-av" style="${avatarStyle(item.entity, item.id)}">
          ${avatarInnerHtml(item.entity, item.name)}${dot}
        </div>
        <div class="contact-info">
          <div class="contact-row1">
            <span class="contact-name">${escapeHtml(item.name)}</span>
            <span class="contact-time">${time}</span>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
            <span class="contact-prev">${escapeHtml(preview)}</span>
            ${item.unreadCount > 0 ? `<span class="contact-unread">${item.unreadCount}</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ── direct messages ──────────────────────────────────────────────────────
async function openChat(id) {
  activeUser = usersById.get(id);
  activeGroup = null;
  if (!activeUser) return;
  unread.set(id, 0);

  setAvatarEl(document.getElementById('header-av'), activeUser);
  document.getElementById('header-name').textContent = activeUser.username;
  updateHeaderStatus();
  document.getElementById('chat-actions').hidden = false;
  document.getElementById('group-members-row').hidden = true;

  document.getElementById('empty-state').hidden = true;
  document.getElementById('chat-view').hidden = false;

  const history = await fetchJSON('/api/messages/' + id);
  if (history.length) lastMsg.set(id, history[history.length - 1]);
  renderMessages(history, 'dm');
  renderContactList();
  document.getElementById('msg-input').focus();

  socket.emit('messages:read', { from: id });
}

function updateHeaderStatus() {
  if (!activeUser) return;
  document.getElementById('header-status').textContent = online.has(activeUser.id) ? '● Online' : '○ Offline';
}

// ── groups ───────────────────────────────────────────────────────────────
async function openGroup(id) {
  activeGroup = groupsById.get(id);
  activeUser = null;
  if (!activeGroup) return;
  groupUnread.set(id, 0);

  setAvatarEl(document.getElementById('header-av'), null, activeGroup.name);
  document.getElementById('header-av').style.background = colorFor(id);
  document.getElementById('header-name').textContent = activeGroup.name;
  document.getElementById('chat-actions').hidden = true; // group calls aren't supported
  updateGroupHeaderStatus();

  document.getElementById('empty-state').hidden = true;
  document.getElementById('chat-view').hidden = false;

  const history = await fetchJSON(`/api/groups/${id}/messages`);
  if (history.length) groupLastMsg.set(id, history[history.length - 1]);
  renderMessages(history, 'group');
  renderContactList();
  document.getElementById('msg-input').focus();
}

// Shows "N online" when someone besides you is online; otherwise lists
// every member's name, truncating with "…" once it won't fit on one line.
function updateGroupHeaderStatus() {
  if (!activeGroup) return;
  const statusEl = document.getElementById('header-status');
  const others = activeGroup.members.filter((m) => m.id !== me.id);
  const onlineOthers = others.filter((m) => online.has(m.id));

  if (onlineOthers.length > 0) {
    statusEl.textContent = `${onlineOthers.length} online`;
  } else {
    const names = others.map((m) => m.username);
    const maxShown = 5;
    statusEl.textContent = names.length > maxShown
      ? names.slice(0, maxShown).join(', ') + ', …'
      : names.join(', ');
  }

  const row = document.getElementById('group-members-row');
  row.hidden = false;
  const avatarsHtml = activeGroup.members.slice(0, 6).map((m) => `
    <div class="mini-av" style="${avatarStyle(m, m.id)}">${avatarInnerHtml(m, m.username)}</div>
  `).join('');
  const overflow = activeGroup.members.length > 6 ? `<span class="contact-time">+${activeGroup.members.length - 6}</span>` : '';
  row.innerHTML = `<div class="group-avatars">${avatarsHtml}</div>${overflow}
    <span class="group-members-text">${escapeHtml(activeGroup.members.map((m) => m.username).join(', '))}</span>`;
}

// ── messages (shared rendering for DM + group) ──────────────────────────
function renderMessages(list, kind) {
  const el = document.getElementById('messages');
  el.innerHTML = list.map((m) => messageHtml(m, kind)).join('');
  el.scrollTop = el.scrollHeight;
}

function messageHtml(m, kind) {
  const sent = m.sender_id === me.id;
  const isImage = m.body.startsWith('[[img]]');
  const bodyHtml = isImage
    ? `<img class="msg-img" src="${m.body.slice(7)}" alt="Image" onclick="window.open(this.src, '_blank')">`
    : escapeHtml(m.body);

  let senderLabel = '';
  if (kind === 'group' && !sent) {
    const sender = activeGroup && activeGroup.members.find((mem) => mem.id === m.sender_id);
    senderLabel = `<div class="typing-name" style="margin-bottom:2px;color:var(--accent)">${escapeHtml(sender ? sender.username : 'Unknown')}</div>`;
  }

  const checkHtml = kind === 'dm' && sent
    ? `<span class="check ${m.read ? 'read' : 'unread'}">✓✓</span>`
    : '';

  return `
    <div class="msg ${sent ? 'sent' : 'recv'}" data-id="${m.id}">
      ${senderLabel}
      <div class="msg-bubble" style="${isImage ? 'padding:4px;background:transparent;border:none' : ''}">${bodyHtml}</div>
      <div class="msg-meta">
        <span>${timeLabel(m.created_at)}</span>
        ${checkHtml}
      </div>
    </div>
  `;
}

function markMessagesRead(ids) {
  ids.forEach((id) => {
    const check = document.querySelector(`.msg[data-id="${id}"] .check`);
    if (check) { check.classList.remove('unread'); check.classList.add('read'); }
  });
}

function appendMessage(m) {
  const el = document.getElementById('messages');
  const kind = m.group_id ? 'group' : 'dm';
  el.insertAdjacentHTML('beforeend', messageHtml(m, kind));
  el.scrollTop = el.scrollHeight;
}

function showTypingBubble(name) {
  typingFrom = name;
  const el = document.getElementById('messages');
  let bubble = el.querySelector('.typing-bubble');
  if (!bubble) {
    el.insertAdjacentHTML('beforeend', `
      <div class="typing-name">${escapeHtml(name)} is typing…</div>
      <div class="typing-bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
    `);
  } else {
    bubble.previousElementSibling.textContent = `${name} is typing…`;
  }
  el.scrollTop = el.scrollHeight;
  clearTimeout(window.__typingClear);
  window.__typingClear = setTimeout(() => clearTypingFor(null, null), 2500);
}

function clearTypingFor() {
  const el = document.getElementById('messages');
  const bubble = el.querySelector('.typing-bubble');
  if (bubble) {
    const label = bubble.previousElementSibling;
    if (label && label.classList.contains('typing-name')) label.remove();
    bubble.remove();
  }
  typingFrom = null;
}

function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;
  if (activeGroup) {
    socket.emit('message:send', { groupId: activeGroup.id, body: text });
  } else if (activeUser) {
    socket.emit('message:send', { to: activeUser.id, body: text });
  } else {
    return;
  }
  input.value = '';
  input.style.height = '';
}

document.getElementById('msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  } else if (activeGroup) {
    socket.emit('typing', { groupId: activeGroup.id });
  } else if (activeUser) {
    socket.emit('typing', { to: activeUser.id });
  }
});
document.getElementById('msg-input').addEventListener('input', (e) => {
  e.target.style.height = '';
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
});

function showToast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(window.__toastClear);
  window.__toastClear = setTimeout(() => { el.hidden = true; }, 3000);
}

// ── image attachments ───────────────────────────────────────────────────
async function compressImageToDataUrl(file, maxDim, quality) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

async function handleFileSelected(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (!activeUser && !activeGroup) return;

  if (file.size > MAX_IMAGE_RAW_BYTES) {
    showToast(`That file is too big (max ${Math.round(MAX_IMAGE_RAW_BYTES / 1024 / 1024)}MB).`);
    return;
  }

  let dataUrl;
  try {
    dataUrl = await compressImageToDataUrl(file, 1280, 0.82);
  } catch (e) {
    showToast('Could not read that image.');
    return;
  }

  if (dataUrl.length > MAX_IMAGE_SENT_BYTES) {
    dataUrl = await compressImageToDataUrl(file, 900, 0.68);
  }
  if (dataUrl.length > MAX_IMAGE_SENT_BYTES) {
    showToast('Image is still too large after compression — try a smaller photo.');
    return;
  }

  const body = '[[img]]' + dataUrl;
  if (activeGroup) socket.emit('message:send', { groupId: activeGroup.id, body });
  else socket.emit('message:send', { to: activeUser.id, body });
}

// ── profile picture ──────────────────────────────────────────────────────
function openAvatarModal() {
  const preview = document.getElementById('avatar-preview');
  setAvatarEl(preview, me);
  document.getElementById('avatar-remove-btn').hidden = !me.avatar_data;
  document.getElementById('avatar-error').textContent = '';
  document.getElementById('avatar-modal').hidden = false;
}
function closeAvatarModal() {
  document.getElementById('avatar-modal').hidden = true;
}

async function handleAvatarSelected(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const errEl = document.getElementById('avatar-error');
  errEl.textContent = '';

  if (file.size > MAX_AVATAR_RAW_BYTES) {
    errEl.textContent = `That file is too big (max ${Math.round(MAX_AVATAR_RAW_BYTES / 1024 / 1024)}MB).`;
    return;
  }

  let dataUrl;
  try {
    dataUrl = await compressImageToDataUrl(file, 320, 0.85);
  } catch (e) {
    errEl.textContent = 'Could not read that image.';
    return;
  }
  if (dataUrl.length > 340 * 1024) {
    dataUrl = await compressImageToDataUrl(file, 220, 0.7);
  }

  try {
    const data = await putJSON('/api/users/me/avatar', { avatar: dataUrl });
    me.avatar_data = data.avatar_data;
    renderMyAvatar();
    setAvatarEl(document.getElementById('avatar-preview'), me);
    document.getElementById('avatar-remove-btn').hidden = false;
    renderContactList();
    if (activeUser && activeUser.id === me.id) setAvatarEl(document.getElementById('header-av'), activeUser);
  } catch (err) {
    errEl.textContent = err.message;
  }
}

async function removeAvatar() {
  try {
    const data = await putJSON('/api/users/me/avatar', { avatar: null });
    me.avatar_data = data.avatar_data;
    renderMyAvatar();
    setAvatarEl(document.getElementById('avatar-preview'), me);
    document.getElementById('avatar-remove-btn').hidden = true;
    renderContactList();
  } catch (err) {
    document.getElementById('avatar-error').textContent = err.message;
  }
}

// ── new chat / new group modal ──────────────────────────────────────────
function openNewChatModal() {
  setNewChatMode('dm', document.querySelector('.modal-tab[data-mode="dm"]'));
  document.getElementById('nc-group-name').value = '';
  document.getElementById('nc-group-error').textContent = '';
  renderNewChatLists();
  document.getElementById('new-chat-modal').hidden = false;
}
function closeNewChatModal() {
  document.getElementById('new-chat-modal').hidden = true;
}
function setNewChatMode(mode, btn) {
  document.querySelectorAll('.modal-tab').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('nc-dm-panel').hidden = mode !== 'dm';
  document.getElementById('nc-group-panel').hidden = mode !== 'group';
}

function renderNewChatLists() {
  const dmList = document.getElementById('nc-dm-list');
  if (users.length === 0) {
    dmList.innerHTML = `<div style="padding:16px 8px;color:var(--fg3);font-size:13px">No one else has signed up yet.</div>`;
  } else {
    dmList.innerHTML = users.map((u) => `
      <div class="people-row" onclick="closeNewChatModal(); openChat(${u.id})">
        <div class="contact-av" style="${avatarStyle(u, u.id)}">${avatarInnerHtml(u, u.username)}</div>
        <span class="pname">${escapeHtml(u.username)}</span>
      </div>
    `).join('');
  }

  const groupMembers = document.getElementById('nc-group-members');
  groupMembers.innerHTML = users.map((u) => `
    <label class="people-row">
      <div class="contact-av" style="${avatarStyle(u, u.id)}">${avatarInnerHtml(u, u.username)}</div>
      <span class="pname">${escapeHtml(u.username)}</span>
      <input type="checkbox" value="${u.id}" class="nc-member-check">
    </label>
  `).join('');
}

async function submitNewGroup() {
  const name = document.getElementById('nc-group-name').value.trim();
  const errEl = document.getElementById('nc-group-error');
  errEl.textContent = '';

  if (!name) { errEl.textContent = 'Give the group a name.'; return; }
  const memberIds = [...document.querySelectorAll('.nc-member-check:checked')].map((c) => parseInt(c.value, 10));
  if (memberIds.length === 0) { errEl.textContent = 'Pick at least one other person.'; return; }

  try {
    const group = await postJSON('/api/groups', { name, memberIds });
    groups.unshift(group);
    groupsById.set(group.id, group);
    closeNewChatModal();
    renderContactList();
    openGroup(group.id);
  } catch (err) {
    errEl.textContent = err.message;
  }
}

// ── WebRTC calls (direct messages only) ─────────────────────────────────
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
    setAvatarEl(document.getElementById('voice-avatar'), user);
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
  endCallWithStatus('Call ended');
}

// Shows a plain "Call ended" / "Call declined" status in place of the
// timer for a moment, so hanging up isn't just the window vanishing with
// no feedback, then closes the overlay and releases mic/camera.
function endCallWithStatus(message) {
  if (!document.getElementById('voice-overlay').hidden || !document.getElementById('video-overlay').hidden) {
    const statusEl = document.getElementById(callKind === 'video' ? 'video-status' : 'voice-status');
    const timerEl = document.getElementById(callKind === 'video' ? 'video-timer' : 'voice-timer');
    if (statusEl) statusEl.textContent = message;
    if (timerEl) timerEl.hidden = true;
  } else {
    showToast(message);
  }

  clearInterval(callTimer);
  callTimer = null;
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  pendingIce = [];
  callOtherId = null;
  muted = false;
  camOff = false;
  document.getElementById('incoming-overlay').hidden = true;

  setTimeout(() => {
    document.getElementById('voice-overlay').hidden = true;
    document.getElementById('video-overlay').hidden = true;
    callKind = null;
  }, 1100);
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
