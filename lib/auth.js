'use strict';
// Password hashing (scrypt), sessions and a small login rate limiter.

const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Used to spend the same time when the username does not exist.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Simple in-memory limiter: max `max` failures per key within `windowMs`. */
class FailLimiter {
  constructor(max = 10, windowMs = 15 * 60 * 1000) {
    this.max = max;
    this.windowMs = windowMs;
    this.map = new Map();
  }
  blocked(key) {
    const e = this.map.get(key);
    if (!e) return false;
    if (Date.now() - e.first > this.windowMs) { this.map.delete(key); return false; }
    return e.count >= this.max;
  }
  fail(key) {
    const now = Date.now();
    const e = this.map.get(key);
    if (!e || now - e.first > this.windowMs) this.map.set(key, { first: now, count: 1 });
    else e.count++;
    if (this.map.size > 10000) this.map.clear();
  }
  reset(key) { this.map.delete(key); }
}

module.exports = { hashPassword, verifyPassword, DUMMY_HASH, sha256, newToken, FailLimiter };
