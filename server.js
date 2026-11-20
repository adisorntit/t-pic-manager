#!/usr/bin/env node
'use strict';
/*
 * T-Pic Manager — self-hosted image storage for LAN (and later, online) use.
 * Pure Node.js (>= 22.13), no npm packages. Database: built-in node:sqlite.
 *
 *   node server.js                              start the server
 *   node server.js reset-password <user> [pw]   reset a password (creates "admin" if missing)
 */

// node:sqlite prints an "experimental" warning on every start; hide only that kind.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w && w.name === 'ExperimentalWarning') return;
  console.warn(`${w.name}: ${w.message}`);
});

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const pkg = require('./package.json');
const { openDb, tx } = require('./lib/db');
const auth = require('./lib/auth');
const { detectImage } = require('./lib/imageinfo');
const H = require('./lib/http');
const { HttpError } = H;

// ---------------------------------------------------------------- config
const APP_NAME = 'T-Pic Manager';
const config = {
  port: toInt(process.env.PORT, 2681),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')),
  trustProxy: /^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY || ''),
  sessionDays: toInt(process.env.SESSION_DAYS, 7),
};
const PUBLIC_DIR = path.join(__dirname, 'public');
const IMAGES_DIR = path.join(config.dataDir, 'images');
const COOKIE = 'tpic_sid';
const DEFAULT_MAX_UPLOAD_MB = 10;

function toInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

fs.mkdirSync(IMAGES_DIR, { recursive: true });
const db = openDb(path.join(config.dataDir, 't-pic.db'));

const Q = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  countAdmins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
  insertUser: db.prepare(
    'INSERT INTO users (username, display_name, password_hash, role, must_change_pw, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  setPassword: db.prepare('UPDATE users SET password_hash = ?, must_change_pw = ? WHERE id = ?'),
  touchLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),
  sessionGet: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
  sessionInsert: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  sessionExtend: db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?'),
  sessionDelete: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  sessionDeleteUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  sessionDeleteUserExcept: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
  sessionPurge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  imageGet: db.prepare(
    `SELECT i.*, u.username AS u_username, u.display_name AS u_display
       FROM images i LEFT JOIN users u ON u.id = i.uploader_id WHERE i.id = ?`
  ),
  imageExists: db.prepare('SELECT 1 AS x FROM images WHERE id = ?'),
  imageInsert: db.prepare(
    `INSERT INTO images (id, name, ext, file, mime, size, width, height, uploader_id, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ),
  imageReplace: db.prepare(
    `UPDATE images SET file = ?, mime = ?, size = ?, width = ?, height = ?, version = version + 1, updated_at = ?
     WHERE id = ?`
  ),
  imageRename: db.prepare('UPDATE images SET name = ?, updated_at = ? WHERE id = ?'),
  imageDelete: db.prepare('DELETE FROM images WHERE id = ?'),
  imageStats: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM images'),
  settingGet: db.prepare('SELECT value FROM settings WHERE key = ?'),
  settingSet: db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ),
  uploaders: db.prepare(
    `SELECT u.id, u.username, u.display_name FROM users u
      WHERE EXISTS (SELECT 1 FROM images i WHERE i.uploader_id = u.id) ORDER BY u.username`
  ),
  usersList: db.prepare(
    `SELECT u.id, u.username, u.display_name, u.role, u.must_change_pw, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM images i WHERE i.uploader_id = u.id) AS image_count
       FROM users u ORDER BY u.role = 'admin' DESC, u.username`
  ),
};

// ---------------------------------------------------------------- CLI
if (process.argv[2] === 'backup-db') {
  // Consistent copy of the live database (safe while the server is running).
  const out = process.argv[3];
  if (!out) {
    console.error('ใช้งาน: node server.js backup-db <output-file>');
    process.exit(2);
  }
  db.exec(`VACUUM INTO '${path.resolve(out).replace(/'/g, "''")}'`);
  db.close();
  process.exit(0);
}

if (process.argv[2] === 'reset-password') {
  const username = process.argv[3];
  if (!username) {
    console.error('ใช้งาน: node server.js reset-password <username> [new-password]');
    process.exit(2);
  }
  const password = process.argv[4] || crypto.randomBytes(9).toString('base64url');
  let user = Q.userByName.get(username);
  if (!user && username === 'admin') {
    Q.insertUser.run('admin', 'ผู้ดูแลระบบ', auth.hashPassword(password), 'admin', 1, Date.now());
    console.log('สร้างผู้ใช้ admin ใหม่แล้ว');
  } else if (!user) {
    console.error(`ไม่พบผู้ใช้ "${username}"`);
    process.exit(1);
  } else {
    Q.setPassword.run(auth.hashPassword(password), 1, user.id);
    Q.sessionDeleteUser.run(user.id);
  }
  console.log(`รหัสผ่านใหม่ของ ${username}: ${password}`);
  console.log('ผู้ใช้จะถูกให้เปลี่ยนรหัสผ่านเมื่อเข้าสู่ระบบครั้งถัดไป');
  db.close();
  process.exit(0);
}

// ---------------------------------------------------------------- first run
if (Q.countUsers.get().n === 0) {
  Q.insertUser.run('admin', 'ผู้ดูแลระบบ', auth.hashPassword('admin'), 'admin', 1, Date.now());
  console.log('[setup] created default user admin / admin (must change password on first login)');
}

// ---------------------------------------------------------------- settings
function getSetting(key, def) {
  const r = Q.settingGet.get(key);
  return r ? r.value : def;
}
function maxUploadMB() {
  const n = Number(getSetting('max_upload_mb', DEFAULT_MAX_UPLOAD_MB));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_UPLOAD_MB;
}

function clientIp(req) {
  if (config.trustProxy) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || 'unknown';
}

function isHttps(req) {
  if (req.socket.encrypted) return true;
  return config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

/** Base URL used in copied links: the admin setting, else derived from the request. */
function baseUrl(req) {
  const fixed = getSetting('base_url', '');
  if (fixed) return fixed;
  let host = (config.trustProxy && String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()) || req.headers.host || '';
  if (!/^[A-Za-z0-9.\-:[\]]{1,255}$/.test(host)) host = `localhost:${config.port}`;
  return `${isHttps(req) ? 'https' : 'http'}://${host}`;
}

// ---------------------------------------------------------------- sessions
const DAY = 24 * 60 * 60 * 1000;
const loginLimiter = new auth.FailLimiter(10, 15 * 60 * 1000);

function currentSession(req) {
  const token = H.parseCookies(req)[COOKIE];
  if (!token || token.length > 100) return null;
  const hash = auth.sha256(token);
  const s = Q.sessionGet.get(hash);
  const now = Date.now();
  if (!s) return null;
  if (s.expires_at < now) {
    Q.sessionDelete.run(hash);
    return null;
  }
  const user = Q.userById.get(s.user_id);
  if (!user) return null;
  // Sliding expiry: extend at most once an hour.
  const fullExpiry = now + config.sessionDays * DAY;
  if (fullExpiry - s.expires_at > 60 * 60 * 1000) Q.sessionExtend.run(fullExpiry, hash);
  return { hash, user };
}

function sessionCookie(req, token, maxAgeSec) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}

setInterval(() => Q.sessionPurge.run(Date.now()), 60 * 60 * 1000).unref();
Q.sessionPurge.run(Date.now());

// ---------------------------------------------------------------- DTOs
function userDto(u) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    must_change_pw: !!u.must_change_pw,
  };
}

function canEdit(user, img) {
  return user.role === 'admin' || (img.uploader_id != null && img.uploader_id === user.id);
}

function imageDto(row, req, user) {
  return {
    id: row.id,
    name: row.name,
    ext: row.ext,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    uploader: row.uploader_id != null
      ? { id: row.uploader_id, username: row.u_username, display_name: row.u_display }
      : null,
    path: `/i/${row.id}.${row.ext}`,
    url: `${baseUrl(req)}/i/${row.id}.${row.ext}`,
    can_edit: canEdit(user, row),
  };
}

// ---------------------------------------------------------------- image files
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function newImageId() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const bytes = crypto.randomBytes(10);
    let id = '';
    for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
    if (!Q.imageExists.get(id)) return id;
  }
  throw new Error('could not allocate image id');
}

function storedPath(rel) {
  const abs = path.resolve(IMAGES_DIR, rel);
  if (!abs.startsWith(IMAGES_DIR + path.sep)) throw new Error('bad stored path');
  return abs;
}

function writeFileAtomic(abs, buf) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, buf, { mode: 0o640 });
  fs.renameSync(tmp, abs);
}

function removeQuietly(abs) {
  try { fs.unlinkSync(abs); } catch { /* already gone */ }
}

function cleanName(raw, fallbackExt) {
  let name = '';
  if (raw) {
    try { name = decodeURIComponent(String(raw)); } catch { name = String(raw); }
  }
  name = name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length > 200) name = name.slice(0, 200);
  return name || `image.${fallbackExt}`;
}

async function readImageUpload(req) {
  const limit = Math.round(maxUploadMB() * 1024 * 1024);
  const buf = await H.readBody(req, limit);
  if (!buf.length) throw new HttpError(400, 'ไม่ได้ส่งไฟล์มา');
  const info = detectImage(buf);
  if (!info) throw new HttpError(415, 'ไม่ใช่ไฟล์รูปภาพที่รองรับ (JPG, PNG, GIF, WebP)');
  return { buf, info };
}

// ---------------------------------------------------------------- public image route
const IMG_RE = /^\/i\/([a-z0-9]{6,32})(?:\.[a-z0-9]{2,5})?$/;

function serveImage(req, res, id) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Max-Age': '86400' });
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return H.text(res, 405, 'Method not allowed', cors);

  const row = Q.imageGet.get(id);
  if (!row) return H.text(res, 404, 'Image not found', cors);
  let abs, stat;
  try {
    abs = storedPath(row.file);
    stat = fs.statSync(abs);
  } catch {
    return H.text(res, 404, 'Image file missing', cors);
  }
  const etag = `"${row.id}-${row.version}-${stat.size}"`;
  const headers = {
    ...cors,
    'Content-Type': row.mime,
    // Revalidate every time (cheap 304) so a "replace" shows up right away everywhere it is embedded.
    'Cache-Control': 'public, no-cache',
    ETag: etag,
    'Last-Modified': new Date(row.updated_at).toUTCString(),
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

// ---------------------------------------------------------------- API
function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
  return ctx.user;
}
function requireReady(ctx) {
  const u = requireUser(ctx);
  if (u.must_change_pw) throw new HttpError(403, 'กรุณาเปลี่ยนรหัสผ่านก่อนใช้งาน');
  return u;
}
function requireAdmin(ctx) {
  const u = requireReady(ctx);
  if (u.role !== 'admin') throw new HttpError(403, 'เฉพาะผู้ดูแลระบบ (admin)');
  return u;
}

function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 200;
}

async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  // CSRF guard: every state-changing call must carry this header (forces a CORS preflight cross-site).
  if (method !== 'GET' && method !== 'HEAD' && req.headers['x-requested-with'] !== 't-pic') {
    throw new HttpError(403, 'คำขอไม่ถูกต้อง (missing X-Requested-With)');
  }

  const sess = currentSession(req);
  const ctx = { user: sess ? sess.user : null, sessionHash: sess ? sess.hash : null };
  let m;

  // ---- public info (login screen)
  if (p === '/api/info' && method === 'GET') {
    const n = Q.countUsers.get().n;
    const admin = Q.userByName.get('admin');
    return H.json(res, 200, {
      name: APP_NAME,
      version: pkg.version,
      setup_pending: n === 1 && !!admin && !!admin.must_change_pw && admin.last_login_at == null,
    });
  }

  // ---- auth
  if (p === '/api/login' && method === 'POST') {
    const ip = clientIp(req);
    if (loginLimiter.blocked(ip)) throw new HttpError(429, 'ลองเข้าสู่ระบบผิดหลายครั้งเกินไป กรุณารอ 15 นาที');
    const body = await H.readJson(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const user = username ? Q.userByName.get(username) : null;
    const ok = auth.verifyPassword(password, user ? user.password_hash : auth.DUMMY_HASH) && !!user;
    if (!ok) {
      loginLimiter.fail(ip);
      throw new HttpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    }
    loginLimiter.reset(ip);
    const token = auth.newToken();
    const now = Date.now();
    Q.sessionInsert.run(auth.sha256(token), user.id, now, now + config.sessionDays * DAY);
    Q.touchLogin.run(now, user.id);
    console.log(`[login] ${user.username} from ${ip}`);
    return H.json(res, 200, { user: userDto(user) }, {
      'Set-Cookie': sessionCookie(req, token, config.sessionDays * 86400),
    });
  }

  if (p === '/api/logout' && method === 'POST') {
    if (ctx.sessionHash) Q.sessionDelete.run(ctx.sessionHash);
    return H.json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  if (p === '/api/me' && method === 'GET') {
    const u = requireUser(ctx);
    return H.json(res, 200, { user: userDto(u) });
  }

  if (p === '/api/change-password' && method === 'POST') {
    const u = requireUser(ctx);
    const body = await H.readJson(req);
    if (!auth.verifyPassword(String(body.current || ''), u.password_hash)) {
      throw new HttpError(400, 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
    }
    if (!validPassword(body.new)) throw new HttpError(400, 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร');
    if (body.new === body.current) throw new HttpError(400, 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม');
    Q.setPassword.run(auth.hashPassword(body.new), 0, u.id);
    Q.sessionDeleteUserExcept.run(u.id, ctx.sessionHash);
    console.log(`[password] ${u.username} changed password`);
    return H.json(res, 200, { user: userDto(Q.userById.get(u.id)) });
  }

  // ---- settings
  if (p === '/api/settings' && method === 'GET') {
    const u = requireReady(ctx);
    const out = {
      base_url: getSetting('base_url', ''),
      effective_base_url: baseUrl(req),
      max_upload_mb: maxUploadMB(),
    };
    if (u.role === 'admin') {
      const st = Q.imageStats.get();
      out.data_dir = config.dataDir;
      out.image_count = st.n;
      out.image_bytes = st.bytes;
      try {
        const fsStat = fs.statfsSync(config.dataDir);
        out.disk_free = fsStat.bavail * fsStat.bsize;
        out.disk_total = fsStat.blocks * fsStat.bsize;
      } catch { /* not available */ }
    }
    return H.json(res, 200, out);
  }

  if (p === '/api/settings' && method === 'PUT') {
    const u = requireAdmin(ctx);
    const body = await H.readJson(req);
    if ('base_url' in body) {
      let v = String(body.base_url || '').trim().replace(/\/+$/, '');
      if (v && !/^https?:\/\/[A-Za-z0-9.\-:[\]]+(\/[A-Za-z0-9._~\-/]*)?$/.test(v)) {
        throw new HttpError(400, 'Base URL ต้องขึ้นต้นด้วย http:// หรือ https:// เช่น http://192.168.1.50:2681');
      }
      Q.settingSet.run('base_url', v);
    }
    if ('max_upload_mb' in body) {
      const n = Number(body.max_upload_mb);
      if (!Number.isFinite(n) || n < 1 || n > 500) throw new HttpError(400, 'ขนาดไฟล์สูงสุดต้องอยู่ระหว่าง 1–500 MB');
      Q.settingSet.run('max_upload_mb', String(Math.round(n)));
    }
    console.log(`[settings] updated by ${u.username}`);
    return H.json(res, 200, { ok: true });
  }

  // ---- images
  if (p === '/api/images' && method === 'GET') {
    const u = requireReady(ctx);
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const sort = url.searchParams.get('sort') || 'new';
    const uploader = toInt(url.searchParams.get('uploader'), 0);
    const limit = Math.min(toInt(url.searchParams.get('limit'), 40), 200);
    const page = toInt(url.searchParams.get('page'), 1);
    const ORDER = {
      new: 'i.created_at DESC',
      old: 'i.created_at ASC',
      name: 'i.name COLLATE NOCASE ASC',
      size: 'i.size DESC',
    };
    const order = ORDER[sort] || ORDER.new;
    const where = [];
    const params = [];
    if (q) {
      where.push("i.name LIKE ? ESCAPE '\\'");
      params.push(`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
    }
    if (uploader) {
      where.push('i.uploader_id = ?');
      params.push(uploader);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM images i ${w}`).get(...params).n;
    const pages = Math.max(1, Math.ceil(total / limit));
    const cur = Math.min(page, pages);
    const rows = db
      .prepare(
        `SELECT i.*, u.username AS u_username, u.display_name AS u_display
           FROM images i LEFT JOIN users u ON u.id = i.uploader_id
           ${w} ORDER BY ${order}, i.id LIMIT ? OFFSET ?`
      )
      .all(...params, limit, (cur - 1) * limit);
    const st = Q.imageStats.get();
    return H.json(res, 200, {
      items: rows.map((r) => imageDto(r, req, u)),
      total,
      page: cur,
      pages,
      stats: { count: st.n, bytes: st.bytes },
      uploaders: Q.uploaders.all().map((x) => ({ id: x.id, username: x.username, display_name: x.display_name })),
    });
  }

  if (p === '/api/images' && method === 'POST') {
    const u = requireReady(ctx);
    const { buf, info } = await readImageUpload(req);
    const id = newImageId();
    const rel = `${id.slice(0, 2)}/${id}.${info.ext}`;
    const name = cleanName(req.headers['x-filename'], info.ext);
    writeFileAtomic(storedPath(rel), buf);
    const now = Date.now();
    try {
      Q.imageInsert.run(id, name, info.ext, rel, info.mime, buf.length, info.width, info.height, u.id, now, now);
    } catch (e) {
      removeQuietly(storedPath(rel));
      throw e;
    }
    console.log(`[upload] ${u.username} ${id} "${name}" ${buf.length}B`);
    return H.json(res, 201, { image: imageDto(Q.imageGet.get(id), req, u) });
  }

  if ((m = /^\/api\/images\/([a-z0-9]{6,32})$/.exec(p))) {
    const id = m[1];
    const u = requireReady(ctx);
    const row = Q.imageGet.get(id);
    if (!row) throw new HttpError(404, 'ไม่พบรูปนี้');

    if (method === 'GET') return H.json(res, 200, { image: imageDto(row, req, u) });
    if (!canEdit(u, row)) throw new HttpError(403, 'แก้ไขหรือลบได้เฉพาะรูปของตัวเอง');

    if (method === 'PUT') {
      // Replace the picture, keep the same id and public link.
      const { buf, info } = await readImageUpload(req);
      const rel = `${id.slice(0, 2)}/${id}.${info.ext}`;
      writeFileAtomic(storedPath(rel), buf);
      Q.imageReplace.run(rel, info.mime, buf.length, info.width, info.height, Date.now(), id);
      if (rel !== row.file) removeQuietly(storedPath(row.file));
      console.log(`[replace] ${u.username} ${id} ${buf.length}B`);
      return H.json(res, 200, { image: imageDto(Q.imageGet.get(id), req, u) });
    }

    if (method === 'PATCH') {
      const body = await H.readJson(req);
      const name = cleanName(body.name, row.ext);
      Q.imageRename.run(name, Date.now(), id);
      return H.json(res, 200, { image: imageDto(Q.imageGet.get(id), req, u) });
    }

    if (method === 'DELETE') {
      Q.imageDelete.run(id);
      removeQuietly(storedPath(row.file));
      console.log(`[delete] ${u.username} ${id} "${row.name}"`);
      return H.json(res, 200, { ok: true });
    }
  }

  // ---- users (admin)
  if (p === '/api/users' && method === 'GET') {
    requireAdmin(ctx);
    return H.json(res, 200, {
      users: Q.usersList.all().map((x) => ({
        id: x.id,
        username: x.username,
        display_name: x.display_name,
        role: x.role,
        must_change_pw: !!x.must_change_pw,
        created_at: x.created_at,
        last_login_at: x.last_login_at,
        image_count: x.image_count,
      })),
    });
  }

  if (p === '/api/users' && method === 'POST') {
    const admin = requireAdmin(ctx);
    const body = await H.readJson(req);
    const username = String(body.username || '').trim();
    const displayName = String(body.display_name || '').trim().slice(0, 100);
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
      throw new HttpError(400, 'ชื่อผู้ใช้ต้องยาว 3–32 ตัว ใช้ได้เฉพาะ a-z, 0-9, . _ -');
    }
    if (!validPassword(body.password)) throw new HttpError(400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
    if (Q.userByName.get(username)) throw new HttpError(409, 'มีชื่อผู้ใช้นี้แล้ว');
    Q.insertUser.run(username, displayName, auth.hashPassword(body.password), role, 1, Date.now());
    console.log(`[users] ${admin.username} added ${username} (${role})`);
    return H.json(res, 201, { ok: true });
  }

  if ((m = /^\/api\/users\/(\d+)$/.exec(p))) {
    const admin = requireAdmin(ctx);
    const target = Q.userById.get(Number(m[1]));
    if (!target) throw new HttpError(404, 'ไม่พบผู้ใช้');

    if (method === 'PATCH') {
      const body = await H.readJson(req);
      tx(db, () => {
        if ('display_name' in body) {
          db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(
            String(body.display_name || '').trim().slice(0, 100), target.id
          );
        }
        if ('role' in body) {
          const role = body.role === 'admin' ? 'admin' : 'user';
          if (role !== target.role) {
            if (target.id === admin.id) throw new HttpError(400, 'ไม่สามารถเปลี่ยนสิทธิ์ของตัวเองได้');
            if (role === 'user' && Q.countAdmins.get().n <= 1) throw new HttpError(400, 'ต้องมี admin อย่างน้อย 1 คน');
            db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
          }
        }
        if ('password' in body) {
          if (!validPassword(body.password)) throw new HttpError(400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
          Q.setPassword.run(auth.hashPassword(body.password), 1, target.id);
          Q.sessionDeleteUser.run(target.id);
        }
      });
      console.log(`[users] ${admin.username} updated ${target.username}`);
      return H.json(res, 200, { ok: true });
    }

    if (method === 'DELETE') {
      if (target.id === admin.id) throw new HttpError(400, 'ไม่สามารถลบบัญชีของตัวเองได้');
      if (target.role === 'admin' && Q.countAdmins.get().n <= 1) throw new HttpError(400, 'ต้องมี admin อย่างน้อย 1 คน');
      db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
      console.log(`[users] ${admin.username} deleted ${target.username}`);
      return H.json(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, 'ไม่พบ API นี้');
}

// ---------------------------------------------------------------- server
async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return H.text(res, 400, 'Bad request');
  }
  const p = url.pathname;
  try {
    if (p === '/healthz') return H.json(res, 200, { ok: true, name: APP_NAME, version: pkg.version });
    const m = IMG_RE.exec(p);
    if (m) return serveImage(req, res, m[1]);
    if (p.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method === 'GET' || req.method === 'HEAD') return H.serveStatic(req, res, PUBLIC_DIR, p);
    return H.text(res, 405, 'Method not allowed');
  } catch (e) {
    if (res.headersSent) return res.destroy();
    if (e instanceof HttpError) {
      const extra = e.status === 413 ? { Connection: 'close' } : {};
      return H.json(res, e.status, { error: e.message }, extra);
    }
    console.error('[error]', req.method, p, e);
    return H.json(res, 500, { error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
}

const server = http.createServer(handle);
server.requestTimeout = 10 * 60 * 1000; // allow slow uploads on weak links
server.listen(config.port, config.host, () => {
  console.log(`${APP_NAME} v${pkg.version} listening on http://${config.host}:${config.port}`);
  console.log(`data: ${config.dataDir}`);
});

function shutdown(sig) {
  console.log(`${sig} received, shutting down`);
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
