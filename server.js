#!/usr/bin/env node
'use strict';

/**
 * Claude Cloud Bridge - Sunucu (Agent)
 * ------------------------------------
 * Bu dosya SENİN BİLGİSAYARINDA calisir. Cloud ortamindaki Claude bu sunucuya
 * HTTP uzerinden baglanarak komut calistirabilir, dosya okuyup yazabilir.
 *
 * Guvenlik:
 *   - Her baslatmada yeni, kriptografik olarak guvenli bir API key uretilir.
 *   - Key varsayilan olarak 24 saat sonra gecersiz olur (restart = yeni key).
 *   - Her istek gecerli key olmadan 401 ile reddedilir (timing-safe karsilastirma).
 *
 * Bagimlilik YOK: sadece Node.js yerlesik modulleri kullanilir.
 * Calistirma:  node server.js
 */

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Yapilandirma (ortam degiskenleri ile gecersiz kilinabilir)
// ---------------------------------------------------------------------------
const CONFIG = {
  host: process.env.BRIDGE_HOST || '0.0.0.0',
  port: parseInt(process.env.BRIDGE_PORT || '8787', 10),
  keyTtlHours: parseFloat(process.env.BRIDGE_KEY_TTL_HOURS || '24'),
  // Istek govdesi (body) maksimum boyutu - cok buyuk dosya yazarken artirin.
  maxBodyBytes: parseInt(process.env.BRIDGE_MAX_BODY_MB || '100', 10) * 1024 * 1024,
  // exec icin varsayilan timeout (ms) ve maksimum cikti tamponu (byte).
  defaultExecTimeoutMs: parseInt(process.env.BRIDGE_EXEC_TIMEOUT_MS || '120000', 10),
  maxExecBuffer: parseInt(process.env.BRIDGE_EXEC_MAX_OUTPUT_MB || '50', 10) * 1024 * 1024,
  // Sabit bir key kullanmak isterseniz (onerilmez). Bos ise rastgele uretilir.
  fixedKey: process.env.BRIDGE_API_KEY || '',
};

// ---------------------------------------------------------------------------
// API Key yonetimi
// ---------------------------------------------------------------------------
const API_KEY = CONFIG.fixedKey || crypto.randomBytes(32).toString('hex');
const KEY_CREATED_AT = Date.now();
const KEY_EXPIRES_AT = KEY_CREATED_AT + Math.round(CONFIG.keyTtlHours * 3600 * 1000);

function keyIsExpired() {
  return Date.now() > KEY_EXPIRES_AT;
}

function timeRemainingMs() {
  return Math.max(0, KEY_EXPIRES_AT - Date.now());
}

/** Timing-safe string karsilastirma (brute-force/timing saldirilarina karsi). */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Uzunluk farki bilgisini sizdirmamak icin yine de karsilastir.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/** Istekten API key'i cikar (Authorization: Bearer ... veya x-api-key). */
function extractKey(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  return null;
}

// ---------------------------------------------------------------------------
// Yardimcilar
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`Istek govdesi cok buyuk (limit ${limit} byte)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req, CONFIG.maxBodyBytes);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (e) {
    throw new Error('Gecersiz JSON govdesi');
  }
}

/** ~ (home) genislet ve mutlak yola cevir. */
function resolvePath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error("'path' alani gerekli");
  }
  if (p === '~') p = os.homedir();
  else if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

function logLine(req, extra) {
  const ip = req.socket.remoteAddress;
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${ip} ${req.method} ${req.url}${extra ? ' ' + extra : ''}`);
}

// ---------------------------------------------------------------------------
// Rota islemleri
// ---------------------------------------------------------------------------

/** POST /exec  { command, cwd?, shell?, timeout?, env? } */
async function handleExec(req, res) {
  const body = await readJsonBody(req);
  const command = body.command;
  if (typeof command !== 'string' || command.trim() === '') {
    return sendJson(res, 400, { ok: false, error: "'command' alani gerekli" });
  }
  const cwd = body.cwd ? resolvePath(body.cwd) : process.cwd();
  const timeout = Number.isFinite(body.timeout) ? body.timeout : CONFIG.defaultExecTimeoutMs;
  const useShell = body.shell || (os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash');
  const shellFlag = os.platform() === 'win32' ? '/c' : '-c';

  logLine(req, `exec: ${command.slice(0, 200)}`);

  const started = Date.now();
  const child = spawn(useShell, [shellFlag, command], {
    cwd,
    env: { ...process.env, ...(body.env || {}) },
    windowsHide: true,
  });

  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let truncated = false;
  let timedOut = false;

  const appendCapped = (buf, chunk) => {
    if (buf.length >= CONFIG.maxExecBuffer) {
      truncated = true;
      return buf;
    }
    return Buffer.concat([buf, chunk]);
  };

  child.stdout.on('data', (c) => { stdout = appendCapped(stdout, c); });
  child.stderr.on('data', (c) => { stderr = appendCapped(stderr, c); });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeout);

  child.on('error', (err) => {
    clearTimeout(timer);
    sendJson(res, 500, { ok: false, error: `Komut baslatilamadi: ${err.message}` });
  });

  child.on('close', (code, signal) => {
    clearTimeout(timer);
    if (res.headersSent) return;
    sendJson(res, 200, {
      ok: !timedOut && code === 0,
      exitCode: code,
      signal: signal || null,
      timedOut,
      truncated,
      durationMs: Date.now() - started,
      cwd,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
    });
  });
}

/** POST /fs/read  { path, encoding? }  -> base64 veya metin */
async function handleFsRead(req, res) {
  const body = await readJsonBody(req);
  const p = resolvePath(body.path);
  const encoding = body.encoding || 'utf8';
  logLine(req, `read: ${p}`);
  const data = await fsp.readFile(p);
  if (encoding === 'base64') {
    return sendJson(res, 200, { ok: true, path: p, encoding: 'base64', size: data.length, content: data.toString('base64') });
  }
  return sendJson(res, 200, { ok: true, path: p, encoding: 'utf8', size: data.length, content: data.toString('utf8') });
}

/** POST /fs/write  { path, content, encoding?, append?, mkdirs? } */
async function handleFsWrite(req, res) {
  const body = await readJsonBody(req);
  const p = resolvePath(body.path);
  if (typeof body.content !== 'string') {
    return sendJson(res, 400, { ok: false, error: "'content' alani (string) gerekli" });
  }
  const encoding = body.encoding === 'base64' ? 'base64' : 'utf8';
  const data = Buffer.from(body.content, encoding);
  if (body.mkdirs !== false) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
  }
  logLine(req, `write${body.append ? '(append)' : ''}: ${p} (${data.length} byte)`);
  if (body.append) {
    await fsp.appendFile(p, data);
  } else {
    await fsp.writeFile(p, data);
  }
  return sendJson(res, 200, { ok: true, path: p, bytesWritten: data.length });
}

/** POST /fs/list  { path }  -> dizin icerigi */
async function handleFsList(req, res) {
  const body = await readJsonBody(req);
  const p = resolvePath(body.path || '.');
  logLine(req, `list: ${p}`);
  const entries = await fsp.readdir(p, { withFileTypes: true });
  const items = await Promise.all(entries.map(async (e) => {
    const full = path.join(p, e.name);
    let stat = null;
    try {
      const s = await fsp.stat(full);
      stat = { size: s.size, mtime: s.mtime.toISOString() };
    } catch (_) { /* symlink kirik olabilir */ }
    return {
      name: e.name,
      type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : e.isSymbolicLink() ? 'symlink' : 'other',
      path: full,
      ...(stat || {}),
    };
  }));
  return sendJson(res, 200, { ok: true, path: p, count: items.length, entries: items });
}

/** POST /fs/stat  { path } */
async function handleFsStat(req, res) {
  const body = await readJsonBody(req);
  const p = resolvePath(body.path);
  logLine(req, `stat: ${p}`);
  const s = await fsp.stat(p);
  return sendJson(res, 200, {
    ok: true,
    path: p,
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymbolicLink: s.isSymbolicLink(),
    size: s.size,
    mode: s.mode,
    mtime: s.mtime.toISOString(),
    ctime: s.ctime.toISOString(),
    atime: s.atime.toISOString(),
  });
}

/** POST /fs/mkdir  { path } */
async function handleFsMkdir(req, res) {
  const body = await readJsonBody(req);
  const p = resolvePath(body.path);
  logLine(req, `mkdir: ${p}`);
  await fsp.mkdir(p, { recursive: true });
  return sendJson(res, 200, { ok: true, path: p });
}

/** POST /fs/delete  { path, recursive? } */
async function handleFsDelete(req, res) {
  const body = await readJsonBody(req);
  const p = resolvePath(body.path);
  logLine(req, `delete: ${p}`);
  await fsp.rm(p, { recursive: !!body.recursive, force: true });
  return sendJson(res, 200, { ok: true, path: p });
}

/** POST /fs/move  { from, to, mkdirs? } */
async function handleFsMove(req, res) {
  const body = await readJsonBody(req);
  const from = resolvePath(body.from);
  const to = resolvePath(body.to);
  if (body.mkdirs !== false) {
    await fsp.mkdir(path.dirname(to), { recursive: true });
  }
  logLine(req, `move: ${from} -> ${to}`);
  await fsp.rename(from, to);
  return sendJson(res, 200, { ok: true, from, to });
}

/** GET /status  (auth gerekli) - sunucu/key durumu */
function handleStatus(req, res) {
  return sendJson(res, 200, {
    ok: true,
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    nodeVersion: process.version,
    cwd: process.cwd(),
    homedir: os.homedir(),
    keyCreatedAt: new Date(KEY_CREATED_AT).toISOString(),
    keyExpiresAt: new Date(KEY_EXPIRES_AT).toISOString(),
    keyExpired: keyIsExpired(),
    timeRemainingMs: timeRemainingMs(),
  });
}

// Auth gerektirmeyen rotalar
const ROUTES = {
  'POST /exec': handleExec,
  'POST /fs/read': handleFsRead,
  'POST /fs/write': handleFsWrite,
  'POST /fs/append': handleFsWrite, // append:true ile ayni mantik
  'POST /fs/list': handleFsList,
  'POST /fs/stat': handleFsStat,
  'POST /fs/mkdir': handleFsMkdir,
  'POST /fs/delete': handleFsDelete,
  'POST /fs/move': handleFsMove,
  'GET /status': handleStatus,
};

// ---------------------------------------------------------------------------
// HTTP sunucu
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // Basit CORS (tarayici tabanli istemciler icin; curl/fetch gerekmez)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-api-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';

  // /health -> auth GEREKMEZ (sadece canlilik kontrolu, hassas bilgi vermez)
  if (req.method === 'GET' && url === '/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'claude-cloud-bridge',
      keyExpired: keyIsExpired(),
      timeRemainingMs: timeRemainingMs(),
    });
  }

  const routeKey = `${req.method} ${url}`;
  const handler = ROUTES[routeKey];
  if (!handler) {
    return sendJson(res, 404, { ok: false, error: `Bilinmeyen rota: ${routeKey}` });
  }

  // --- Kimlik dogrulama ---
  const providedKey = extractKey(req);
  if (!providedKey) {
    logLine(req, 'REDDEDILDI: key yok');
    return sendJson(res, 401, { ok: false, error: 'API key gerekli (Authorization: Bearer <key>)' });
  }
  if (keyIsExpired()) {
    logLine(req, 'REDDEDILDI: key suresi doldu');
    return sendJson(res, 401, { ok: false, error: 'API key suresi doldu. Kopruyu yeniden baslatin (yeni key uretilir).' });
  }
  if (!safeEqual(providedKey, API_KEY)) {
    logLine(req, 'REDDEDILDI: gecersiz key');
    return sendJson(res, 401, { ok: false, error: 'Gecersiz API key' });
  }

  // --- Isle ---
  try {
    await handler(req, res);
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: err.message, code: err.code || null });
    }
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(CONFIG.port, CONFIG.host, () => {
  const line = '='.repeat(68);
  console.log('\n' + line);
  console.log('  CLAUDE CLOUD BRIDGE  -  calisiyor');
  console.log(line);
  console.log(`  Adres     : http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`  Platform  : ${os.platform()} ${os.arch()} / Node ${process.version}`);
  console.log(`  Dizin     : ${process.cwd()}`);
  console.log(line);
  console.log('  API KEY (bu key olmadan erisim YOK):');
  console.log('');
  console.log('      ' + API_KEY);
  console.log('');
  console.log(`  Olusturma : ${new Date(KEY_CREATED_AT).toISOString()}`);
  console.log(`  Gecerlilik: ${new Date(KEY_EXPIRES_AT).toISOString()} (${CONFIG.keyTtlHours} saat)`);
  console.log(line);
  console.log('  Bu key\'i ve genel erisim adresini (tunnel URL) Claude\'a verin.');
  console.log('  Her yeniden baslatmada YENI key uretilir.');
  console.log(line + '\n');

  // Key suresi dolunca bilgi amacli uyari
  const warnMs = timeRemainingMs();
  if (warnMs > 0 && warnMs < 24 * 3600 * 1000 * 10) {
    setTimeout(() => {
      console.log(`\n[!] API key suresi doldu (${new Date().toISOString()}). Yeni key icin kopruyu yeniden baslatin.\n`);
    }, warnMs + 500);
  }
});

process.on('SIGINT', () => { console.log('\nKopru kapatiliyor...'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
