const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_data TEXT,
      public_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS public_key TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS groups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      restricted BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS restricted BOOLEAN NOT NULL DEFAULT false;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_admin BOOLEAN NOT NULL DEFAULT false,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (group_id, user_id)
    );
  `);
  await pool.query(`ALTER TABLE group_members ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;`);

  // one row per member: the group's symmetric AES key, encrypted (ECDH-wrapped)
  // so only that member can unwrap it with their own private key. The server
  // never sees the raw key.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_keys (
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      wrapped_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      wrapped_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (group_id, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      read BOOLEAN NOT NULL DEFAULT false,
      deleted BOOLEAN NOT NULL DEFAULT false,
      edited_at TIMESTAMPTZ
    );
  `);
  // these two run every boot for upgrading a database created before groups existed
  await pool.query(`ALTER TABLE messages ALTER COLUMN receiver_id DROP NOT NULL;`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE;`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_hidden (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (message_id, user_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dm_cleared (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      peer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cleared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, peer_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_cleared (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      cleared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, group_id)
    );
  `);

  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE messages ADD CONSTRAINT messages_target_check CHECK (
        (receiver_id IS NOT NULL AND group_id IS NULL) OR (receiver_id IS NULL AND group_id IS NOT NULL)
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_pair
    ON messages (sender_id, receiver_id, created_at);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_group
    ON messages (group_id, created_at);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_group_members_user
    ON group_members (user_id);
  `);
}

module.exports = { pool, init };
