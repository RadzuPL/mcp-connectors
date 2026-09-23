# mcp-connectors

Gateway containers that take an existing MCP server — often stdio-only, or speaking a
legacy transport — and re-expose it as an authenticated streamable-HTTP endpoint, so it
can be added as a custom connector in Claude or any other MCP client that speaks
streamable-HTTP.

This repo grew out of connecting an AI agent to a single home server, but nothing in it
is tied to that server. Every piece here — the gateway pattern, the read-only
enforcement, the update automation — works the same on any Docker host you point it at.

## Design principle: blast radius

Every connector gets its own container, its own bearer token, its own exposed
hostname/path, and its own access rule wherever you terminate TLS. No connector can do
more than it was built for, and that boundary is enforced **below** the MCP server
itself, not by trusting the server's own flags or the model's good behavior:

- a proxy in front of a socket/API that hard-blocks mutating calls (`POST=0` on
  `docker-socket-proxy`, in the `docker/` example), or
- a `:ro` bind mount so a filesystem server has nothing to write to, even if its own
  code has a write tool (the `files/` example).

This is defense in depth: even if a given MCP server had a bug, or a malicious change
landed in its code, the layer underneath would still stop it.

## How a connector works

```
MCP client (streamable-HTTP, bearer token)
   -> gateway container: supergateway (stdio -> streamable-HTTP, own bearer token)
       -> the wrapped MCP server (stdio)
```

If the wrapped server only speaks the legacy SSE transport instead of stdio, add one
more hop — a client-side bridge that connects to it and re-exposes it over stdio, so
`supergateway` has something it can wrap (see `metrics/` for a working example using
[`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy)):

```
MCP client (streamable-HTTP, bearer token)
   -> gateway container: supergateway (stdio -> streamable-HTTP, own bearer token)
       -> mcp-proxy (SSE client -> stdio)
           -> the wrapped MCP server (SSE transport)
```

Two independent secrets are involved, and they are never the same thing: the bearer
token the client presents to the gateway, and (only where relevant) whatever
credentials the gateway itself needs to reach the wrapped server.

## Connectors in this repo

Three example connectors are included, each wrapping a different real MCP server. Full
parameter tables and docker-compose examples live in each connector's own README.

| Connector | Folder | Wraps | Read-only enforced by |
|---|---|---|---|
| docker | [`docker/`](docker/README.md) | [`ckreiling/mcp-server-docker`](https://github.com/ckreiling/mcp-server-docker), pinned to a commit | `docker-socket-proxy` in front of it (`POST=0`) |
| files | [`files/`](files/README.md) | the official [`@modelcontextprotocol/server-filesystem`](https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem) | `:ro` bind mounts (swap for `:rw` deliberately, per folder, if you want write access) |
| metrics | [`metrics/`](metrics/README.md) | an SSE-only MCP server (built against [Glances](https://nicolargo.github.io/glances/)) via an `mcp-proxy` + `supergateway` chain | nothing to enforce — the wrapped server only exposes read-only resources and prompts, no tools |

`metrics/` is the odd one out on purpose: it doesn't vendor a single pinned upstream
like the other two, it composes two independently-versioned off-the-shelf tools. See
its README for why that means no `UPSTREAM_REF` and no auto-bump job for it.

## Exposing a gateway container

Each gateway listens on port 8000 inside its container and expects
`Authorization: Bearer <MCP_BEARER_TOKEN>`. Getting HTTPS traffic to that port is
outside the scope of this repo — put it behind whatever reverse proxy or tunnel you
already use: Cloudflare Tunnel, Tailscale Funnel/Serve, nginx + Let's Encrypt, Caddy,
anything that can terminate TLS and forward to a container. Point your MCP client at
`https://<your-host>/mcp` with that header.

If you use Cloudflare Tunnel, [`docs/exposing-with-cloudflare-tunnel.md`](docs/exposing-with-cloudflare-tunnel.md)
walks through one concrete setup, including two gotchas worth knowing about up front:
an operator-precedence trap in Cloudflare's rule expressions, and a real upstream bug
in Glances that breaks any reverse-proxied deployment on the default HTTPS port.

## Semi-automatic upstream updates

Connectors that vendor someone else's code (`ckreiling/mcp-server-docker`, the official
`@modelcontextprotocol/server-filesystem`) pin the version they build in an
`UPSTREAM_REF` file in their folder, instead of tracking `main`/`latest` live. That
version only changes through a deliberate, reviewed merge.

`check-upstream.yml` runs weekly, checks whether the upstream has something newer, and
if so opens a pull request bumping `UPSTREAM_REF` on its own. Nothing builds or
publishes automatically — merging that PR (a conscious decision) is what triggers the
real build and updates `:latest`. It's a trade-off: zero manual version-hunting, but
still a review step before anything new reaches your server.

`metrics/` is the exception: it doesn't vendor one pinned external repo, it composes two
off-the-shelf tools (`mcp-proxy`, `supergateway`) installed straight from PyPI/npm in its
Dockerfile. It has no `UPSTREAM_REF` and `check-upstream.yml` has no job for it —
bumping those package versions (including the `mcp<2.0` pin, see its README) is a manual
edit to `metrics/Dockerfile.gateway` when needed.

Every built image gets an immutable tag alongside `:latest`, so you can always roll back
to a specific build. Images publish to `ghcr.io/<your-github-user-or-org>/<this-repo>/<connector>`
automatically — nothing to edit, the workflows derive the path from the repo they run in.

**One-time setup:** in your repo's Settings → Actions → General → Workflow permissions,
check "Allow GitHub Actions to create and approve pull requests" — otherwise
`check-upstream.yml` won't be able to open its PRs.

## Adding a new connector

1. New top-level folder (e.g. `metrics/`).
2. `Dockerfile.gateway` in that folder, plus `UPSTREAM_REF` if it vendors someone else's
   pinned code (skip it if, like `metrics/`, it only composes independently-versioned
   off-the-shelf tools — see that folder's README for the reasoning).
3. `.github/workflows/build-<name>.yml`, triggered on `paths` scoped to that folder's
   files only, so it doesn't rebuild on unrelated changes.
4. If it should track an upstream, add a second job to `check-upstream.yml`.
5. A new public hostname and a matching access rule wherever you expose it, plus a new
   connector configured in your MCP client with its own token.
6. A `README.md` in the folder: what it wraps, its parameter table, a docker-compose
   example, and any caveats specific to it.

## License

MIT — see [LICENSE](LICENSE).
