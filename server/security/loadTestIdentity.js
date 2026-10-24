'use strict';

const { createHmac, timingSafeEqual } = require('crypto');
const TTL_SECONDS = 120;

function signature(payload, secret) {
  return createHmac('sha256', secret).update(`loadtest-v1:${payload}`).digest('base64url');
}

function signLoadTestIdentity(accountId, nickname, secret = process.env.NEXTAUTH_SECRET, now = Date.now()) {
  if (!secret) throw new Error('LOAD_TEST_SECRET_REQUIRED');
  const payload = Buffer.from(JSON.stringify({ accountId, nickname, exp: Math.floor(now / 1000) + TTL_SECONDS })).toString('base64url');
  return `${payload}.${signature(payload, secret)}`;
}

function verifyLoadTestIdentity(token, secret = process.env.NEXTAUTH_SECRET, now = Date.now()) {
  if (!secret || typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = Buffer.from(signature(parts[0], secret));
  const supplied = Buffer.from(parts[1]);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const seconds = Math.floor(now / 1000);
    if (!Number.isInteger(value.exp) || value.exp <= seconds || value.exp > seconds + TTL_SECONDS) return null;
    if (typeof value.accountId !== 'string' || !/^bot_load_[A-Za-z0-9_-]{1,100}$/.test(value.accountId)) return null;
    if (typeof value.nickname !== 'string' || value.nickname.length < 2 || value.nickname.length > 12) return null;
    return { accountId: value.accountId, nickname: value.nickname, isBot: true, isLoadTest: true };
  } catch {
    return null;
  }
}

function allowedLoadTestTarget(value, env = process.env) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return false;
    const origins = [env.NEXTAUTH_URL, ...(env.LOAD_TEST_ALLOWED_ORIGINS || '').split(','),
      `http://localhost:${env.PORT || 3000}`, `http://127.0.0.1:${env.PORT || 3000}`];
    return origins.filter(Boolean).some(origin => {
      try { return new URL(origin.trim()).origin === url.origin; } catch { return false; }
    });
  } catch { return false; }
}

module.exports = { signLoadTestIdentity, verifyLoadTestIdentity, allowedLoadTestTarget };
