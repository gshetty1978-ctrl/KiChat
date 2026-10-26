const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// conversation history with one other user
router.get('/:otherId', requireAuth, async (req, res) => {
  const otherId = parseInt(req.params.otherId, 10);
  if (!Number.isInteger(otherId)) return res.status(400).json({ error: 'Invalid user id' });

  const result = await pool.query(
    `SELECT id, sender_id, receiver_id, body, created_at, read
     FROM messages
     WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
     ORDER BY created_at ASC
     LIMIT 200`,
    [req.user.id, otherId]
  );

  await pool.query(
    'UPDATE messages SET read = true WHERE sender_id = $1 AND receiver_id = $2 AND read = false',
    [otherId, req.user.id]
  );

  res.json(result.rows);
});

module.exports = router;
