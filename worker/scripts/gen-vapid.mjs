#!/usr/bin/env node
/* Generate a VAPID keypair for Web Push and print the wrangler secret commands.
 *
 *   node scripts/gen-vapid.mjs
 *
 * VAPID_PUBLIC_KEY  — base64url of the uncompressed P-256 point (65 bytes).
 *                     The browser uses this as applicationServerKey; the Worker
 *                     sends it in the Authorization "k=" param.
 * VAPID_PRIVATE_JWK — the private key as a JWK (JSON). The Worker imports it to
 *                     sign the VAPID JWT. Keep it secret.
 */
import { webcrypto as crypto } from 'node:crypto';

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)); // 65-byte uncompressed point
const privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);

const VAPID_PUBLIC_KEY = b64url(pubRaw);
const VAPID_PRIVATE_JWK = JSON.stringify({ kty: privJwk.kty, crv: privJwk.crv, x: privJwk.x, y: privJwk.y, d: privJwk.d });

console.log('\n=== Rainier Spark · VAPID keys ===\n');
console.log('VAPID_PUBLIC_KEY (also used by the browser as applicationServerKey):');
console.log('  ' + VAPID_PUBLIC_KEY + '\n');
console.log('Set the Worker secrets (run from the worker/ directory):\n');
console.log(`  printf %s '${VAPID_PUBLIC_KEY}' | npx wrangler secret put VAPID_PUBLIC_KEY`);
console.log(`  printf %s '${VAPID_PRIVATE_JWK}' | npx wrangler secret put VAPID_PRIVATE_JWK`);
console.log(`  printf %s 'mailto:62AW.Rainier.Spark@us.af.mil' | npx wrangler secret put VAPID_SUBJECT`);
console.log('\nThe public key is served automatically at GET /push/vapid — the frontend');
console.log('reads it there, so you do NOT need to paste it into index.html.\n');
