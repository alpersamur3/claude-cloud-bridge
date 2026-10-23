#!/usr/bin/env node
'use strict';

/**
 * Claude Cloud Bridge - Istemci (CLI)
 * -----------------------------------
 * Bu dosya CLOUD ortamindan (Claude tarafindan) senin bilgisayarindaki
 * kopru sunucusuna istek atmak icin kullanilir.
 *
 * Gerekli ortam degiskenleri:
 *   BRIDGE_URL   -> ornegin  https://xxxx.trycloudflare.com   (veya http://IP:8787)
 *   BRIDGE_KEY   -> sunucunun baslangicta verdigi API key
 *
 * Kullanim:
 *   node client.js status
 *   node client.js exec "ls -la ~"
 *   node client.js exec --cwd /home/kullanici/proje "npm test"
 *   node client.js read /home/kullanici/notlar.txt
 *   node client.js write /home/kullanici/selam.txt "Merhaba dunya"
 *   node client.js write --base64 /yol/dosya.png <base64veri>
 *   node client.js list ~/Desktop
 *   node client.js stat /yol/dosya
 *   node client.js mkdir /yol/yeni-dizin
 *   node client.js delete --recursive /yol/dizin
 *   node client.js move /eski/yol /yeni/yol
 *   node client.js health
 *
 * Bagimlilik YOK (Node yerlesik modulleri).
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const BASE = process.env.BRIDGE_URL;
const KEY = process.env.BRIDGE_KEY;

function die(msg, code = 1) {
  console.error('HATA: ' + msg);
  process.exit(code);
}

if (!BASE) die('BRIDGE_URL ortam degiskeni gerekli (ornek: https://xxx.trycloudflare.com)');

function request(method, routePath, body, needAuth = true) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(routePath, BASE.endsWith('/') ? BASE : BASE + '/');
    } catch (e) {
      return reject(new Error('Gecersiz BRIDGE_URL: ' + e.message));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'Accept': 'application/json' };
    if (needAuth) {
      if (!KEY) return reject(new Error('BRIDGE_KEY ortam degiskeni gerekli'));
      headers['Authorization'] = 'Bearer ' + KEY;
    }
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = lib.request(u, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Basit arguman ayiklayici: --flag ve --key value desteginde
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--recursive' || a === '-r') flags.recursive = true;
    else if (a === '--base64') flags.base64 = true;
    else if (a === '--append') flags.append = true;
    else if (a === '--cwd') { flags.cwd = argv[++i]; }
    else if (a === '--timeout') { flags.timeout = parseInt(argv[++i], 10); }
    else positional.push(a);
  }
  return { flags, positional };
}

function print(result) {
  console.log(JSON.stringify(result.json, null, 2));
  if (!result.json || result.json.ok === false || result.status >= 400) process.exit(2);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { flags, positional } = parseArgs(rest);

  switch (cmd) {
    case 'health':
      return print(await request('GET', 'health', null, false));

    case 'status':
      return print(await request('GET', 'status'));

    case 'exec': {
      const command = positional.join(' ');
      if (!command) die('Komut gerekli: node client.js exec "ls -la"');
      return print(await request('POST', 'exec', {
        command, cwd: flags.cwd, timeout: flags.timeout,
      }));
    }

    case 'read': {
      const p = positional[0];
      if (!p) die('Yol gerekli');
      return print(await request('POST', 'fs/read', {
        path: p, encoding: flags.base64 ? 'base64' : 'utf8',
      }));
    }

    case 'write': {
      const p = positional[0];
      const content = positional.slice(1).join(' ');
      if (!p) die('Yol gerekli');
      return print(await request('POST', 'fs/write', {
        path: p, content, encoding: flags.base64 ? 'base64' : 'utf8', append: !!flags.append,
      }));
    }

    case 'list':
      return print(await request('POST', 'fs/list', { path: positional[0] || '.' }));

    case 'stat':
      return print(await request('POST', 'fs/stat', { path: positional[0] }));

    case 'mkdir':
      return print(await request('POST', 'fs/mkdir', { path: positional[0] }));

    case 'delete':
      return print(await request('POST', 'fs/delete', { path: positional[0], recursive: !!flags.recursive }));

    case 'move':
      return print(await request('POST', 'fs/move', { from: positional[0], to: positional[1] }));

    default:
      console.log('Kullanim: node client.js <health|status|exec|read|write|list|stat|mkdir|delete|move> ...');
      console.log('Ortam: BRIDGE_URL, BRIDGE_KEY');
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => die(e.message));
