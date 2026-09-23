# metrics connector

An example of bridging an **SSE-only** MCP server into streamable-HTTP. Built and
tested against [Glances](https://nicolargo.github.io/glances/) (`--enable-mcp`), but the
technique — an `mcp-proxy` client bridge in front of `supergateway` — works for any MCP
server that only speaks the legacy SSE transport, not just Glances.

## Why the extra hop

Glances' MCP server (like some other SSE-only servers) exposes two endpoints
(`/mcp/sse` for the event stream, `/mcp/messages/` for JSON-RPC) instead of a single
streamable-HTTP endpoint. MCP clients that expect streamable-HTTP can't talk to that
directly. [`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy) connects to the SSE
server **as a client** and re-exposes it over stdio; `supergateway` then wraps that
stdio and exposes it as streamable-HTTP with its own bearer token — exactly like the
`docker/` and `files/` connectors.

```
MCP client (streamable-HTTP, bearer token)
   -> mcp-metrics-connector: supergateway (stdio -> streamable-HTTP)
       -> mcp-proxy (SSE client -> stdio)
           -> the wrapped MCP server (SSE transport, Basic Auth)
```

## Why there's no `UPSTREAM_REF` here

Unlike `docker/` and `files/`, this folder doesn't vendor one pinned external repo — it
composes two independently-versioned, off-the-shelf tools (`mcp-proxy` from PyPI,
`supergateway` from npm) directly in the Dockerfile. There's nothing for a single
`UPSTREAM_REF` to pin, so this folder deliberately has none, and `check-upstream.yml`
has no job tracking it. Bump package versions by hand in `Dockerfile.gateway` when
needed.

## A real version pin you should keep

`Dockerfile.gateway` pins `"mcp<2.0"` alongside `mcp-proxy`:

```dockerfile
RUN pip install --no-cache-dir "mcp<2.0" mcp-proxy
```

This isn't a style choice — it's a genuine incompatibility between two PyPI packages.
`mcp-proxy` 0.12.0 (the latest release at the time this was built) imports `request_ctx`
from `mcp.server.lowlevel.server`; the `mcp` SDK removed/relocated that in its 2.x
releases. Install both at their current latest versions and the container crash-loops
on startup with `ImportError: cannot import name 'request_ctx'`. Re-check this pin if
you bump either package.

## Your SSE server needs to allow the Host header it'll actually see

If you put this behind a reverse proxy on the default HTTPS port (443), the client
never sends an explicit port in its `Host` header. Some MCP servers' host-allowlist
checks assume a port is always present and never match in that case — Glances 4.5.6 has
exactly this bug (`_build_transport_security()` appends `:*` to every bare hostname in
`mcp_allowed_hosts`, and the SDK's wildcard-port matching requires the incoming `Host`
header to literally start with `"<host>:"`, which a default-port HTTPS client never
sends). No list of hostnames can work around it. If you hit a `421 Invalid Host header`
here, the fix on the Glances side is `mcp_allowed_hosts=*` — Glances' own documented
escape hatch, with a logged warning that you need a trusted reverse proxy in front of
it (which, if you're reading this, you do).

## No tools — resources and prompts only

Glances' MCP server exposes **resources and prompts, not tools**:
`glances://stats`, `glances://stats/{plugin}`, `glances://limits`, `glances://plugins`;
prompts `system_health_summary`, `alert_analysis`, `top_processes_report`,
`storage_health`. Your MCP client can't call anything on this connector mid-conversation
the way it would call a tool — you (or the model, if your client supports it) have to
manually attach a resource first (e.g. "All stats"), and only then does the assistant
have data to work with. A client showing "no tools available" for this connector is
expected, not a sign anything is broken.

## Configuration

| Variable | Set on | Required | Example | Notes |
|---|---|---|---|---|
| `GLANCES_SSE_URL` | `mcp-metrics-connector` | yes | `http://glances-host:61208/mcp/sse` | the wrapped server's SSE endpoint |
| `GLANCES_USER` | `mcp-metrics-connector` | yes | `claude` | Basic Auth login for the wrapped server |
| `GLANCES_PASSWORD` | `mcp-metrics-connector` | yes | — | Basic Auth password |
| `MCP_BEARER_TOKEN` | `mcp-metrics-connector` | yes | a random 32+ char string | token your MCP client sends as `Authorization: Bearer ...` — unrelated to the Basic Auth credentials above, a separate layer |

## docker-compose example

```yaml
services:
  mcp-metrics-connector:
    build:
      context: .
      dockerfile: metrics/Dockerfile.gateway
    # or: image: ghcr.io/<your-github-user>/<your-repo>/metrics:latest
    environment:
      GLANCES_SSE_URL: http://your-glances-host:61208/mcp/sse
      GLANCES_USER: claude
      GLANCES_PASSWORD: ${GLANCES_PASSWORD}
      MCP_BEARER_TOKEN: ${MCP_METRICS_BEARER_TOKEN}
    networks: [mcp]
    restart: unless-stopped

networks:
  mcp:
    driver: bridge
```

Expose port 8000 as described in the root README, and add it to your MCP client as
`https://<your-host>/mcp` with `Authorization: Bearer <MCP_METRICS_BEARER_TOKEN>`.
