const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const supabase = require('../supabase');

const router = express.Router();

// directory of everyone else you can message
router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT id, username, avatar_data, public_key FROM users WHERE id != $1 ORDER BY username ASC',
    [req.user.id]
  );
  res.json(result.rows);
});

router.get('/me', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT id, username, avatar_data, public_key FROM users WHERE id = $1', [req.user.id]);
  res.json(result.rows[0]);
});

// Publishes this device's E2E public key. The matching private key never
// leaves the browser — the server only ever stores/sees this public half.
router.put('/me/public-key', requireAuth, async (req, res) => {
  const { publicKey } = req.body || {};
  if (typeof publicKey !== 'string' || publicKey.length < 20 || publicKey.length > 500) {
    return res.status(400).json({ error: 'Invalid public key' });
  }
  await pool.query('UPDATE users SET public_key = $1 WHERE id = $2', [publicKey, req.user.id]);
  res.json({ ok: true });
});

const AVATAR_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_AVATAR_BYTES = 350 * 1024; // the client resizes/compresses before sending; this is a hard backstop

router.put('/me/avatar', requireAuth, async (req, res) => {
  const { avatar } = req.body || {};

  if (avatar === null) {
    await pool.query('UPDATE users SET avatar_data = NULL WHERE id = $1', [req.user.id]);
    return res.json({ avatar_data: null });
  }

  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(avatar || '');
  if (typeof avatar !== 'string' || !AVATAR_DATA_URL_RE.test(avatar) || !match) {
    return res.status(400).json({ error: 'Avatar must be a PNG, JPEG, or WEBP image' });
  }
  if (avatar.length > MAX_AVATAR_BYTES) {
    return res.status(413).json({ error: 'Image is too large even after compression — try a smaller photo' });
  }

  // Avatars aren't secret, so no encryption needed — just store the plain
  // image bytes in Supabase (if configured) and keep the URL instead of
  // the base64 blob. Without Supabase set up yet, fall back to storing
  // the base64 data URL directly, same as before.
  let stored = avatar;
  if (supabase.enabled) {
    const [, ext, base64] = match;
    const buffer = Buffer.from(base64, 'base64');
    const path = `avatars/${req.user.id}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    try {
      stored = await supabase.uploadBuffer(buffer, path, `image/${ext}`);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }

  await pool.query('UPDATE users SET avatar_data = $1 WHERE id = $2', [stored, req.user.id]);
  res.json({ avatar_data: stored });
});

module.exports = router;
