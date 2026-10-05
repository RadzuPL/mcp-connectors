'use strict';
// Checks that force-loopback.js pins the chosen port to 127.0.0.1 and nothing else.
// Includes a control run WITHOUT the preload, to prove the test can see the problem.
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const PORT = 18201;       // pinned
const OTHER = 18202;      // must be left alone
const PRELOAD = path.join(__dirname, 'force-loopback.js');

function externalIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 1000 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

// A child that behaves like supergateway 4.1.0: listens without giving a host,
// in the three call shapes Node accepts (port+callback, port only, options object).
const CHILD = `
  const http = require('http');
  const h = (q, r) => r.end('ok');
  http.createServer(h).listen(${PORT});
  http.createServer(h).listen(${OTHER}, () => {});
  process.stdout.write('ready\\n');
`;
const CHILD_OPTIONS = `
  const http = require('http');
  http.createServer((q, r) => r.end('ok')).listen({ port: ${PORT} }, () => {});
  process.stdout.write('ready\\n');
`;

function run(code, withPreload) {
  return new Promise((resolve) => {
    const args = withPreload ? ['--require', PRELOAD, '-e', code] : ['-e', code];
    const env = { PATH: process.env.PATH };
    if (withPreload) env.FORCE_LOOPBACK_PORT = String(PORT);
    const p = spawn('node', args, { env });
    p.stdout.on('data', (d) => { if (String(d).includes('ready')) setTimeout(() => resolve(p), 200); });
  });
}
const stop = (p) => new Promise((r) => { p.on('exit', r); p.kill('SIGTERM'); });

(async () => {
  const ext = externalIPv4();
  if (!ext) { console.log('SKIP: no non-loopback IPv4 address on this host, cannot test'); return; }
  let passed = 0;
  const ok = (m) => { passed++; console.log('PASS', m); };

  // Control: without the preload the port IS reachable from the external address.
  let p = await run(CHILD, false);
  assert.strictEqual(await canConnect('127.0.0.1', PORT), true);
  assert.strictEqual(await canConnect(ext, PORT), true, 'control run: expected the unpatched port to be reachable on ' + ext);
  ok(`control (no preload): port ${PORT} reachable on ${ext} -> the problem is real and detectable`);
  await stop(p);

  // Patched: listen(port) is pinned to loopback; another port is untouched.
  p = await run(CHILD, true);
  assert.strictEqual(await canConnect('127.0.0.1', PORT), true);
  assert.strictEqual(await canConnect(ext, PORT), false, 'pinned port must NOT be reachable on ' + ext);
  ok(`preload: port ${PORT} reachable on 127.0.0.1, NOT on ${ext}`);
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
  p = await new Promise((resolve) => {
    const c = spawn('node', ['--require', PRELOAD, '-e', CHILD], { env: { PATH: process.env.PATH } });
    c.stdout.on('data', (d) => { if (String(d).includes('ready')) setTimeout(() => resolve(c), 200); });
  });
  assert.strictEqual(await canConnect(ext, PORT), true);
  ok('preload without FORCE_LOOPBACK_PORT is a no-op');
  await stop(p);

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
