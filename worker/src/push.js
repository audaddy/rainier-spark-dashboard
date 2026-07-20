/* Web Push sender for Cloudflare Workers — RFC 8291 (aes128gcm payload
 * encryption) + RFC 8292 (VAPID). Uses only Web Crypto (no dependencies).
 *
 * sendPush(subscription, payload, env) → Response from the push service.
 * Callers should treat 404/410 as "subscription gone" and prune it.
 */

const enc = new TextEncoder();

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes) {
  let bin = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// HKDF(salt, ikm, info, len) via Web Crypto (extract + expand in one call).
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

// Build the VAPID Authorization header value for a given push endpoint.
async function vapidAuth(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const body = {
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  };
  const signingInput = bytesToB64url(enc.encode(JSON.stringify(header))) + '.' + bytesToB64url(enc.encode(JSON.stringify(body)));

  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput));
  const jwt = signingInput + '.' + bytesToB64url(new Uint8Array(sig));
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

// Encrypt `payload` for a subscription per RFC 8291 (aes128gcm, single record).
async function encryptPayload(subscription, payload) {
  const uaPublic = b64urlToBytes(subscription.keys.p256dh); // 65 bytes
  const authSecret = b64urlToBytes(subscription.keys.auth); // 16 bytes

  // Application-server ephemeral ECDH keypair.
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey)); // 65 bytes

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  // IKM = HKDF(auth_secret, ecdh, "WebPush: info\0" || ua_public || as_public, 32)
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Single record: plaintext followed by the 0x02 padding delimiter.
  const plaintext = concat(enc.encode(payload), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext));

  // aes128gcm content header: salt(16) | rs(4, uint32 BE) | idlen(1) | keyid(as_public)
  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096
  const idlen = new Uint8Array([asPublic.length]); // 65
  return concat(salt, rs, idlen, asPublic, ciphertext);
}

export async function sendPush(subscription, payload, env) {
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return new Response('invalid subscription', { status: 400 });
  }
  const body = await encryptPayload(subscription, payload);
  const auth = await vapidAuth(subscription.endpoint, env);
  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
    },
    body,
  });
}

// Exported for local round-trip testing of the encryption (see scripts/test-push.mjs).
export const _internal = { encryptPayload, hkdf, b64urlToBytes, bytesToB64url, concat };
