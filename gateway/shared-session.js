'use strict';
// Shared-session mode for auth-proxy.js (GATEWAY_SHARED_SESSION=true).
//
// Why: a wrapped server that logs in somewhere every time it starts (unifi-network-mcp
// does, and UniFi OS answers a burst of logins with a 60 s lockout) is not helped by
// supergateway's --stateful alone, because that gives one server process per *client
// session* and Claude opens a new session for every tool call. Observed 2026-10-07: three
// tool calls, three sessions, three logins in 13 seconds.
//
// What this does: the proxy talks to supergateway (running --stateful) through ONE
// upstream session that it opens itself, lazily, and keeps for as long as supergateway
// keeps it alive. Every client request is forwarded into that session:
//   - client `initialize`            answered by the proxy from the cached upstream
//                                    initialize result, with a session id of its own;
//   - client notifications           acknowledged with 202, not forwarded (the upstream
//                                    session was initialized by the proxy);
//   - client requests                forwarded with the shared session's headers, with the
//                                    JSON-RPC id replaced by a unique one and restored in
//                                    the response, so two clients that both use id 1 can
//                                    never receive each other's answers;
//   - GET (server->client stream)    405, which the MCP specification allows. Server-initiated
//                                    messages are therefore not delivered in this mode;
//   - DELETE (end of session)        acknowledged with 204 and NOT forwarded, so one client
//                                    cannot close the session everybody shares;
//   - upstream says the session is gone (404, or 400 "...session...")
//                                    the proxy opens a new one and retries the request once.
//
// Everything here runs after the bearer token has been checked. Only Node core modules.

const http = require('http');
const crypto = require('crypto');

const ACCEPT = 'application/json, text/event-stream';
const DEFAULT_PROTOCOL_VERSION = '2025-11-25';
const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
// Headers we never copy from the upstream answer: the body is rewritten, and the real
// upstream session id is of no use to a client.
const DROP_FROM_UPSTREAM = new Set([...HOP_BY_HOP, 'content-length', 'mcp-session-id']);

function createSharedSession({ upstreamPort, log = () => {} }) {
  let counter = 0;
  let session = null; // { sid, protocolVersion, initResult }
  let establishing = null; // Promise while a session is being opened

  const nextId = () => `gw-${++counter}`;

  // ---- plumbing ----------------------------------------------------------------
  function sendUpstream({ headers, body }) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: upstreamPort,
          method: 'POST',
          path: MCP_PATH,
          headers: {
            host: `127.0.0.1:${upstreamPort}`,
            'content-type': 'application/json',
            accept: ACCEPT,
            'content-length': Buffer.byteLength(body),
            ...headers,
          },
        },
        (res) => resolve({ req, res })
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  function readAll(res) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
  }

  // Splits an SSE body into the JSON values carried by its `data:` lines.
  function sseDataValues(text) {
    const out = [];
    for (const raw of text.split(/\r?\n\r?\n/)) {
      const data = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      try {
        out.push(JSON.parse(data));
      } catch (_) {
        /* not JSON: ignore */
      }
    }
    return out;
  }

  function parseMessages(text, contentType) {
    let values;
    if (/text\/event-stream/i.test(contentType || '')) {
      values = sseDataValues(text);
    } else {
      try {
        values = [JSON.parse(text)];
      } catch (_) {
        values = [];
      }
    }
    return values.flatMap((v) => (Array.isArray(v) ? v : [v]));
  }

  // ---- the shared upstream session --------------------------------------------
  async function establish(protocolVersion) {
    const initId = nextId();
    const init = await sendUpstream({
      headers: {},
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'mcp-connectors-gateway', version: '1' },
        },
      }),
    });
    const initText = await readAll(init.res);
    if (init.res.statusCode !== 200) {
      throw new Error(`upstream initialize answered HTTP ${init.res.statusCode}`);
    }
    const sid = init.res.headers['mcp-session-id'];
    if (!sid) {
      throw new Error('upstream initialize returned no Mcp-Session-Id (is supergateway running --stateful?)');
    }
    const answer = parseMessages(initText, init.res.headers['content-type']).find(
      (m) => m && m.id === initId && m.result
    );
    if (!answer) throw new Error('upstream initialize returned no result');
    const negotiated = answer.result.protocolVersion || protocolVersion;

    const ack = await sendUpstream({
      headers: { 'mcp-session-id': sid, 'mcp-protocol-version': negotiated },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    await readAll(ack.res);
    if (ack.res.statusCode >= 300) {
      throw new Error(`upstream notifications/initialized answered HTTP ${ack.res.statusCode}`);
    }
    return { sid, protocolVersion: negotiated, initResult: answer.result };
  }

  function ensureSession(protocolVersion) {
    if (session) return Promise.resolve(session);
    if (!establishing) {
      establishing = establish(protocolVersion || DEFAULT_PROTOCOL_VERSION)
        .then((s) => {
          session = s;
          log(`opened the shared upstream session (protocol ${s.protocolVersion})`);
          return s;
        })
        .finally(() => {
          establishing = null;
        });
    }
    return establishing;
  }

  // Called with the session id that just turned out to be stale. If another request has
  // already replaced it, that replacement is used; if one is being opened, it is awaited.
  function replaceSession(staleSid, protocolVersion) {
    if (session && session.sid === staleSid) {
      session = null;
      log('the upstream session is gone, opening a new one');
    }
    return ensureSession(protocolVersion);
  }

  // ---- request side ------------------------------------------------------------
  function readClientBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error('body too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const isRequest = (m) => m && typeof m === 'object' && typeof m.method === 'string' && 'id' in m;

  function jsonReply(res, status, obj, extraHeaders) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(body);
  }

  // ---- response side: restore the client's JSON-RPC ids ---------------------------
  function restoreIds(value, idMap) {
    if (Array.isArray(value)) return value.map((v) => restoreIds(v, idMap));
    if (value && typeof value === 'object' && typeof value.id === 'string' && idMap.has(value.id)) {
      return { ...value, id: idMap.get(value.id) };
    }
    return value;
  }

  function rewriteEvent(eventText, idMap) {
    const lines = eventText.split(/\r?\n/);
    const dataIdx = [];
    lines.forEach((l, i) => {
      if (l.startsWith('data:')) dataIdx.push(i);
    });
    if (dataIdx.length === 0) return eventText;
    const data = dataIdx.map((i) => lines[i].slice(5).replace(/^ /, '')).join('\n');
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (_) {
      return eventText;
    }
    const out = [];
    lines.forEach((l, i) => {
      if (i === dataIdx[0]) out.push(`data: ${JSON.stringify(restoreIds(parsed, idMap))}`);
      else if (!dataIdx.includes(i)) out.push(l);
    });
    return out.join('\n');
  }

  function relay(upRes, res, idMap, bufferedBody) {
    const headers = {};
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (!DROP_FROM_UPSTREAM.has(k.toLowerCase())) headers[k] = v;
    }
    const contentType = upRes.headers['content-type'] || '';

    if (bufferedBody !== undefined || !/text\/event-stream/i.test(contentType)) {
      const finish = (text) => {
        let out = text;
        try {
          out = JSON.stringify(restoreIds(JSON.parse(text), idMap));
        } catch (_) {
          /* not JSON: send as received */
        }
        headers['content-length'] = Buffer.byteLength(out);
        res.writeHead(upRes.statusCode || 502, headers);
        res.end(out);
      };
      if (bufferedBody !== undefined) finish(bufferedBody);
      else readAll(upRes).then(finish, () => res.destroy());
      return;
    }

    // SSE: rewrite event by event, so a long-running call still streams.
    res.writeHead(upRes.statusCode || 502, headers);
    upRes.setEncoding('utf8');
    let buf = '';
    upRes.on('data', (chunk) => {
      buf += chunk;
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const eventText = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        res.write(`${rewriteEvent(eventText, idMap)}\n\n`);
      }
    });
    upRes.on('end', () => {
      if (buf.trim()) res.write(`${rewriteEvent(buf, idMap)}\n\n`);
      res.end();
    });
    upRes.on('error', () => res.destroy());
  }

  // ---- the handler -------------------------------------------------------------
  async function handle(req, res, upstreamPath) {
    const pathname = upstreamPath.split('?')[0];
    if (pathname !== MCP_PATH) {
      req.resume();
      return jsonReply(res, 404, { error: 'not found' });
    }
    if (req.method === 'DELETE') {
      req.resume();
      res.writeHead(204);
      return res.end();
    }
    if (req.method !== 'POST') {
      // GET would open the server->client stream, which a shared session cannot give to
      // one client alone. 405 is the answer the MCP specification allows for that.
      req.resume();
      res.writeHead(405, { Allow: 'POST, DELETE', 'Content-Type': 'application/json' });
      return res.end('{"error":"method not allowed in shared-session mode"}');
    }

    let raw;
    try {
      raw = await readClientBody(req);
    } catch (err) {
      if (err.status === 413) return jsonReply(res, 413, { error: 'request body too large' });
      return res.destroy();
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return jsonReply(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    }
    const isBatch = Array.isArray(parsed);
    const messages = isBatch ? parsed : [parsed];
    if (messages.length === 0 || !messages.every((m) => m && typeof m === 'object')) {
      return jsonReply(res, 400, { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null });
    }

    // initialize: answered here, from the shared session.
    const init = messages.find((m) => isRequest(m) && m.method === 'initialize');
    if (init) {
      if (messages.length > 1) {
        return jsonReply(res, 400, {
          jsonrpc: '2.0',
          error: { code: -32600, message: 'initialize must not be part of a batch' },
          id: init.id,
        });
      }
      try {
        const s = await ensureSession(init.params && init.params.protocolVersion);
        return jsonReply(
          res,
          200,
          { jsonrpc: '2.0', id: init.id, result: s.initResult },
          { 'Mcp-Session-Id': crypto.randomUUID() }
        );
      } catch (err) {
        log(`could not open the upstream session: ${err.message}`);
        return jsonReply(res, 502, { error: 'bad gateway' });
      }
    }

    // Notifications and responses from the client have nowhere useful to go.
    const requests = messages.filter(isRequest);
    if (requests.length === 0) {
      res.writeHead(202);
      return res.end();
    }

    // Unique upstream ids, remembered for this HTTP exchange only.
    const idMap = new Map();
    const outgoing = requests.map((m) => {
      const upId = nextId();
      idMap.set(upId, m.id);
      return { ...m, id: upId };
    });
    const body = JSON.stringify(isBatch ? outgoing : outgoing[0]);

    let up;
    let live;
    let aborted = false;
    res.on('close', () => {
      aborted = true;
      if (up && up.req) up.req.destroy();
    });
    try {
      live = await ensureSession();
      for (let attempt = 0; ; attempt++) {
        up = await sendUpstream({
          headers: { 'mcp-session-id': live.sid, 'mcp-protocol-version': live.protocolVersion },
          body,
        });
        const status = up.res.statusCode;
        if (status !== 404 && status !== 400) break;
        // Small error bodies: read them to tell "session gone" from any other 400/404.
        const errText = await readAll(up.res);
        const gone = status === 404 || /session/i.test(errText);
        if (!gone || attempt >= 1) {
          if (aborted) return;
          return relay(up.res, res, idMap, errText);
        }
        live = await replaceSession(live.sid);
      }
    } catch (err) {
      if (aborted) return;
      log(`upstream request failed: ${err.message}`);
      if (!res.headersSent) return jsonReply(res, 502, { error: 'bad gateway' });
      return res.destroy();
    }
    if (aborted) return;
    relay(up.res, res, idMap);
  }

  return { handle };
}

module.exports = { createSharedSession };
