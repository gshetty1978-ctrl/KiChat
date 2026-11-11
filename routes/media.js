const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const supabase = require('../supabase');

const router = express.Router();

const MAX_CT_BYTES = 1.4 * 1024 * 1024; // matches the old inline-storage cap

// `ct` is opaque AES-GCM ciphertext (base64), encrypted client-side with
// the same key used for text messages — the server decodes it to raw
// bytes and stores it as-is. It never sees plaintext, so E2E holds.
router.post('/upload', requireAuth, async (req, res) => {
  if (!supabase.enabled) {
    return res.status(503).json({ error: 'Media storage is not configured' });
  }

  const { ct } = req.body || {};
  if (typeof ct !== 'string' || !ct) return res.status(400).json({ error: 'Missing ciphertext' });

  let buffer;
  try {
    buffer = Buffer.from(ct, 'base64');
  } catch (e) {
    return res.status(400).json({ error: 'Invalid ciphertext encoding' });
  }
  if (buffer.length === 0 || buffer.length > MAX_CT_BYTES) {
    return res.status(413).json({ error: 'Image is too large' });
  }

  const path = `${req.user.id}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.bin`;
  try {
    const url = await supabase.uploadBuffer(buffer, path, 'application/octet-stream');
    res.json({ url });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
