const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// directory of everyone else you can message
router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT id, username, avatar_data FROM users WHERE id != $1 ORDER BY username ASC',
    [req.user.id]
  );
  res.json(result.rows);
});

router.get('/me', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT id, username, avatar_data FROM users WHERE id = $1', [req.user.id]);
  res.json(result.rows[0]);
});

const AVATAR_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_AVATAR_BYTES = 350 * 1024; // the client resizes/compresses before sending; this is a hard backstop

router.put('/me/avatar', requireAuth, async (req, res) => {
  const { avatar } = req.body || {};

  if (avatar === null) {
    await pool.query('UPDATE users SET avatar_data = NULL WHERE id = $1', [req.user.id]);
    return res.json({ avatar_data: null });
  }

  if (typeof avatar !== 'string' || !AVATAR_DATA_URL_RE.test(avatar)) {
    return res.status(400).json({ error: 'Avatar must be a PNG, JPEG, or WEBP image' });
  }
  if (avatar.length > MAX_AVATAR_BYTES) {
    return res.status(413).json({ error: 'Image is too large even after compression — try a smaller photo' });
  }

  await pool.query('UPDATE users SET avatar_data = $1 WHERE id = $2', [avatar, req.user.id]);
  res.json({ avatar_data: avatar });
});

module.exports = router;
