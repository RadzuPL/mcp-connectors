'use strict';
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const UP = 18001;
const PX = 18000;
const TOKEN = 'a'.repeat(8) + 'b'.repeat(8) + 'c'.repeat(8) + 'd'.repeat(8); // 32 chars

// Mock upstream: echoes what it received; /stream sends 3 SSE chunks 200 ms apart.
const received = [];
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, auth: req.headers['authorization'] || null, host: req.headers['host'], body });
    if (req.url.startsWith('/stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let i = 0;
      const t = setInterval(() => {
        res.write(`data: chunk${i}\n\n`);
        if (++i === 3) { clearInterval(t); res.end(); }
      }, 200);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Up': 'yes' });
    res.end(JSON.stringify({ ok: true, url: req.url, body }));
  });
});

function request(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PX, ...opts }, (res) => {
      const chunks = [];
      const times = [];
      res.on('data', (c) => { chunks.push(c.toString()); times.push(Date.now()); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, chunks, times, body: chunks.join('') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function startProxy(env) {
  return new Promise((resolve) => {
    const p = spawn('node', [path.join(__dirname, 'auth-proxy.js')], {
      env: { PATH: process.env.PATH, LISTEN_PORT: String(PX), UPSTREAM_PORT: String(UP), ...env },
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (/listening on/.test(err)) resolve({ p, err: () => err }); });
    p.on('exit', (code) => resolve({ p, exited: code, err: () => err }));
  });
}

const stop = (p) => new Promise((r) => { p.on('exit', r); p.kill('SIGTERM'); });
let passed = 0;
const ok = (name) => { passed++; console.log('PASS', name); };

(async () => {
  await new Promise((r) => upstream.listen(UP, '127.0.0.1', r));
  const tokenFile = path.join(os.tmpdir(), 'tok-' + process.pid);
  fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });

  // ---- 1. token from file, header mode -----------------------------------
  let { p } = await startProxy({ MCP_BEARER_TOKEN_FILE: tokenFile });
  const initBody = '{"jsonrpc":"2.0","id":1,"method":"initialize"}';

  let r = await request({ method: 'POST', path: '/mcp' }, initBody);
  assert.strictEqual(r.status, 401); assert.strictEqual(received.length, 0);
  ok('no token -> 401, nothing reached upstream');

  r = await request({ method: 'POST', path: '/mcp', headers: { Authorization: 'Bearer zly' } }, initBody);
  assert.strictEqual(r.status, 401); assert.strictEqual(received.length, 0);
  ok('wrong token -> 401');

  r = await request({ method: 'POST', path: '/mcp', headers: { Authorization: 'Bearer ' + TOKEN.slice(0, -1) } }, initBody);
  assert.strictEqual(r.status, 401);
  ok('token missing last char -> 401');

  r = await request({ method: 'POST', path: '/mcp', headers: { Authorization: 'Basic ' + TOKEN } }, initBody);
  assert.strictEqual(r.status, 401);
  ok('right value but Basic scheme -> 401');

  r = await request({ method: 'POST', path: '/mcp', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' } }, initBody);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['x-up'], 'yes');
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].url, '/mcp');
  assert.strictEqual(received[0].body, initBody);
  assert.strictEqual(received[0].auth, null, 'Authorization must not be forwarded upstream');
  assert.strictEqual(received[0].host, `127.0.0.1:${UP}`);
  ok('right token -> 200, body+path forwarded, Authorization stripped');

  r = await request({ method: 'POST', path: '/' + TOKEN + '/mcp', headers: { Authorization: 'Bearer zly' } }, initBody);
  assert.strictEqual(r.status, 401);
  ok('path token ignored when MCP_ALLOW_PATH_TOKEN is off');

  r = await request({ method: 'GET', path: '/stream', headers: { Authorization: 'Bearer ' + TOKEN } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.chunks.length, 3, 'expected 3 separate chunks, got ' + r.chunks.length);
  assert.ok(r.times[2] - r.times[0] >= 300, 'chunks must arrive incrementally (streamed), not buffered');
  ok('SSE streamed incrementally (3 chunks over ' + (r.times[2] - r.times[0]) + ' ms)');

  r = await request({ method: 'DELETE', path: '/mcp', headers: { Authorization: 'Bearer ' + TOKEN } });
  assert.strictEqual(r.status, 200); assert.strictEqual(received.at(-1).method, 'DELETE');
  ok('other methods are proxied');
  await stop(p);

  // ---- 2. upstream down --------------------------------------------------
  await new Promise((res) => upstream.close(res));
  ({ p } = await startProxy({ MCP_BEARER_TOKEN_FILE: tokenFile }));
  r = await request({ method: 'POST', path: '/mcp', headers: { Authorization: 'Bearer ' + TOKEN } }, initBody);
  assert.strictEqual(r.status, 502);
  ok('upstream down + valid token -> 502');
  r = await request({ method: 'POST', path: '/mcp' }, initBody);
  assert.strictEqual(r.status, 401);
  ok('upstream down + no token -> still 401 (auth checked first)');
  await stop(p);
  await new Promise((res) => upstream.listen(UP, '127.0.0.1', res));

  // ---- 3. path-token mode ------------------------------------------------
  received.length = 0;
  ({ p } = await startProxy({ MCP_BEARER_TOKEN_FILE: tokenFile, MCP_ALLOW_PATH_TOKEN: 'true' }));
  r = await request({ method: 'POST', path: '/' + TOKEN + '/mcp?x=1' }, initBody);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(received[0].url, '/mcp?x=1', 'token segment must be stripped, query kept');
  ok('path token accepted, stripped from upstream path');
  r = await request({ method: 'POST', path: '/' + TOKEN.slice(0, -1) + 'x/mcp' }, initBody);
  assert.strictEqual(r.status, 401);
  ok('wrong path token -> 401');
  r = await request({ method: 'POST', path: '/mcp' }, initBody);
  assert.strictEqual(r.status, 401);
  ok('no token in path-token mode -> 401');
  r = await request({ method: 'POST', path: '/mcp', headers: { Authorization: 'Bearer ' + TOKEN } }, initBody);
  assert.strictEqual(r.status, 200);
  ok('header token still works in path-token mode');
  await stop(p);

  // ---- 4. token from env, and refusing to start --------------------------
  ({ p } = await startProxy({ MCP_BEARER_TOKEN: TOKEN }));
  r = await request({ method: 'POST', path: '/mcp', headers: { Authorization: 'Bearer ' + TOKEN } }, initBody);
  assert.strictEqual(r.status, 200);
  ok('token from MCP_BEARER_TOKEN env works');
  await stop(p);

  let s = await startProxy({});
  assert.strictEqual(s.exited, 2); assert.match(s.err(), /Refusing to start/);
  ok('no token configured -> refuses to start (exit 2)');

  s = await startProxy({ MCP_BEARER_TOKEN: 'short' });
  assert.strictEqual(s.exited, 2);
  ok('token shorter than 24 chars -> refuses to start');

  s = await startProxy({ MCP_BEARER_TOKEN_FILE: '/nonexistent/file' });
  assert.strictEqual(s.exited, 2); assert.match(s.err(), /cannot read/);
  ok('unreadable token file -> refuses to start');

  fs.unlinkSync(tokenFile);
  await new Promise((res) => upstream.close(res));
  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
