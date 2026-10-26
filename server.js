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

const app = express();
app.use(cors());
app.use(express.json());

// Lightweight uptime check — no DB hit, so it stays fast and never
// false-fails if Postgres is briefly slow. Point UptimeRobot (or any
// pinger) at /healthz to keep the free-tier service from sleeping.
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/messages', messageRoutes);

// extensions: ['html'] lets /login, /signup, /chat resolve to their .html
// files directly, so the browser's address bar never shows the extension.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

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

  socket.on('message:send', async ({ to, body }) => {
    if (!Number.isInteger(to) || typeof body !== 'string' || !body.trim()) return;
    const text = body.slice(0, 4000);

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

  socket.on('typing', ({ to }) => {
    if (!Number.isInteger(to)) return;
    socketsFor(to).forEach((sid) => io.to(sid).emit('typing', { from: userId }));
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
