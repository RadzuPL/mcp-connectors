'use strict';
// docker-lite: a deliberately small, read-only MCP server for Docker.
//
// Why it exists: ckreiling/mcp-server-docker returns raw Docker API objects and whole log
// dumps, and advertises ~20 tools with long schemas. That inflates the model's context
// (tokens) and clients cut oversized results. This server answers with short plain text
// and lets the caller ask for exactly what it needs:
//
//   ps       one line per container
//   logs     tail / since / grep / hard character budget, ANSI stripped, repeats collapsed
//   inspect  a ~10 line summary; environment variable NAMES only, never their values
//
// It talks to the Docker API with plain GET requests only, through DOCKER_HOST
// (tcp://docker-socket-proxy:2375 or unix:///var/run/docker.sock). No dependencies:
// Node core modules only; MCP over stdio (line-delimited JSON-RPC), wrapped by
// supergateway like every other gateway image in this repo.

const http = require('http');
const readline = require('readline');

const MAX_API_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 20000; // absolute ceiling for any single tool result
const LOG_SCAN_LINES = 5000; // how far back `grep` looks when no `since` is given
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

class ToolError extends Error {}

// ---------------------------------------------------------------- Docker API

function dockerTarget() {
  const host = process.env.DOCKER_HOST || 'unix:///var/run/docker.sock';
  if (host.startsWith('unix://')) return { socketPath: host.slice('unix://'.length) };
  const m = /^(?:tcp|http):\/\/([^:/]+)(?::(\d+))?/.exec(host);
  if (!m) throw new ToolError(`unsupported DOCKER_HOST: ${host}`);
  return { host: m[1], port: parseInt(m[2] || '2375', 10) };
}

function dockerGet(path) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = dockerTarget();
    } catch (err) {
      return reject(err);
    }
    const req = http.request({ ...target, path, method: 'GET', timeout: 20000 }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_API_BYTES) {
          req.destroy(new ToolError('Docker API response too large; narrow the request (smaller tail / since)'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new ToolError('Docker API timeout')));
    req.on('error', reject);
    req.end();
  });
}

function proxyHint(path) {
  const p = path.split('?')[0];
  if (/\/containers\//.test(p) || /\/containers$/.test(p) || /\/containers\/json/.test(p)) return 'CONTAINERS=1';
  return 'the matching switch';
}

async function dockerJson(path) {
  const res = await dockerGet(path);
  if (res.status === 200) return JSON.parse(res.body.toString('utf8'));
  throw apiFailure(path, res);
}

function apiFailure(path, res) {
  let msg = '';
  try {
    msg = JSON.parse(res.body.toString('utf8')).message || '';
  } catch (_) {
    msg = res.body.toString('utf8').slice(0, 200);
  }
  if (res.status === 403) {
    return new ToolError(`403 from docker-socket-proxy: ${path.split('?')[0]} is not enabled (set ${proxyHint(path)} on the proxy)`);
  }
  if (res.status === 404) return new ToolError(`not found: ${msg || path.split('?')[0]}`);
  return new ToolError(`Docker API ${res.status}: ${msg.slice(0, 200)}`);
}

function checkName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new ToolError('container must be a container name or id (letters, digits, _ . -)');
  }
  return encodeURIComponent(name);
}

// --------------------------------------------------------------- formatting

function cap(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n[output cut at ${max} chars]`;
}

function shortImage(image) {
  let s = String(image || '').replace(/@sha256:[0-9a-f]+$/, '');
  if (/^sha256:/.test(s)) s = s.slice(7, 19);
  s = s.replace(/^docker\.io\//, '').replace(/^library\//, '');
  return s.length > 60 ? s.slice(0, 59) + '…' : s;
}

function compactPorts(ports) {
  const seen = new Set();
  for (const p of ports || []) {
    if (p.PublicPort) seen.add(`${p.PublicPort}>${p.PrivatePort}`);
  }
  return [...seen].join(',');
}

function oneLine(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// ------------------------------------------------------------------- logs

function demux(buf) {
  const multiplexed = buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!multiplexed) return buf.toString('utf8');
  const parts = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off + 4);
    parts.push(buf.subarray(off + 8, off + 8 + len));
    off += 8 + len;
  }
  return Buffer.concat(parts).toString('utf8');
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function collapseRepeats(lines) {
  const out = [];
  let prev = null;
  let n = 0;
  const flush = () => {
    if (prev !== null) out.push(n > 1 ? `${prev} (x${n})` : prev);
  };
  for (const l of lines) {
    if (l === prev) {
      n += 1;
    } else {
      flush();
      prev = l;
      n = 1;
    }
  }
  flush();
  return out;
}

function formatLogs(rawText, opts) {
  const { tail, grep, maxChars, lineMax, timestamps } = opts;
  let lines = rawText.replace(ANSI_RE, '').replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (timestamps) {
    lines = lines.map((l) => l.replace(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.\d+Z /, '$1Z '));
  }
  const scanned = lines.length;
  if (grep) {
    let re;
    try {
      re = new RegExp(grep, 'i');
    } catch (err) {
      throw new ToolError(`invalid grep regex: ${err.message}`);
    }
    lines = lines.filter((l) => re.test(l));
  }
  if (!timestamps) lines = collapseRepeats(lines);
  lines = lines.map((l) => (l.length > lineMax ? l.slice(0, lineMax - 1) + '…' : l));
  const total = lines.length;
  if (lines.length > tail) lines = lines.slice(-tail);

  // Character budget: keep the newest lines.
  let used = 0;
  let start = lines.length;
  while (start > 0 && used + lines[start - 1].length + 1 <= maxChars) {
    used += lines[start - 1].length + 1;
    start -= 1;
  }
  const kept = lines.slice(start);
  const cutByBudget = start > 0;

  const what = grep ? 'matching lines' : 'lines';
  const header =
    `[${kept.length} of ${total} ${what}` +
    (grep ? `, searched ${scanned}` : '') +
    (cutByBudget ? `, older ones cut by max_chars=${maxChars}` : '') +
    ']';
  return kept.length ? `${header}\n${kept.join('\n')}` : `${header}\n(no output)`;
}

function parseSince(value) {
  const s = String(value).trim();
  let m = /^(\d+)\s*([smhd])$/i.exec(s);
  if (m) {
    const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()];
    return Math.floor(Date.now() / 1000) - parseInt(m[1], 10) * mult;
  }
  if (/^\d{9,}$/.test(s)) return parseInt(s, 10);
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return Math.floor(t / 1000);
  throw new ToolError('since must look like 30m, 2h, 1d, a unix timestamp or an ISO date');
}

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// ------------------------------------------------------------------ tools

async function toolPs(args) {
  const all = args.all === true;
  const filter = typeof args.name === 'string' ? args.name.toLowerCase() : '';
  const list = await dockerJson(`/containers/json?all=${all ? 1 : 0}`);
  let rows = list.map((c) => ({
    name: String((c.Names && c.Names[0]) || c.Id.slice(0, 12)).replace(/^\//, ''),
    status: c.Status || c.State || '',
    image: shortImage(c.Image),
    ports: compactPorts(c.Ports),
  }));
  if (filter) rows = rows.filter((r) => r.name.toLowerCase().includes(filter));
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const running = list.filter((c) => c.State === 'running').length;
  const head = `${rows.length} containers${filter ? ` matching "${filter}"` : ''}${all ? '' : ' (running only)'}; ${running} running`;
  if (!rows.length) return head;
  return cap(`${head}\nname | status | image | ports\n` + rows.map((r) => [r.name, r.status, r.image, r.ports].join(' | ')).join('\n'));
}

async function toolLogs(args) {
  const id = checkName(args.container);
  const tail = clampInt(args.tail, 40, 1, 1000);
  const maxChars = clampInt(args.max_chars, 4000, 200, MAX_OUTPUT_CHARS);
  const grep = typeof args.grep === 'string' && args.grep !== '' ? args.grep : '';
  const timestamps = args.timestamps === true;
  let q = `stdout=1&stderr=1&tail=${grep ? LOG_SCAN_LINES : tail}`;
  if (args.since !== undefined && args.since !== '') q += `&since=${parseSince(args.since)}`;
  if (timestamps) q += '&timestamps=1';
  const path = `/containers/${id}/logs?${q}`;
  const res = await dockerGet(path);
  if (res.status !== 200) throw apiFailure(path, res);
  return cap(formatLogs(demux(res.body), { tail, grep, maxChars, lineMax: 300, timestamps }), MAX_OUTPUT_CHARS + 200);
}

async function toolInspect(args) {
  const id = checkName(args.container);
  const j = await dockerJson(`/containers/${id}/json`);
  const st = j.State || {};
  const hc = j.HostConfig || {};
  const cfg = j.Config || {};
  const out = [];
  out.push(`name: ${String(j.Name || '').replace(/^\//, '')}`);
  out.push(`image: ${shortImage(cfg.Image || j.Image)}`);
  out.push(
    `state: ${st.Status || '?'}${st.Running ? ` since ${st.StartedAt}` : ''}; restarts ${j.RestartCount ?? 0}; policy ${(hc.RestartPolicy && hc.RestartPolicy.Name) || 'no'}`
  );
  if (!st.Running || st.ExitCode || st.OOMKilled || st.Error) {
    out.push(
      `last exit: code ${st.ExitCode ?? '?'}${st.OOMKilled ? ', OOM killed' : ''}${st.Error ? `, error: ${oneLine(st.Error, 200)}` : ''}; finished ${st.FinishedAt || '?'}`
    );
  }
  if (st.Health) {
    const last = (st.Health.Log || []).slice(-1)[0];
    out.push(`health: ${st.Health.Status}${last && last.Output ? `; last check: ${oneLine(last.Output, 200)}` : ''}`);
  }
  const ports = [];
  for (const [k, v] of Object.entries((j.NetworkSettings && j.NetworkSettings.Ports) || {})) {
    if (v && v.length) ports.push(`${[...new Set(v.map((x) => x.HostPort))].join('/')}>${k}`);
  }
  if (ports.length) out.push(`ports: ${ports.join(', ')}`);
  const nets = Object.entries((j.NetworkSettings && j.NetworkSettings.Networks) || {}).map(
    ([n, v]) => `${n}${v && v.IPAddress ? ' ' + v.IPAddress : ''}`
  );
  out.push(`network: ${hc.NetworkMode === 'host' ? 'host' : nets.join(', ') || 'none'}`);
  const mounts = (j.Mounts || []).slice(0, 15).map((m) => `${m.Source || m.Name || '?'} -> ${m.Destination}${m.RW === false ? ' (ro)' : ''}`);
  if (mounts.length) out.push(`mounts: ${mounts.join('; ')}${(j.Mounts || []).length > 15 ? '; …' : ''}`);
  const keys = (cfg.Env || []).map((e) => String(e).split('=')[0]);
  if (keys.length) out.push(`env names (values hidden): ${keys.join(', ')}`);
  if (hc.Memory) out.push(`memory limit: ${Math.round(hc.Memory / 1048576)} MiB`);
  return cap(out.join('\n'));
}

const TOOLS = [
  {
    name: 'ps',
    description: 'List containers, one line each: name | status | image | published ports.',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'include stopped (default false)' },
        name: { type: 'string', description: 'case-insensitive substring of the name' },
      },
    },
    run: toolPs,
  },
  {
    name: 'logs',
    description:
      'Container logs, compact (ANSI stripped, repeated lines collapsed, newest kept). Prefer small tail, or grep/since, over big dumps.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'name or id' },
        tail: { type: 'integer', description: 'lines to return, default 40, max 1000' },
        since: { type: 'string', description: 'e.g. 30m, 2h, 1d' },
        grep: { type: 'string', description: 'case-insensitive regex; searches the last 5000 lines (or the since window)' },
        max_chars: { type: 'integer', description: 'size budget, default 4000, max 20000' },
        timestamps: { type: 'boolean', description: 'prefix lines with time (default false)' },
      },
      required: ['container'],
    },
    run: toolLogs,
  },
  {
    name: 'inspect',
    description: 'Short summary of one container: state, exit code, restarts, health, ports, networks, mounts, env names (no values).',
    inputSchema: {
      type: 'object',
      properties: { container: { type: 'string', description: 'name or id' } },
      required: ['container'],
    },
    run: toolInspect,
  },
];

// -------------------------------------------------------------------- MCP

function describeError(err) {
  if (err instanceof ToolError) return err.message;
  const code = err && (err.code || err.message);
  return `cannot reach the Docker API (${code})`;
}

async function handleRequest(msg) {
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'docker-lite', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call': {
      const p = msg.params || {};
      const tool = TOOLS.find((t) => t.name === p.name);
      if (!tool) {
        const e = new Error(`unknown tool: ${p.name}`);
        e.rpcCode = -32602;
        throw e;
      }
      try {
        const text = await tool.run(p.arguments || {});
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: describeError(err) }], isError: true };
      }
    }
    default: {
      const e = new Error(`method not found: ${msg.method}`);
      e.rpcCode = -32601;
      throw e;
    }
  }
}

function main() {
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const pending = new Set();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      return;
    }
    if (!msg || msg.id === undefined || msg.id === null) return; // notification
    const job = handleRequest(msg)
      .then((result) => send({ jsonrpc: '2.0', id: msg.id, result }))
      .catch((err) => send({ jsonrpc: '2.0', id: msg.id, error: { code: err.rpcCode || -32603, message: err.message } }))
      .finally(() => pending.delete(job));
    pending.add(job);
  });
  rl.on('close', () => {
    Promise.all([...pending]).then(() => process.exit(0));
  });
}

module.exports = { demux, formatLogs, parseSince, shortImage, compactPorts, handleRequest, TOOLS, ToolError };

if (require.main === module) main();
