'use strict';
// Tests for GATEWAY_SHARED_SESSION=true (gateway/shared-session.js), run against a mock
// of a stateful streamable-HTTP upstream. The mock follows how supergateway --stateful is
// documented in gateway/README.md: `initialize` without a session creates one and returns
// `Mcp-Session-Id`; later requests need it (400 if missing, 404 if unknown); answers are
// SSE (or JSON, switchable). It is NOT the real supergateway, so these tests prove the
// proxy's own logic, not its compatibility with every supergateway release.
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const UP = 18101;
const PX = 18100;
const TOKEN = 'a'.repeat(8) + 'b'.repeat(8) + 'c'.repeat(8) + 'd'.repeat(8); // 32 chars

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mock stateful upstream -------------------------------------------------------
const state = { sessions: new Set(), created: 0, received: [], deletes: 0, gets: 0, json: false };
let sessionCounter = 0;
const resetState = () => {
  state.sessions.clear();
  state.created = 0;
  state.received = [];
  state.deletes = 0;
  state.gets = 0;
  state.json = false;
};

function reply(res, messages, headers = {}) {
  if (state.json) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(messages.length === 1 ? messages[0] : messages));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', ...headers });
  res.end(messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(''));
}

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (req.method === 'GET') {
      state.gets++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end();
    }
    if (req.method === 'DELETE') {
      state.deletes++;
      state.sessions.delete(req.headers['mcp-session-id']);
      res.writeHead(200);
      return res.end();
    }
    const sid = req.headers['mcp-session-id'];
    let msg;
    try {
      msg = JSON.parse(body);
    } catch (_) {
      res.writeHead(400);
      return res.end('bad json');
    }
    state.received.push({ sid, protocol: req.headers['mcp-protocol-version'], msg });
    const msgs = Array.isArray(msg) ? msg : [msg];

    if (msgs[0].method === 'initialize') {
      const newSid = `sess-${++sessionCounter}`;
      state.sessions.add(newSid);
      state.created++;
      return reply(
        res,
        [
          {
            jsonrpc: '2.0',
            id: msgs[0].id,
            result: {
              protocolVersion: msgs[0].params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'mock', version: '1' },
            },
          },
        ],
        { 'Mcp-Session-Id': newSid }
      );
    }
    if (!sid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end('{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: No valid session ID provided"},"id":null}');
    }
    if (!state.sessions.has(sid)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}');
    }

    const requests = msgs.filter((m) => m.method && 'id' in m);
    if (requests.length === 0) {
      res.writeHead(202);
      return res.end();
    }
    if (requests.some((m) => m.params && m.params.name === 'http400')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end('{"error":"nope"}');
    }
    if (requests[0].params && requests[0].params.name === 'progress') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const note = (n) =>
        `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: n } })}\n\n`;
      res.write(note(1));
      await sleep(200);
      res.write(note(2));
      await sleep(200);
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: requests[0].id, result: { done: true } })}\n\n`);
      return res.end();
    }

    const out = [];
    for (const m of requests) {
      if (m.method === 'tools/list') {
        out.push({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo' }] } });
      } else if (m.method === 'tools/call') {
        await sleep((m.params.arguments && m.params.arguments.delayMs) || 0);
        out.push({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: m.params.arguments.text }] } });
      } else {
        out.push({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
      }
    }
    reply(res, out);
  });
});

// ---- client helpers -----------------------------------------------------------------
function parseMessages(text, contentType) {
  const values = [];
  if (/text\/event-stream/.test(contentType || '')) {
    for (const ev of text.split(/\n\n/)) {
      const data = ev
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) values.push(JSON.parse(data));
    }
  } else if (text) {
    values.push(JSON.parse(text));
  }
  return values.flatMap((v) => (Array.isArray(v) ? v : [v]));
}

function request({ method = 'POST', urlPath = '/mcp', headers = {}, body, auth = true }) {
  return new Promise((resolve, reject) => {
    const h = { Accept: 'application/json, text/event-stream', ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (auth) h.Authorization = `Bearer ${TOKEN}`;
    const r = http.request({ host: '127.0.0.1', port: PX, method, path: urlPath, headers: h }, (res) => {
      const chunks = [];
      const times = [];
      res.on('data', (c) => {
        chunks.push(c.toString());
        times.push(Date.now());
      });
      res.on('end', () => {
        const text = chunks.join('');
        let messages = [];
        try {
          messages = parseMessages(text, res.headers['content-type']);
        } catch (_) {
          /* not JSON-RPC */
        }
        resolve({ status: res.statusCode, headers: res.headers, text, messages, chunks, times });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

const post = (body, opts = {}) =>
  request({ body, headers: opts.sid === undefined ? {} : opts.sid === null ? {} : { 'Mcp-Session-Id': opts.sid }, auth: opts.auth });

const INIT = (id, version = '2025-06-18', name = 'client') => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion: version, capabilities: {}, clientInfo: { name, version: '0' } },
});

function startProxy(env) {
  return new Promise((resolve) => {
    const p = spawn('node', [path.join(__dirname, 'auth-proxy.js')], {
      env: { PATH: process.env.PATH, LISTEN_PORT: String(PX), UPSTREAM_PORT: String(UP), ...env },
    });
    let err = '';
    p.stderr.on('data', (d) => {
      err += d;
      if (/listening on/.test(err)) resolve({ p, err: () => err });
    });
    p.on('exit', (code) => resolve({ p, exited: code, err: () => err }));
  });
}
const stop = (p) =>
  new Promise((r) => {
    p.on('exit', r);
    p.kill('SIGTERM');
  });
const listenUp = () => new Promise((r) => upstream.listen(UP, '127.0.0.1', r));
const closeUp = () =>
  new Promise((r) => {
    upstream.close(r);
    if (upstream.closeAllConnections) upstream.closeAllConnections();
  });

let passed = 0;
const ok = (name) => {
  passed++;
  console.log('PASS', name);
};

(async () => {
  await listenUp();
  const tokenFile = path.join(os.tmpdir(), `tok-shared-${process.pid}`);
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const base = { MCP_BEARER_TOKEN_FILE: tokenFile, GATEWAY_SHARED_SESSION: 'true' };

  let { p, err } = await startProxy(base);
  assert.match(err(), /shared-session mode ON/);
  ok('startup message says shared-session mode ON');

  // ---- 1. authentication still comes first ------------------------------------------
  let r = await post(INIT(1), { auth: false });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(state.received.length, 0, 'nothing may reach the upstream without a token');
  assert.strictEqual(state.created, 0);
  ok('no token -> 401, upstream untouched (no session opened either)');

  // ---- 2. five independent clients share one upstream session -------------------------
  const clientSids = new Set();
  for (let i = 1; i <= 5; i++) {
    r = await post(INIT(1, '2025-06-18', `client-${i}`));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.messages[0].id, 1);
    assert.strictEqual(r.messages[0].result.serverInfo.name, 'mock');
    const sid = r.headers['mcp-session-id'];
    assert.ok(sid, 'client initialize must carry an Mcp-Session-Id');
    clientSids.add(sid);

    r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { sid });
    assert.strictEqual(r.status, 202);

    r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { sid });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.messages[0].id, 1);
    assert.strictEqual(r.messages[0].result.tools[0].name, 'echo');

    r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: `hi${i}` } } }, { sid });
    assert.strictEqual(r.messages[0].id, 2);
    assert.strictEqual(r.messages[0].result.content[0].text, `hi${i}`);
  }
  assert.strictEqual(state.created, 1, `expected ONE upstream session, got ${state.created}`);
  assert.strictEqual(state.received.filter((x) => x.msg.method === 'initialize').length, 1);
  assert.strictEqual(state.received.filter((x) => x.msg.method === 'notifications/initialized').length, 1);
  assert.strictEqual(clientSids.size, 5, 'every client gets its own session id');
  ok('5 full client handshakes -> 1 upstream session, 1 initialize, 1 notifications/initialized');

  const first = state.received[0];
  assert.strictEqual(first.msg.params.protocolVersion, '2025-06-18');
  assert.ok(state.received.slice(1).every((x) => x.sid === 'sess-1' && x.protocol === '2025-06-18'));
  ok("upstream session opened with the first client's protocol version; every request carries the shared session headers");

  const upIds = state.received.map((x) => x.msg).filter((m) => m.method && 'id' in m).map((m) => m.id);
  assert.ok(upIds.every((id) => typeof id === 'string' && id.startsWith('gw-')));
  assert.strictEqual(new Set(upIds).size, upIds.length, 'upstream ids must be unique');
  ok('client ids are replaced by unique gw-N ids upstream');

  // ---- 3. the client's own session header is irrelevant -----------------------------------
  r = await post({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, { sid: 'garbage' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.messages[0].id, 7);
  r = await post({ jsonrpc: '2.0', id: 8, method: 'tools/list' }, { sid: null });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.messages[0].id, 8);
  ok('unknown or missing client Mcp-Session-Id is accepted');

  // ---- 4. no cross-talk when every client uses the same id ----------------------------------
  const texts = Array.from({ length: 8 }, (_, i) => `t${i}`);
  const results = await Promise.all(
    texts.map((t, i) =>
      post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: t, delayMs: 20 + ((i * 37) % 200) } } })
    )
  );
  results.forEach((x, i) => {
    assert.strictEqual(x.messages[0].id, 1);
    assert.strictEqual(x.messages[0].result.content[0].text, texts[i], `answer ${i} went to the wrong client`);
  });
  ok('8 concurrent calls, all with id 1 -> each gets its own answer');

  // ---- 5. id types and errors ------------------------------------------------------------------
  r = await post({ jsonrpc: '2.0', id: 0, method: 'tools/list' });
  assert.strictEqual(r.messages[0].id, 0);
  r = await post({ jsonrpc: '2.0', id: 'abc', method: 'tools/list' });
  assert.strictEqual(r.messages[0].id, 'abc');
  r = await post({ jsonrpc: '2.0', id: 'x9', method: 'nope/nope' });
  assert.strictEqual(r.messages[0].id, 'x9');
  assert.strictEqual(r.messages[0].error.code, -32601);
  ok('ids 0 and "abc" and a JSON-RPC error answer all keep the client id');

  // ---- 6. batch --------------------------------------------------------------------------------------
  r = await post([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'b' } } },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } },
  ]);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.messages.map((m) => m.id).sort(), [1, 2]);
  ok('batch: requests forwarded with ids restored, the notification dropped');

  // ---- 7. long calls still stream ---------------------------------------------------------------------
  r = await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'progress' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.messages.length, 3);
  assert.strictEqual(r.messages[0].method, 'notifications/progress');
  assert.strictEqual(r.messages[2].id, 5);
  assert.ok(r.times[r.times.length - 1] - r.times[0] >= 300, 'events must arrive incrementally');
  ok(`SSE rewritten event by event (3 events over ${r.times[r.times.length - 1] - r.times[0]} ms), notifications untouched`);

  // ---- 8. upstream answering JSON instead of SSE -------------------------------------------------------
  state.json = true;
  r = await post({ jsonrpc: '2.0', id: 11, method: 'tools/list' });
  assert.match(r.headers['content-type'], /application\/json/);
  assert.strictEqual(r.messages[0].id, 11);
  state.json = false;
  ok('JSON answers from upstream are handled too');

  // ---- 9. things the shared session must not let through ------------------------------------------------
  const seen = state.received.length;
  r = await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  assert.strictEqual(r.status, 202);
  r = await request({ method: 'DELETE', urlPath: '/mcp' });
  assert.strictEqual(r.status, 204);
  r = await request({ method: 'GET', urlPath: '/mcp' });
  assert.strictEqual(r.status, 405);
  assert.match(r.headers.allow, /POST/);
  r = await request({ urlPath: '/other', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(state.received.length, seen, 'none of these may reach the upstream');
  assert.strictEqual(state.deletes, 0, 'a client must not be able to end the shared session');
  assert.strictEqual(state.gets, 0);
  ok('notification -> 202, DELETE -> 204, GET -> 405, other path -> 404; none forwarded');

  // ---- 10. malformed input -------------------------------------------------------------------------------
  r = await request({ body: 'not json' });
  assert.strictEqual(r.status, 400);
  r = await request({ body: '[]' });
  assert.strictEqual(r.status, 400);
  r = await request({ body: '5' });
  assert.strictEqual(r.status, 400);
  r = await post([INIT(1), { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(state.received.length, seen);
  ok('invalid JSON, empty batch, non-object body, initialize inside a batch -> 400');

  // ---- 11. an upstream 400 that is not about the session is passed on, not retried -------------------------
  const created0 = state.created;
  const n0 = state.received.length;
  r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'http400' } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.text, '{"error":"nope"}');
  assert.strictEqual(state.created, created0);
  assert.strictEqual(state.received.length, n0 + 1);
  ok('unrelated upstream 400 is relayed once, no new session');

  // ---- 12. the upstream forgets the session ---------------------------------------------------------------
  state.sessions.clear();
  r = await post({ jsonrpc: '2.0', id: 21, method: 'tools/list' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.messages[0].id, 21);
  assert.strictEqual(state.created, 2);
  ok('session gone (404) -> new upstream session, request retried transparently');

  state.sessions.clear();
  const burst = await Promise.all(
    [1, 2, 3, 4, 5, 6].map((i) => post({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'echo', arguments: { text: `x${i}`, delayMs: i * 5 } } }))
  );
  burst.forEach((x, i) => {
    assert.strictEqual(x.status, 200);
    assert.strictEqual(x.messages[0].result.content[0].text, `x${i + 1}`);
  });
  assert.strictEqual(state.created, 3, `six concurrent stale requests must open ONE new session, got ${state.created - 2}`);
  ok('6 concurrent requests after the session vanished -> exactly one new session');

  // ---- 13. upstream down ---------------------------------------------------------------------------------------
  await closeUp();
  r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.strictEqual(r.status, 502);
  await listenUp();
  state.sessions.clear();
  r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.strictEqual(r.status, 200);
  ok('upstream down -> 502; after it is back (with no sessions) the next request recovers');
  await stop(p);

  // fresh proxy, upstream down: nothing cached, initialize must fail cleanly and then work
  resetState();
  await closeUp();
  ({ p } = await startProxy(base));
  r = await post(INIT(1));
  assert.strictEqual(r.status, 502);
  await listenUp();
  r = await post(INIT(1));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(state.created, 1);
  ok('initialize while upstream is down -> 502, and a failed attempt is not cached');
  await stop(p);

  // ---- 14. an upstream that is not a stateful MCP server ----------------------------------------------------------
  resetState();
  const dumb = http.createServer((q, s) => {
    q.resume();
    s.writeHead(200, { 'Content-Type': 'text/plain' });
    s.end('upstream-ok');
  });
  await closeUp();
  await new Promise((res) => dumb.listen(UP, '127.0.0.1', res));
  ({ p } = await startProxy(base));
  r = await post(INIT(1));
  assert.strictEqual(r.status, 502);
  await stop(p);
  await new Promise((res) => dumb.close(res));
  await listenUp();
  ok('upstream without Mcp-Session-Id (not stateful) -> 502, never a made-up session');

  // ---- 15. default: the plain pass-through is unchanged ----------------------------------------------------------------
  resetState();
  ({ p, err } = await startProxy({ MCP_BEARER_TOKEN_FILE: tokenFile }));
  assert.match(err(), /shared-session mode off/);
  await post(INIT(1));
  await post(INIT(1));
  assert.strictEqual(state.created, 2, 'without the flag every client initialize reaches the upstream');
  await request({ method: 'DELETE', urlPath: '/mcp', headers: { 'Mcp-Session-Id': 'sess-x' } });
  await request({ method: 'GET', urlPath: '/mcp' });
  assert.strictEqual(state.deletes, 1);
  assert.strictEqual(state.gets, 1);
  ok('flag off: initialize, DELETE and GET are passed through untouched');
  await stop(p);

  // the flag accepts the same spellings as GATEWAY_STATEFUL
  for (const v of ['TRUE', '1', 'yes']) {
    ({ p, err } = await startProxy({ MCP_BEARER_TOKEN_FILE: tokenFile, GATEWAY_SHARED_SESSION: v }));
    assert.match(err(), /shared-session mode ON/, `value ${v}`);
    await stop(p);
  }
  ({ p, err } = await startProxy({ MCP_BEARER_TOKEN_FILE: tokenFile, GATEWAY_SHARED_SESSION: 'false' }));
  assert.match(err(), /shared-session mode off/);
  await stop(p);
  ok('flag values TRUE / 1 / yes switch it on, false leaves it off');

  fs.unlinkSync(tokenFile);
  await new Promise((res) => upstream.close(res));
  console.log(`\n${passed} checks passed`);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
