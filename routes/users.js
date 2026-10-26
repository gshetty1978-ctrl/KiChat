const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// directory of everyone else you can message
router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT id, username FROM users WHERE id != $1 ORDER BY username ASC',
    [req.user.id]
  );
  res.json(result.rows);
});

router.get('/me', requireAuth, async (req, res) => {
  res.json({ id: req.user.id, username: req.user.username });
});

module.exports = router;
