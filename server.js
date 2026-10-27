require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const { pool, init } = require('./db');
const { verifyToken } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const messageRoutes = require('./routes/messages');
const groupRoutes = require('./routes/groups');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Lightweight uptime check — no DB hit, so it stays fast and never
// false-fails if Postgres is briefly slow. Point UptimeRobot (or any
// pinger) at /healthz to keep the free-tier service from sleeping.
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/groups', groupRoutes);

// extensions: ['html'] lets /login, /signup, /chat resolve to their .html
// files directly, so the browser's address bar never shows the extension.
// dotfiles: 'allow' is needed for /.well-known/assetlinks.json (the
// Android TWA app's domain-ownership proof) - Express ignores dotfile
// paths by default.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], dotfiles: 'allow' }));

const server = http.createServer(app);
const io = new Server(server);

// userId -> Set of socket ids (a user may have several tabs/devices open)
const online = new Map();

function addSocket(userId, socketId) {
  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId).add(socketId);
}
function removeSocket(userId, socketId) {
  const set = online.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) online.delete(userId);
}
function socketsFor(userId) {
  return [...(online.get(userId) || [])];
}
function broadcastPresence() {
  io.emit('presence:list', [...online.keys()]);
}

// Lets routes/groups.js (which has no access to `io`) tell every new
// member's sockets live that they were just added to a group. The client
// refetches the group itself (GET /api/groups/:id) to get its OWN wrapped
// key, so `myKey` here (whoever's it happens to be) is stripped first.
app.set('notifyGroupCreated', (group, memberIds) => {
  const { myKey, ...publicGroup } = group;
  memberIds.forEach((id) => {
    socketsFor(id).forEach((sid) => io.to(sid).emit('group:new', publicGroup));
  });
});

// Settings changed (restricted toggle, new admin) — tell every current
// member live so their header/settings modal update without a reload.
app.set('notifyGroupUpdated', (group) => {
  const { myKey, ...publicGroup } = group;
  group.members.forEach((m) => {
    socketsFor(m.id).forEach((sid) => io.to(sid).emit('group:updated', publicGroup));
  });
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error('Missing token'));
    socket.user = verifyToken(token);
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.user.id;
  addSocket(userId, socket.id);
  broadcastPresence();

  // The server never sees plaintext: `ct`/`iv` are an AES-GCM ciphertext
  // and IV produced client-side (see public/crypto.js). It's stored and
  // relayed as an opaque JSON envelope — this process has no key to
  // decrypt it with.
  socket.on('message:send', async ({ to, groupId, ct, iv, isImage }) => {
    if (typeof ct !== 'string' || typeof iv !== 'string' || !ct) return;
    if (ct.length > 1.4 * 1024 * 1024) return; // generous cap over the client's own image-compression target

    const text = JSON.stringify({ ct, iv, isImage: !!isImage });

    if (Number.isInteger(groupId)) {
      const memberCheck = await pool.query(
        'SELECT user_id, is_admin FROM group_members WHERE group_id = $1',
        [groupId]
      );
      const me = memberCheck.rows.find((r) => r.user_id === userId);
      if (!me) return; // not a member, ignore silently

      const groupCheck = await pool.query('SELECT restricted FROM groups WHERE id = $1', [groupId]);
      if (groupCheck.rows[0] && groupCheck.rows[0].restricted && !me.is_admin) {
        socket.emit('message:error', { groupId, error: 'Only admins can send messages in this group' });
        return;
      }

      const memberIds = memberCheck.rows.map((r) => r.user_id);
      const result = await pool.query(
        `INSERT INTO messages (sender_id, group_id, body)
         VALUES ($1, $2, $3)
         RETURNING id, sender_id, group_id, body, created_at`,
        [userId, groupId, text]
      );
      const message = result.rows[0];
      memberIds.forEach((id) => socketsFor(id).forEach((sid) => io.to(sid).emit('message:new', message)));
      return;
    }

    if (!Number.isInteger(to)) return;
    const result = await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, sender_id, receiver_id, body, created_at, read`,
      [userId, to, text]
    );
    const message = result.rows[0];

    socketsFor(to).forEach((sid) => io.to(sid).emit('message:new', message));
    socketsFor(userId).forEach((sid) => io.to(sid).emit('message:new', message));
  });

  socket.on('typing', async ({ to, groupId }) => {
    if (Number.isInteger(groupId)) {
      const memberCheck = await pool.query('SELECT user_id FROM group_members WHERE group_id = $1', [groupId]);
      memberCheck.rows
        .map((r) => r.user_id)
        .filter((id) => id !== userId)
        .forEach((id) => socketsFor(id).forEach((sid) => io.to(sid).emit('typing', { from: userId, groupId })));
      return;
    }
    if (!Number.isInteger(to)) return;
    socketsFor(to).forEach((sid) => io.to(sid).emit('typing', { from: userId }));
  });

  // Marks messages the other person sent ME as read, then tells their
  // sockets live so their sent checkmarks turn blue without a reload.
  socket.on('messages:read', async ({ from }) => {
    if (!Number.isInteger(from)) return;
    const result = await pool.query(
      `UPDATE messages SET read = true
       WHERE sender_id = $1 AND receiver_id = $2 AND read = false
       RETURNING id`,
      [from, userId]
    );
    if (result.rows.length === 0) return;
    const ids = result.rows.map((r) => r.id);
    socketsFor(from).forEach((sid) => io.to(sid).emit('messages:read', { by: userId, ids }));
  });

  // ── WebRTC signaling relay (server never touches audio/video, just forwards) ──
  socket.on('call:offer', ({ to, sdp, kind }) => {
    socketsFor(to).forEach((sid) => io.to(sid).emit('call:offer', { from: userId, sdp, kind }));
  });
  socket.on('call:answer', ({ to, sdp }) => {
    socketsFor(to).forEach((sid) => io.to(sid).emit('call:answer', { from: userId, sdp }));
  });
  socket.on('call:ice', ({ to, candidate }) => {
    socketsFor(to).forEach((sid) => io.to(sid).emit('call:ice', { from: userId, candidate }));
  });
  socket.on('call:reject', ({ to }) => {
    socketsFor(to).forEach((sid) => io.to(sid).emit('call:reject', { from: userId }));
  });
  socket.on('call:end', ({ to }) => {
    socketsFor(to).forEach((sid) => io.to(sid).emit('call:end', { from: userId }));
  });

  socket.on('disconnect', () => {
    removeSocket(userId, socket.id);
    broadcastPresence();
  });
});

const PORT = process.env.PORT || 3000;

init()
  .then(() => {
    server.listen(PORT, () => console.log(`K1Chat listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
