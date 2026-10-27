const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// conversation history with one other user
router.get('/:otherId', requireAuth, async (req, res) => {
  const otherId = parseInt(req.params.otherId, 10);
  if (!Number.isInteger(otherId)) return res.status(400).json({ error: 'Invalid user id' });

  const clearedRes = await pool.query(
    'SELECT cleared_at FROM dm_cleared WHERE user_id = $1 AND peer_id = $2',
    [req.user.id, otherId]
  );
  const clearedAt = clearedRes.rows[0] ? clearedRes.rows[0].cleared_at : null;

  const result = await pool.query(
    `SELECT m.id, m.sender_id, m.receiver_id, m.body, m.created_at, m.read, m.deleted, m.edited_at
     FROM messages m
     WHERE ((m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1))
       AND ($3::timestamptz IS NULL OR m.created_at > $3)
       AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = $1)
     ORDER BY m.created_at ASC
     LIMIT 200`,
    [req.user.id, otherId, clearedAt]
  );

  await pool.query(
    'UPDATE messages SET read = true WHERE sender_id = $1 AND receiver_id = $2 AND read = false',
    [otherId, req.user.id]
  );

  res.json(result.rows);
});

// "Delete chat for me" — clears this conversation from my own view; the
// other person's copy is untouched, and new messages after this point
// show up normally.
router.delete('/chat/:otherId', requireAuth, async (req, res) => {
  const otherId = parseInt(req.params.otherId, 10);
  if (!Number.isInteger(otherId)) return res.status(400).json({ error: 'Invalid user id' });

  await pool.query(
    `INSERT INTO dm_cleared (user_id, peer_id, cleared_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id, peer_id) DO UPDATE SET cleared_at = now()`,
    [req.user.id, otherId]
  );
  res.json({ ok: true });
});

// "Delete for me" — hides a single message from only my own view.
router.delete('/:id/for-me', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid message id' });

  await pool.query(
    'INSERT INTO message_hidden (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [id, req.user.id]
  );
  res.json({ ok: true });
});

module.exports = router;
