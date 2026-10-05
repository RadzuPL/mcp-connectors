'use strict';
// Tiny authenticating reverse proxy placed in front of supergateway.
//
// Why this exists: supergateway's `--oauth2Bearer` only ADDS an Authorization
// header; it does not check the header of incoming requests (verified: a
// gateway started with it answers 200 without any token). This proxy is the
// piece that actually enforces the token.
//
// Only Node core modules are used, so nothing is installed at build time.
//
// Environment:
//   MCP_BEARER_TOKEN_FILE   path to a file containing the token (preferred:
//                           keeps the token out of `docker inspect`)
//   MCP_BEARER_TOKEN        the token itself (fallback if no file is given)
//   MCP_ALLOW_PATH_TOKEN    "true" also accepts the token as the first URL path
//                           segment (/<token>/mcp), for clients that cannot send
//                           an Authorization header. Off by default, because
//                           URLs end up in logs.
//   LISTEN_PORT             default 8000
//   UPSTREAM_PORT           default 8001 (supergateway, on 127.0.0.1)

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || '8000', 10);
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || '8001', 10);
const ALLOW_PATH_TOKEN = String(process.env.MCP_ALLOW_PATH_TOKEN || '').toLowerCase() === 'true';
const MIN_TOKEN_LENGTH = 24;

function loadToken() {
  const file = process.env.MCP_BEARER_TOKEN_FILE;
  let token = '';
  if (file) {
    try {
      token = fs.readFileSync(file, 'utf8').trim();
    } catch (err) {
      console.error(`auth-proxy: cannot read MCP_BEARER_TOKEN_FILE (${file}): ${err.code || err.message}`);
      process.exit(2);
    }
  } else {
    token = (process.env.MCP_BEARER_TOKEN || '').trim();
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    // Refuse to start rather than run with a missing or trivially short token.
    console.error(
      `auth-proxy: token missing or shorter than ${MIN_TOKEN_LENGTH} characters; ` +
        'set MCP_BEARER_TOKEN_FILE (or MCP_BEARER_TOKEN). Refusing to start.'
    );
    process.exit(2);
  }
  return token;
}

const TOKEN = loadToken();
const TOKEN_HASH = crypto.createHash('sha256').update(TOKEN).digest();

// Constant-time comparison; hashing first makes the buffers equal length.
function tokenMatches(candidate) {
  const h = crypto.createHash('sha256').update(String(candidate)).digest();
  return crypto.timingSafeEqual(h, TOKEN_HASH);
}

function headerTokenOk(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers['authorization'] || '');
  return Boolean(m) && tokenMatches(m[1]);
}

// Returns the upstream path if the request carries the token as the first path
// segment, otherwise null. Only used when MCP_ALLOW_PATH_TOKEN=true.
function pathTokenUpstream(url) {
  if (!ALLOW_PATH_TOKEN) return null;
  const q = url.indexOf('?');
  const pathname = q === -1 ? url : url.slice(0, q);
  const rest = q === -1 ? '' : url.slice(q);
  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m || !tokenMatches(m[1])) return null;
  return (m[2] || '/') + rest;
}

function deny(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Bearer',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end('{"error":"unauthorized"}');
}

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

const server = http.createServer((req, res) => {
  let upstreamPath = null;
  if (headerTokenOk(req)) {
    upstreamPath = req.url;
  } else {
    upstreamPath = pathTokenUpstream(req.url);
  }
  if (upstreamPath === null) {
    req.resume(); // drop the body, do not let it reach the upstream
    return deny(res);
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === 'authorization' || key === 'host') continue;
    headers[k] = v;
  }
  headers.host = `127.0.0.1:${UPSTREAM_PORT}`;

  const upstream = http.request(
    { host: '127.0.0.1', port: UPSTREAM_PORT, method: req.method, path: upstreamPath, headers },
    (upRes) => {
      const outHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v;
      }
      res.writeHead(upRes.statusCode || 502, outHeaders);
      upRes.pipe(res); // streams SSE / streamable-HTTP chunks as they arrive
    }
  );

  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end('{"error":"bad gateway"}');
    } else {
      res.destroy();
    }
  });
  res.on('close', () => upstream.destroy());

  req.pipe(upstream);
});

// Long-lived streams are normal for MCP; do not cut them off.
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.keepAliveTimeout = 65000;

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.error(
    `auth-proxy: listening on :${LISTEN_PORT}, upstream 127.0.0.1:${UPSTREAM_PORT}, ` +
      `path-token mode ${ALLOW_PATH_TOKEN ? 'ON' : 'off'}`
  );
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
