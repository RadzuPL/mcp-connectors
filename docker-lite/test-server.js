'use strict';
// Tests for docker-lite against a fake Docker API. Run: node docker-lite/test-server.js
const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

function frame(stream, text) {
  const body = Buffer.from(text, 'utf8');
  const h = Buffer.alloc(8);
  h[0] = stream;
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}

const LOG_LINES = [];
for (let i = 1; i <= 300; i++) LOG_LINES.push(`line ${i} \x1b[31mINFO\x1b[0m ${i % 50 === 0 ? 'ERROR boom' : 'ok'}`);
for (let i = 0; i < 20; i++) LOG_LINES.push('spam spam spam');
LOG_LINES.push('x'.repeat(1000));

const requests = [];
const fake = http.createServer((req, res) => {
  requests.push(req.method + ' ' + req.url);
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === '/containers/json') {
    return send(200, [
      { Id: 'a'.repeat(64), Names: ['/zeta'], Image: 'sha256:' + 'b'.repeat(64), State: 'running', Status: 'Up 2 hours (healthy)',
        Ports: [{ PublicPort: 8080, PrivatePort: 80 }, { PublicPort: 8080, PrivatePort: 80 }, { PrivatePort: 9 }], Labels: { big: 'y'.repeat(5000) } },
      { Id: 'c'.repeat(64), Names: ['/alpha'], Image: 'docker.io/library/nginx:1@sha256:' + 'd'.repeat(64), State: 'exited', Status: 'Exited (1) 3 days ago', Ports: [] },
    ].filter((c) => url.searchParams.get('all') === '1' || c.State === 'running'));
  }
  let m = /^\/containers\/([^/]+)\/logs$/.exec(url.pathname);
  if (m) {
    if (m[1] === 'locked') return send(403, { message: 'Forbidden' });
    if (m[1] === 'missing') return send(404, { message: 'No such container: missing' });
    const tail = url.searchParams.get('tail');
    let lines = LOG_LINES;
    if (tail && tail !== 'all') lines = lines.slice(-parseInt(tail, 10));
    res.writeHead(200);
    return res.end(Buffer.concat(lines.map((l, i) => frame(i % 2 ? 2 : 1, l + '\n'))));
  }
  m = /^\/containers\/([^/]+)\/json$/.exec(url.pathname);
  if (m) {
    return send(200, {
      Name: '/alpha', Image: 'sha256:abc', RestartCount: 3,
      Config: { Image: 'nginx:1', Env: ['SECRET_TOKEN=hunter2hunter2', 'PATH=/usr/bin'] },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'docker_network', Memory: 0 },
      State: { Status: 'exited', Running: false, ExitCode: 137, OOMKilled: true, Error: '', FinishedAt: '2026-10-06T10:00:00Z',
        Health: { Status: 'unhealthy', Log: [{ Output: 'curl: (7) failed\n' }] } },
      NetworkSettings: { Ports: { '80/tcp': [{ HostPort: '8080' }] }, Networks: { docker_network: { IPAddress: '172.20.0.9' } } },
      Mounts: [{ Source: '/mnt/user/x', Destination: '/data', RW: false }],
    });
  }
  send(404, { message: 'nope' });
});

function rpc(child, id, method, params) {
  return new Promise((resolve) => {
    const onData = (buf) => {
      for (const line of buf.toString().split('\n').filter(Boolean)) {
        const msg = JSON.parse(line);
        if (msg.id === id) {
          child.stdout.off('data', onData);
          resolve(msg);
        }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

fake.listen(0, '127.0.0.1', async () => {
  const port = fake.address().port;
  const child = spawn('node', [path.join(__dirname, 'server.js')], {
    env: { ...process.env, DOCKER_HOST: `tcp://127.0.0.1:${port}` },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const call = async (id, name, args) => {
    const r = await rpc(child, id, 'tools/call', { name, arguments: args });
    return { text: r.result.content[0].text, isError: !!r.result.isError };
  };
  try {
    // protocol
    const init = await rpc(child, 1, 'initialize', { protocolVersion: '2025-06-18' });
    assert.strictEqual(init.result.protocolVersion, '2025-06-18');
    const list = await rpc(child, 2, 'tools/list', {});
    assert.deepStrictEqual(list.result.tools.map((t) => t.name), ['ps', 'logs', 'inspect']);
    assert.ok(JSON.stringify(list.result.tools).length < 1800, 'tool schemas must stay small');
    const bad = await rpc(child, 3, 'nope', {});
    assert.strictEqual(bad.error.code, -32601);

    // ps
    let r = await call(4, 'ps', {});
    assert.ok(r.text.includes('zeta | Up 2 hours (healthy) | bbbbbbbbbbbb | 8080>80'), r.text);
    assert.ok(!r.text.includes('alpha'), 'stopped container hidden by default');
    assert.ok(!r.text.includes('yyyy'), 'labels never leak');
    r = await call(5, 'ps', { all: true, name: 'ALP' });
    assert.ok(r.text.includes('alpha | Exited (1) 3 days ago | nginx:1 |'), r.text);
    assert.ok(!r.text.includes('zeta'));

    // logs: defaults, demux, ansi, limit
    r = await call(6, 'logs', { container: 'alpha' });
    assert.ok(!r.text.includes('\x1b'), 'ansi stripped');
    assert.ok(r.text.startsWith('['), r.text.slice(0, 80));
    assert.ok(r.text.length < 4300, `default budget respected (${r.text.length})`);
    assert.ok(r.text.includes('spam spam spam (x20)'), 'repeats collapsed');
    assert.ok(r.text.includes('…'), 'long line truncated');
    // logs: grep scans far back, returns only matches
    r = await call(7, 'logs', { container: 'alpha', grep: 'error boom', tail: 3 });
    const body = r.text.split('\n').slice(1);
    assert.strictEqual(body.length, 3);
    assert.ok(body.every((l) => /ERROR boom/.test(l)), r.text);
    assert.ok(requests.some((q) => q.includes('tail=5000')), 'grep widens the scan window');
    // logs: tiny budget keeps the newest and says so
    r = await call(8, 'logs', { container: 'alpha', tail: 500, max_chars: 300 });
    assert.ok(/older ones cut by max_chars=300/.test(r.text), r.text.slice(0, 120));
    assert.ok(r.text.length < 700);
    // logs: since + invalid regex + bad name
    r = await call(9, 'logs', { container: 'alpha', since: '10m' });
    assert.ok(requests.some((q) => /since=\d{9,}/.test(q)));
    r = await call(10, 'logs', { container: 'alpha', grep: '(' });
    assert.ok(r.isError && /invalid grep/.test(r.text));
    r = await call(11, 'logs', { container: '../etc' });
    assert.ok(r.isError);
    // docker-side errors become short messages
    r = await call(12, 'logs', { container: 'locked' });
    assert.ok(r.isError && /403 from docker-socket-proxy/.test(r.text), r.text);
    r = await call(13, 'logs', { container: 'missing' });
    assert.ok(r.isError && /not found/.test(r.text), r.text);

    // inspect: summary, env names only
    r = await call(14, 'inspect', { container: 'alpha' });
    assert.ok(r.text.includes('last exit: code 137, OOM killed'), r.text);
    assert.ok(r.text.includes('health: unhealthy; last check: curl: (7) failed'), r.text);
    assert.ok(r.text.includes('env names (values hidden): SECRET_TOKEN, PATH'), r.text);
    assert.ok(!r.text.includes('hunter2'), 'env values never leave the container');
    assert.ok(r.text.includes('/mnt/user/x -> /data (ro)'));
    assert.ok(r.text.length < 900);

    // only GET requests ever hit Docker
    assert.ok(requests.every((q) => q.startsWith('GET ')));
    console.log('docker-lite: all tests passed');
  } catch (err) {
    console.error('docker-lite: TEST FAILED\n' + (err.stack || err));
    process.exitCode = 1;
  } finally {
    child.stdin.end();
    fake.close();
  }
});
