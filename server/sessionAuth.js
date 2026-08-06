import crypto from 'node:crypto';

const TOKEN_VERSION = 1;
const DEFAULT_TTL_SECONDS = 60 * 60;

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(encodedPayload, secret) {
  return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

export function createAppSessionToken(userId, secret, options = {}) {
  if (typeof userId !== 'string' || !userId || typeof secret !== 'string' || !secret) {
    throw new TypeError('userId and secret are required');
  }
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const ttlSeconds = Number.isFinite(options.ttlSeconds)
    ? Math.max(60, Math.floor(options.ttlSeconds))
    : DEFAULT_TTL_SECONDS;
  const payload = {
    v: TOKEN_VERSION,
    sub: userId,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
  const encodedPayload = encode(JSON.stringify(payload));
  return {
    token: `${encodedPayload}.${sign(encodedPayload, secret)}`,
    expiresAt: payload.exp * 1000,
  };
}

export function verifyAppSessionToken(token, secret, options = {}) {
  if (typeof token !== 'string' || typeof secret !== 'string' || !secret) return null;
  const [encodedPayload, signature, extra] = token.split('.');
  if (!encodedPayload || !signature || extra) return null;

  const expected = sign(encodedPayload, secret);
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    receivedBuffer.length !== expectedBuffer.length
    || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  ) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    if (
      payload?.v !== TOKEN_VERSION
      || typeof payload.sub !== 'string'
      || !payload.sub
      || !Number.isInteger(payload.exp)
      || payload.exp * 1000 <= now
    ) return null;
    return payload;
  } catch {
    return null;
  }
}

export function getBearerToken(req) {
  const header = req?.headers?.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function secureTokenEquals(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string' || !expected) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}
