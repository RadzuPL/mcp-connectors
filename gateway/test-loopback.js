'use strict';
// Checks that force-loopback.js pins the chosen port to 127.0.0.1 and nothing else.
// Includes a control run WITHOUT the preload, to prove the test can see the problem.
//
// Written to be robust on CI runners: a child reports "ready" only from inside its
// listen callbacks, every non-loopback IPv4 address is tried, and if none of them can
// reach even the unpatched control port (odd runner networking) the test says SKIP
// instead of failing on something it cannot measure.
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const PORT = 18201;       // pinned
const OTHER = 18202;      // must be left alone
const PRELOAD = path.join(__dirname, 'force-loopback.js');

function externalIPv4s() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 1000 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

// Children behave like supergateway 4.1.0: they listen without giving a host.
// "ready" is printed only once every server is really listening.
const CHILD = `
  const http = require('http');
  const h = (q, r) => r.end('ok');
  let n = 0;
  const up = () => { if (++n === 2) process.stdout.write('ready\\n'); };
  http.createServer(h).listen(${PORT}, up);
  http.createServer(h).listen(${OTHER}, up);
`;
const CHILD_OPTIONS = `
  const http = require('http');
  http.createServer((q, r) => r.end('ok')).listen({ port: ${PORT} }, () => process.stdout.write('ready\\n'));
`;

function run(code, withPreload) {
  return new Promise((resolve, reject) => {
    const args = withPreload ? ['--require', PRELOAD, '-e', code] : ['-e', code];
    const env = { PATH: process.env.PATH };
    if (withPreload) env.FORCE_LOOPBACK_PORT = String(PORT);
    const p = spawn('node', args, { env });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (c) => reject(new Error('child exited early (' + c + '): ' + err)));
    p.stdout.on('data', (d) => { if (String(d).includes('ready')) { p.removeAllListeners('exit'); resolve(p); } });
  });
}
const stop = (p) => new Promise((r) => { p.on('exit', r); p.kill('SIGTERM'); });

(async () => {
  const addrs = externalIPv4s();
  if (addrs.length === 0) { console.log('SKIP: no non-loopback IPv4 address on this host, cannot test'); return; }
  let passed = 0;
  const ok = (m) => { passed++; console.log('PASS', m); };

  // Control: without the preload, find an external address that reaches the port.
  let p = await run(CHILD, false);
  assert.strictEqual(await canConnect('127.0.0.1', PORT), true, 'control: loopback must work');
  let ext = null;
  for (const a of addrs) if (await canConnect(a, PORT)) { ext = a; break; }
  await stop(p);
  if (!ext) {
    console.log('SKIP: the unpatched control port was not reachable on any of ' + addrs.join(', ') + '; this host cannot measure the difference');
    return;
  }
  ok(`control (no preload): port ${PORT} reachable on ${ext} -> the problem is real and detectable`);

  // Patched: listen(port, cb) is pinned to loopback; another port is untouched.
  p = await run(CHILD, true);
  assert.strictEqual(await canConnect('127.0.0.1', PORT), true);
  for (const a of addrs) assert.strictEqual(await canConnect(a, PORT), false, 'pinned port must NOT be reachable on ' + a);
  ok(`preload: port ${PORT} reachable on 127.0.0.1, NOT on ${addrs.join(', ')}`);
  assert.strictEqual(await canConnect(ext, OTHER), true, 'other ports must be left alone');
  ok(`preload: unrelated port ${OTHER} untouched (still reachable on ${ext})`);
  await stop(p);

  // Patched: listen({ port }) form.
  p = await run(CHILD_OPTIONS, true);
  assert.strictEqual(await canConnect('127.0.0.1', PORT), true);
  assert.strictEqual(await canConnect(ext, PORT), false);
  ok('preload: listen({ port }) form pinned too');
  await stop(p);

  // Preload without FORCE_LOOPBACK_PORT does nothing.
  p = await new Promise((resolve, reject) => {
    const c = spawn('node', ['--require', PRELOAD, '-e', CHILD], { env: { PATH: process.env.PATH } });
    c.on('exit', (code) => reject(new Error('child exited early ' + code)));
    c.stdout.on('data', (d) => { if (String(d).includes('ready')) { c.removeAllListeners('exit'); resolve(c); } });
  });
  assert.strictEqual(await canConnect(ext, PORT), true);
  ok('preload without FORCE_LOOPBACK_PORT is a no-op');
  await stop(p);

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
