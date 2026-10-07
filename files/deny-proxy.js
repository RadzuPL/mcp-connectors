'use strict';
/*
 * Policy proxy between supergateway and mcp-server-filesystem (stdio, one JSON
 * message per line).
 *
 *   node deny-proxy.js mcp-server-filesystem /data/a /data/b
 *
 * Everything after the command name is the list of allowed directories, exactly as
 * the server gets it. Policy comes from DENY_NAMES / ALLOW_ONLY / READ_ONLY (see
 * deny-policy.js). With none of them set the server is started untouched.
 *
 * What it does when a policy is set:
 *   - tools/call is checked before it reaches the server; a refused call is answered
 *     here and the server never sees it;
 *   - results of list/tree/search tools are rewritten so hidden names do not show up;
 *   - only the MCP methods listed in ALLOWED_METHODS are passed on;
 *   - anything it cannot parse or does not understand is refused, not forwarded.
 */
const { spawn } = require('child_process');
const { createPolicy, parseEnv, errorResult } = require('./deny-policy');

const ALLOWED_METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call']);

function log(msg) { process.stderr.write(`[deny-proxy] ${msg}\n`); }

function main() {
  const [command, ...roots] = process.argv.slice(2);
  if (!command) { log('usage: deny-proxy.js <server command> <allowed dir>...'); process.exit(2); }

  let cfg;
  try { cfg = parseEnv(process.env); } catch (e) { log(`refusing to start: ${e.message}`); process.exit(2); }

  if (!cfg.active) {
    // No policy configured: behave exactly like running the server directly.
    const child = spawn(command, roots, { stdio: 'inherit' });
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
    child.on('exit', (code, sig) => process.exit(code === null ? (sig ? 143 : 1) : code));
    child.on('error', (e) => { log(`cannot start ${command}: ${e.message}`); process.exit(1); });
    return;
  }

  let policy;
  try {
    policy = createPolicy({ roots, denyNames: cfg.denyNames, allowOnly: cfg.allowOnly, readOnly: cfg.readOnly });
  } catch (e) { log(`refusing to start: ${e.message}`); process.exit(2); }
  log(`policy on: DENY_NAMES=[${cfg.denyNames.join(',')}] ALLOW_ONLY rules=${cfg.allowOnly.length} READ_ONLY=${cfg.readOnly}`);

  const child = spawn(command, roots, { stdio: ['pipe', 'pipe', 'inherit'] });
  child.on('error', (e) => { log(`cannot start ${command}: ${e.message}`); process.exit(1); });
  child.on('exit', (code, sig) => process.exit(code === null ? (sig ? 143 : 1) : code));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
  process.on('exit', () => { try { child.kill(); } catch (e) { /* already gone */ } });

  const pending = new Map(); // JSON id -> context of a call whose result must be filtered
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const toChild = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
  const keyOf = (id) => JSON.stringify(id);

  function fromClient(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    }
    if (typeof msg.method !== 'string') {
      // A reply of the client to a request of the server (ping, roots/list).
      if ('result' in msg || 'error' in msg) return toChild(msg);
      return send({ jsonrpc: '2.0', id: msg.id === undefined ? null : msg.id, error: { code: -32600, message: 'Invalid Request' } });
    }
    const isRequest = msg.id !== undefined && msg.id !== null;

    if (msg.method === 'tools/call') {
      const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
      const verdict = policy.vetToolCall(params.name, params.arguments);
      if (!verdict.ok) {
        log(`denied ${params.name}: ${verdict.reason}`);
        if (isRequest) send({ jsonrpc: '2.0', id: msg.id, result: errorResult(`Access denied by the connector policy: ${verdict.reason}`) });
        return;
      }
      if (isRequest && verdict.filter) pending.set(keyOf(msg.id), { filter: verdict.filter, args: verdict.args });
      return toChild(msg);
    }

    if (ALLOWED_METHODS.has(msg.method) || msg.method.startsWith('notifications/')) return toChild(msg);

    log(`refused method ${msg.method}`);
    if (isRequest) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not allowed by the connector policy' } });
  }

  function fromChildMessage(msg) {
    if (msg && typeof msg === 'object' && 'result' in msg && msg.id !== undefined && msg.id !== null) {
      const ctx = pending.get(keyOf(msg.id));
      if (ctx) {
        pending.delete(keyOf(msg.id));
        try {
          msg = { ...msg, result: policy.filterResult(ctx, msg.result) };
        } catch (e) {
          log(`could not filter a ${ctx.filter} result safely: ${e.message}`);
          msg = { jsonrpc: '2.0', id: msg.id, result: errorResult('The connector policy could not safely filter this result.') };
        }
      }
    } else if (msg && typeof msg === 'object' && 'error' in msg && msg.id !== undefined) {
      pending.delete(keyOf(msg.id));
    }
    send(msg);
  }

  function lines(stream, onLine) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    });
    stream.on('end', () => { if (buf.trim()) onLine(buf); });
  }

  lines(process.stdin, (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch (e) {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    // Batches are not part of current MCP; each member is handled on its own.
    (Array.isArray(msg) ? msg : [msg]).forEach(fromClient);
  });
  process.stdin.on('end', () => child.stdin.end());

  lines(child.stdout, (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch (e) {
      log('dropped a line from the server that is not JSON');
      return;
    }
    (Array.isArray(msg) ? msg : [msg]).forEach(fromChildMessage);
  });
}

main();
