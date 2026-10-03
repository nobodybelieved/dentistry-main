// ─── Response helpers ─────────────────────────────────────────────────────────

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const error = (msg, status = 400, code) =>
  json({ error: msg, ...(code && { code }) }, status);

// ─── Auth guards ──────────────────────────────────────────────────────────────

const ROLE_RANK = { owner: 5, manager: 4, admin: 3, doctor: 2, hygienist: 2, assistant: 1 };

export function withAuth(handler) {
  return async (req, env, ctx, params) => {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return error('Unauthorized', 401);

    try {
      const payload = await verifyJWT(token, env.JWT_SECRET);
      req.user = payload;
      return handler(req, env, ctx, params);
    } catch {
      return error('Invalid token', 401);
    }
  };
}

export function withRole(minRole) {
  return (handler) =>
    withAuth(async (req, env, ctx, params) => {
      const userRank = ROLE_RANK[req.user?.role] ?? 0;
      const minRank  = ROLE_RANK[minRole] ?? 99;
      if (userRank < minRank) return error('Forbidden', 403);
      return handler(req, env, ctx, params);
    });
}

// ─── JWT (HS256, Web Crypto API — работает в CF Workers) ─────────────────────

const ENC = new TextEncoder();

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', ENC.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify']
  );
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlDecode(s) {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
}

export async function signJWT(payload, secret, ttlHours = 48) {
  const header = b64url(ENC.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body   = b64url(ENC.encode(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlHours * 3600,
  })));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, ENC.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

export async function verifyJWT(token, secret) {
  const [header, body, sig] = token.split('.');
  if (!header || !body || !sig) throw new Error('malformed');
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC', key,
    Uint8Array.from(b64urlDecode(sig), c => c.charCodeAt(0)),
    ENC.encode(`${header}.${body}`)
  );
  if (!valid) throw new Error('invalid signature');
  const payload = JSON.parse(b64urlDecode(body));
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('expired');
  return payload;
}

// ─── bcrypt (через Web Crypto: PBKDF2 — реализация для CF Workers) ───────────
// Используем PBKDF2 вместо bcrypt (bcrypt недоступен в V8 isolate без wasm)
// Формат хэша: pbkdf2$<iterations>$<salt_hex>$<hash_hex>

export async function hashPassword(password, iterations = 100_000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', ENC.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyMaterial, 256
  );
  const saltHex = [...salt].map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2$${iterations}$${saltHex}$${hashHex}`;
}

export async function verifyPassword(password, stored) {
  const [, iterations, saltHex, hashHex] = stored.split('$');
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const keyMaterial = await crypto.subtle.importKey('raw', ENC.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: parseInt(iterations), hash: 'SHA-256' }, keyMaterial, 256
  );
  const candidate = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return candidate === hashHex;
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────

export const uid = () => crypto.randomUUID();
export const now = () => Date.now();
export const today = () => new Date().toISOString().slice(0, 10);
