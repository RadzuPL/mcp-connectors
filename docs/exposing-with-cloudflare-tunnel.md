# Exposing connectors via Cloudflare Tunnel

One concrete, worked example of getting a gateway container's port 8000 reachable at a
public HTTPS hostname, using Cloudflare Tunnel. Not the only way to do this (see the
root README for alternatives) — documented here because it's what was actually tested,
including two gotchas that cost real debugging time.

## Setup

1. Run a dedicated `cloudflared` tunnel container on the same Docker network as your
   gateway containers (a separate tunnel from any you already use for other services
   keeps this traffic's routing and rules independent of everything else).
2. In the tunnel's public hostname configuration, point each connector's hostname
   (e.g. `mcp-docker.your-domain.example`) at `http://<gateway-container-name>:8000`.
3. Add a Cloudflare **Custom Rule** (Security → WAF → Custom rules) that lets your MCP
   provider's traffic through *before* any existing rules that would otherwise block it
   (geographic restrictions, bot-fight rules, etc. all apply to the whole zone by
   default, and most AI providers' outbound IP ranges don't originate from wherever you
   normally allow traffic from).

## Gotcha 1: operator precedence in the rule expression

```
(http.host eq "mcp-docker.your-domain.example" or http.host eq "mcp-files.your-domain.example")
  and ip.src in {<provider's published IP range>}
```

`and` binds tighter than `or` in Cloudflare's rule syntax. Without the parentheses
around the hostname alternatives, the IP condition would only apply to the last host in
the list, silently leaving the others unprotected (or unreachable, depending on which
way the mistake goes). Double-check this every time you edit the rule.

Action: **Skip** — "All remaining custom rules" + "All Super Bot Fight Mode Rules".
Execution order: **first**, above your other zone rules, so `Skip` actually has
something below it to skip.

If you're adding this for Claude specifically, Anthropic publishes its current IP
ranges at https://platform.claude.com/docs/en/api/ip-addresses — that range can change
without notice, so don't treat it as permanent.

## Gotcha 2: an SSE-only server's own Host-header check, through a reverse proxy on 443

If one of your connectors bridges an SSE-only MCP server (see `metrics/`), that server
may do its own Host-header validation independent of anything Cloudflare or your tunnel
does. Standard HTTPS clients never send an explicit port for the default port 443 — and
some servers' allowlist logic assumes a port is always present, so no list of hostnames
you configure will ever match. See `metrics/README.md` for the specific bug this hit
(Glances 4.5.6) and its fix. If you hit an unexplained `421` from a server you're
exposing this way, this class of bug is worth checking for.
