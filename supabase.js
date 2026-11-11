const { createClient } = require('@supabase/supabase-js');

// Optional — until SUPABASE_URL/SUPABASE_SERVICE_KEY are set, `enabled` is
// false and every caller falls back to the old inline-in-Postgres storage,
// so nothing breaks before the keys are added.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'k1chat-media';

const enabled = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const client = enabled ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

// Uploads a buffer of opaque bytes (ciphertext for message media, or plain
// bytes for avatars) to the shared bucket and returns its public URL.
async function uploadBuffer(buffer, path, contentType) {
  const { error } = await client.storage.from(SUPABASE_BUCKET).upload(path, buffer, {
    contentType,
    upsert: false,
  });
  if (error) throw new Error('Supabase upload failed: ' + error.message);
  const { data } = client.storage.from(SUPABASE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

module.exports = { enabled, uploadBuffer };
