const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

async function membership(groupId, userId) {
  const r = await pool.query(
    'SELECT is_admin FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return r.rows[0] || null; // null = not a member
}

async function membersOf(groupId) {
  const r = await pool.query(
    `SELECT u.id, u.username, u.avatar_data, u.public_key, gm.is_admin FROM group_members gm
     JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = $1
     ORDER BY u.username ASC`,
    [groupId]
  );
  return r.rows;
}

// the requesting user's own wrapped copy of the group's E2E key, plus
// whose public key it was wrapped with (always the creator's)
async function myKeyFor(groupId, userId) {
  const r = await pool.query(
    'SELECT wrapped_key, iv, wrapped_by FROM group_keys WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return r.rows[0] || null;
}

async function fullGroup(groupId, forUserId) {
  const r = await pool.query('SELECT id, name, created_by, restricted, created_at FROM groups WHERE id = $1', [groupId]);
  const group = r.rows[0];
  if (!group) return null;
  group.members = await membersOf(groupId);
  if (forUserId) group.myKey = await myKeyFor(groupId, forUserId);
  return group;
}

// groups the current user belongs to
router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT g.id FROM groups g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.user_id = $1
     ORDER BY g.created_at DESC`,
    [req.user.id]
  );
  const groups = await Promise.all(result.rows.map((g) => fullGroup(g.id, req.user.id)));
  res.json(groups);
});

// create a group: { name, memberIds, wrappedKeys: [{userId, wrappedKey, iv}] }
// wrappedKeys is the group's E2E key, pre-encrypted client-side once per
// member (including the creator) with that member's public key — the
// server stores only these encrypted copies, never the raw key.
router.post('/', requireAuth, async (req, res) => {
  const { name, memberIds, wrappedKeys } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Group name is required' });
  }
  if (!Array.isArray(memberIds) || memberIds.some((id) => !Number.isInteger(id))) {
    return res.status(400).json({ error: 'memberIds must be a list of user ids' });
  }
  if (!Array.isArray(wrappedKeys) || wrappedKeys.some((w) => !w || !Number.isInteger(w.userId) || typeof w.wrappedKey !== 'string' || typeof w.iv !== 'string')) {
    return res.status(400).json({ error: 'wrappedKeys is required (client-side encryption did not run)' });
  }

  const ids = [...new Set([req.user.id, ...memberIds])];
  if (ids.length < 2) {
    return res.status(400).json({ error: 'Pick at least one other person for the group' });
  }
  const wrappedByUser = new Map(wrappedKeys.map((w) => [w.userId, w]));
  if (!ids.every((id) => wrappedByUser.has(id))) {
    return res.status(400).json({ error: 'Missing an encrypted key for one of the members' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const groupResult = await client.query(
      'INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING id',
      [name.trim().slice(0, 60), req.user.id]
    );
    const groupId = groupResult.rows[0].id;

    for (const id of ids) {
      await client.query(
        'INSERT INTO group_members (group_id, user_id, is_admin) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [groupId, id, id === req.user.id]
      );
      const w = wrappedByUser.get(id);
      await client.query(
        'INSERT INTO group_keys (group_id, user_id, wrapped_key, iv, wrapped_by) VALUES ($1, $2, $3, $4, $5)',
        [groupId, id, w.wrappedKey, w.iv, req.user.id]
      );
    }
    await client.query('COMMIT');

    const group = await fullGroup(groupId, req.user.id);
    req.app.get('notifyGroupCreated')(group, ids);
    res.json(group);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// a single group, scoped with the requester's own wrapped key (myKey) —
// used after group:new / group:updated socket events so each client
// gets ITS OWN encrypted key copy, never anyone else's
router.get('/:id', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'Invalid group id' });
  if (!(await membership(groupId, req.user.id))) return res.status(403).json({ error: 'Not a member of this group' });
  res.json(await fullGroup(groupId, req.user.id));
});

router.get('/:id/members', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'Invalid group id' });
  if (!(await membership(groupId, req.user.id))) return res.status(403).json({ error: 'Not a member of this group' });
  res.json(await membersOf(groupId));
});

router.get('/:id/messages', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'Invalid group id' });
  if (!(await membership(groupId, req.user.id))) return res.status(403).json({ error: 'Not a member of this group' });

  const clearedRes = await pool.query(
    'SELECT cleared_at FROM group_cleared WHERE user_id = $1 AND group_id = $2',
    [req.user.id, groupId]
  );
  const clearedAt = clearedRes.rows[0] ? clearedRes.rows[0].cleared_at : null;

  const result = await pool.query(
    `SELECT m.id, m.sender_id, m.group_id, m.body, m.created_at, m.deleted, m.edited_at
     FROM messages m
     WHERE m.group_id = $1
       AND ($2::timestamptz IS NULL OR m.created_at > $2)
       AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = $3)
     ORDER BY m.created_at ASC
     LIMIT 200`,
    [groupId, clearedAt, req.user.id]
  );
  res.json(result.rows);
});

// "Delete chat for me" — clears this group from my own view only.
router.delete('/:id/clear', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'Invalid group id' });
  if (!(await membership(groupId, req.user.id))) return res.status(403).json({ error: 'Not a member of this group' });

  await pool.query(
    `INSERT INTO group_cleared (user_id, group_id, cleared_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id, group_id) DO UPDATE SET cleared_at = now()`,
    [req.user.id, groupId]
  );
  res.json({ ok: true });
});

// { restricted: boolean } - admin only
router.patch('/:id/settings', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'Invalid group id' });

  const me = await membership(groupId, req.user.id);
  if (!me) return res.status(403).json({ error: 'Not a member of this group' });
  if (!me.is_admin) return res.status(403).json({ error: 'Only admins can change group settings' });

  const { restricted } = req.body || {};
  if (typeof restricted !== 'boolean') return res.status(400).json({ error: 'restricted must be true or false' });

  await pool.query('UPDATE groups SET restricted = $1 WHERE id = $2', [restricted, groupId]);
  req.app.get('notifyGroupUpdated')(await fullGroup(groupId));
  res.json(await fullGroup(groupId, req.user.id));
});

// { userId } - promotes a member to admin; admin only
router.post('/:id/admins', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'Invalid group id' });

  const me = await membership(groupId, req.user.id);
  if (!me) return res.status(403).json({ error: 'Not a member of this group' });
  if (!me.is_admin) return res.status(403).json({ error: 'Only admins can add other admins' });

  const { userId } = req.body || {};
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'userId is required' });

  const target = await membership(groupId, userId);
  if (!target) return res.status(400).json({ error: 'That person is not a member of this group' });

  await pool.query('UPDATE group_members SET is_admin = true WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
  req.app.get('notifyGroupUpdated')(await fullGroup(groupId));
  res.json(await fullGroup(groupId, req.user.id));
});

module.exports = router;
