const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { signToken } = require('../middleware/auth');
const { isGibberish } = require('../utils/gibberish');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

router.post('/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, underscore' });
  }
  if (isGibberish(username)) {
    return res.status(400).json({ error: 'Please pick a real username' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'That username is taken' });
  }

  const hash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
    [username, hash]
  );
  const user = result.rows[0];
  const token = signToken(user);
  res.json({ token, user });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const result = await pool.query('SELECT id, username, password_hash FROM users WHERE username = $1', [username]);
  const row = result.rows[0];
  if (!row) return res.status(401).json({ error: 'Invalid username or password' });

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

  const user = { id: row.id, username: row.username };
  const token = signToken(user);
  res.json({ token, user });
});

module.exports = router;
