'use strict';
// Small HTTP helpers: JSON responses, body reading, cookies, static files.

const fs = require('node:fs');
const path = require('node:path');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const APP_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'",
};

function json(res, status, body, extraHeaders = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(data);
}

function text(res, status, body, extraHeaders = {}) {
  const data = Buffer.from(String(body));
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': data.length,
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(data);
}

/**
 * Read the whole request body into a Buffer, up to `limit` bytes.
 * Bodies over the limit are drained (so the client can read the 413) and rejected.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let tooBig = Number.isFinite(declared) && declared > limit;
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) tooBig = true;
      if (tooBig) {
        chunks.length = 0;
        // Hard stop for absurd bodies
        if (total > limit * 2 + 16 * 1024 * 1024) req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) return reject(new HttpError(413, `ไฟล์ใหญ่เกินกำหนด (สูงสุด ${formatMB(limit)})`));
      resolve(Buffer.concat(chunks, total));
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new HttpError(400, 'การอัปโหลดถูกยกเลิก')));
  });
}

function formatMB(bytes) {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

async function readJson(req) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.startsWith('application/json')) throw new HttpError(415, 'ต้องส่งข้อมูลเป็น JSON');
  const buf = await readBody(req, 64 * 1024);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
    return v;
  } catch {
    throw new HttpError(400, 'ข้อมูล JSON ไม่ถูกต้อง');
  }
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) {
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  }
  return out;
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/** Serve "/" as index.html and "/assets/<file>" from the public folder. */
function serveStatic(req, res, publicDir, pathname) {
  let rel;
  if (pathname === '/' || pathname === '/index.html') rel = 'index.html';
  else if (pathname.startsWith('/assets/')) rel = pathname.slice('/assets/'.length);
  else if (pathname === '/favicon.ico' || pathname === '/favicon.svg') rel = 'favicon.svg';
  else return text(res, 404, 'Not found');

  if (!/^[A-Za-z0-9._-]+$/.test(rel) || rel.startsWith('.')) return text(res, 404, 'Not found');
  const abs = path.join(publicDir, rel);
  let stat;
  try {
    stat = fs.statSync(abs);
    if (!stat.isFile()) throw new Error('not file');
  } catch {
    return text(res, 404, 'Not found');
  }
  const type = STATIC_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    ...APP_SECURITY_HEADERS,
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
}

module.exports = { HttpError, json, text, readBody, readJson, parseCookies, serveStatic, formatMB };
