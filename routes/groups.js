const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

async function isMember(groupId, userId) {
  const r = await pool.query(
    'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return r.rows.length > 0;
}

async function membersOf(groupId) {
  const r = await pool.query(
    `SELECT u.id, u.username FROM group_members gm
     JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = $1
     ORDER BY u.username ASC`,
    [groupId]
  );
  return r.rows;
}

// groups the current user belongs to
router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT g.id, g.name, g.created_by, g.created_at
     FROM groups g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.user_id = $1
     ORDER BY g.created_at DESC`,
    [req.user.id]
  );
  const groups = await Promise.all(
    result.rows.map(async (g) => ({ ...g, members: await membersOf(g.id) }))
  );
  res.json(groups);
});

// create a group: { name, memberIds: [userId, ...] } - creator is added automatically
router.post('/', requireAuth, async (req, res) => {
  const { name, memberIds } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Group name is required' });
  }
  if (!Array.isArray(memberIds) || memberIds.some((id) => !Number.isInteger(id))) {
    return res.status(400).json({ error: 'memberIds must be a list of user ids' });
  }

  const ids = [...new Set([req.user.id, ...memberIds])];
  if (ids.length < 2) {
    return res.status(400).json({ error: 'Pick at least one other person for the group' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const groupResult = await client.query(
      'INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING id, name, created_by, created_at',
      [name.trim().slice(0, 60), req.user.id]
    );
    const group = groupResult.rows[0];

    for (const id of ids) {
      await client.query(
        'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [group.id, id]
      );
    }
    await client.query('COMMIT');

    group.members = await membersOf(group.id);
    req.app.get('notifyGroupCreated')(group, ids);
    res.json(group);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.get('/:id/members', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'Invalid group id' });
  if (!(await isMember(groupId, req.user.id))) return res.status(403).json({ error: 'Not a member of this group' });
  res.json(await membersOf(groupId));
});

router.get('/:id/messages', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'Invalid group id' });
  if (!(await isMember(groupId, req.user.id))) return res.status(403).json({ error: 'Not a member of this group' });

  const result = await pool.query(
    `SELECT id, sender_id, group_id, body, created_at
     FROM messages WHERE group_id = $1
     ORDER BY created_at ASC
     LIMIT 200`,
    [groupId]
  );
  res.json(result.rows);
});

module.exports = router;
