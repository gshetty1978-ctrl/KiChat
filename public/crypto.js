// ── end-to-end encryption ────────────────────────────────────────────────
// Every message's content is encrypted in THIS browser before it ever
// leaves it, and decrypted only in the recipient's browser. The server
// stores and relays ciphertext — it has no way to read message content.
//
// How it works:
//  - Each device generates an ECDH (P-256) key pair the first time it's
//    used. The private key never leaves this browser (localStorage only).
//    The public key is uploaded to the server so others can use it.
//  - For a direct message, the two people's ECDH keys derive a shared
//    AES-256-GCM key (only the two of them can compute it). That key
//    encrypts every message in that conversation.
//  - For a group, the creator generates one random AES-256-GCM key for
//    the whole group, then "wraps" (encrypts) a copy of it for each
//    member individually using that same ECDH derivation — so each
//    member can unwrap their own copy with their own private key, but
//    the server only ever stores encrypted copies of the key.
//
// Limitation: the private key lives only in this browser's storage. A
// new device/browser (or cleared site data) means a fresh key pair and
// no way to decrypt that account's older messages on it — the same
// trade-off real E2E apps make without a cloud key-backup feature.

const E2E_CURVE = 'P-256';
const LS_PRIVATE_KEY = 'kichat_e2e_private_jwk';
const LS_PUBLIC_KEY = 'kichat_e2e_public_b64';

let myKeyPair = null; // { privateKey, publicKeyB64 }
const sharedKeyCache = new Map(); // peerPublicKeyB64 -> CryptoKey

function bufToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64ToBuf(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

async function ensureIdentity() {
  if (myKeyPair) return myKeyPair;

  let privateJwk = null;
  let publicB64 = null;
  try {
    const stored = localStorage.getItem(LS_PRIVATE_KEY);
    if (stored) privateJwk = JSON.parse(stored);
    publicB64 = localStorage.getItem(LS_PUBLIC_KEY);
  } catch (e) {}

  if (privateJwk && publicB64) {
    const privateKey = await crypto.subtle.importKey(
      'jwk', privateJwk, { name: 'ECDH', namedCurve: E2E_CURVE }, true, ['deriveKey', 'deriveBits']
    );
    myKeyPair = { privateKey, publicKeyB64: publicB64 };
    return myKeyPair;
  }

  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: E2E_CURVE }, true, ['deriveKey', 'deriveBits']
  );
  const exportedPrivate = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const exportedPublic = await crypto.subtle.exportKey('raw', pair.publicKey);
  const newPublicB64 = bufToB64(exportedPublic);

  try {
    localStorage.setItem(LS_PRIVATE_KEY, JSON.stringify(exportedPrivate));
    localStorage.setItem(LS_PUBLIC_KEY, newPublicB64);
  } catch (e) {}

  myKeyPair = { privateKey: pair.privateKey, publicKeyB64: newPublicB64 };
  return myKeyPair;
}

async function importPeerPublicKey(peerPublicKeyB64) {
  return crypto.subtle.importKey(
    'raw', b64ToBuf(peerPublicKeyB64), { name: 'ECDH', namedCurve: E2E_CURVE }, false, []
  );
}

// The AES key two people (or a member + a group creator) share, derived
// from "my private key" + "their public key" — ECDH guarantees this is
// the same value no matter which side computes it.
async function deriveSharedKey(peerPublicKeyB64) {
  if (sharedKeyCache.has(peerPublicKeyB64)) return sharedKeyCache.get(peerPublicKeyB64);

  const identity = await ensureIdentity();
  const peerKey = await importPeerPublicKey(peerPublicKeyB64);
  const sharedKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerKey },
    identity.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  sharedKeyCache.set(peerPublicKeyB64, sharedKey);
  return sharedKey;
}

async function aesEncrypt(aesKey, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoded);
  return { ct: bufToB64(ctBuf), iv: bufToB64(iv) };
}
async function aesDecrypt(aesKey, ctB64, ivB64) {
  const ptBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(ivB64)) }, aesKey, b64ToBuf(ctB64)
  );
  return new TextDecoder().decode(ptBuf);
}

// ── direct messages ──────────────────────────────────────────────────────
async function encryptForPeer(peerPublicKeyB64, plaintext) {
  const key = await deriveSharedKey(peerPublicKeyB64);
  return aesEncrypt(key, plaintext);
}
async function decryptFromPeer(peerPublicKeyB64, ctB64, ivB64) {
  const key = await deriveSharedKey(peerPublicKeyB64);
  return aesDecrypt(key, ctB64, ivB64);
}

// ── groups ───────────────────────────────────────────────────────────────
// Called once, by whoever creates the group: makes the group's own AES
// key, then wraps (encrypts) a copy for every chosen member, including
// the creator. Returns the per-member wrapped copies to upload — the
// raw key itself is never sent anywhere.
async function createGroupKeyBundle(memberPublicKeys) {
  // memberPublicKeys: [{ userId, publicKeyB64 }]
  const groupKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawGroupKey = await crypto.subtle.exportKey('raw', groupKey);
  const rawB64 = bufToB64(rawGroupKey);

  const wrapped = [];
  for (const m of memberPublicKeys) {
    const sharedKey = await deriveSharedKey(m.publicKeyB64);
    const { ct, iv } = await aesEncrypt(sharedKey, rawB64);
    wrapped.push({ userId: m.userId, wrappedKey: ct, iv });
  }
  return { groupKey, wrapped };
}

// Unwraps my copy of a group's key using the creator's public key.
async function unwrapGroupKey(wrappedKeyB64, ivB64, wrapperPublicKeyB64) {
  const sharedKey = await deriveSharedKey(wrapperPublicKeyB64);
  const rawB64 = await aesDecrypt(sharedKey, wrappedKeyB64, ivB64);
  return crypto.subtle.importKey('raw', b64ToBuf(rawB64), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encryptForGroup(groupKey, plaintext) {
  return aesEncrypt(groupKey, plaintext);
}
async function decryptFromGroup(groupKey, ctB64, ivB64) {
  return aesDecrypt(groupKey, ctB64, ivB64);
}

async function getMyPublicKeyB64() {
  const identity = await ensureIdentity();
  return identity.publicKeyB64;
}
