// Web Push for Dropline, using only WebCrypto (no libraries).
// VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291).

const enc = new TextEncoder();
export const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const concat = (...arrs) => { const n = arrs.reduce((a, b) => a + b.length, 0), out = new Uint8Array(n); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// ---- VAPID keys (generated once, stored in D1 settings) ----
export async function getVapid(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'vapid'").first();
  if (row) return JSON.parse(row.value);
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
  const v = { jwk, pub };
  await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid', ?)").bind(JSON.stringify(v)).run();
  // another request may have won the race; always return what is stored
  const stored = await db.prepare("SELECT value FROM settings WHERE key = 'vapid'").first();
  return JSON.parse(stored.value);
}

async function vapidAuth(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 3000, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', vapid.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapid.pub}`;
}

// ---- payload encryption (aes128gcm, single record) ----
export async function encryptPayload(p256dhB64, authB64, plaintext, _testKeys) {
  const uaPublic = unb64u(p256dhB64), authSecret = unb64u(authB64);
  const asKeys = _testKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));
  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data = concat(enc.encode(plaintext), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, data));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ct);
}

// Returns 'ok', 'gone' (subscription expired: delete it) or 'error'
export async function sendPush(sub, payload, vapid, subject) {
  const body = await encryptPayload(sub.p256dh, sub.auth, JSON.stringify(payload));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(sub.endpoint, vapid, subject),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: '43200', Urgency: payload.urgent ? 'high' : 'normal',
      ...(payload.tag ? { Topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
    },
    body,
  });
  if (res.status === 404 || res.status === 410) return 'gone';
  return res.ok ? 'ok' : 'error';
}
