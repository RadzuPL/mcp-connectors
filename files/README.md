# files connector

Wraps the official [`@modelcontextprotocol/server-filesystem`](https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem),
pinned to the npm version in [`UPSTREAM_REF`](UPSTREAM_REF), and adds
[`supergateway`](https://github.com/supercorp-ai/supergateway) to expose it as
streamable-HTTP.

## Read-only vs read-write — a deliberate per-folder choice

The MCP server itself has no built-in, unbypassable "read-only" mode — the tools it
exposes are whatever its own code defines. Read-only enforcement here happens one layer
down, where the server has nothing left to say about it: mount the folder you're
sharing with `:ro` and it is physically impossible to write to it, no matter what the
server's code allows.

Whether to use `:ro` or `:rw` is a decision you make per mounted folder, based on how
much you trust write access to that specific directory — not a global default. If you
mount something `:rw`, know what you're accepting: the upstream server **has no delete
tool** (only read/write/edit/move/create — that's an upstream API design choice, not
something enforced here), so nothing can be permanently removed through this connector,
only overwritten, appended to, or moved. If you need to guarantee against writes, `:ro`
is what actually enforces it — don't rely on not asking for write tools.

## Configuration

| Variable | Set on | Required | Example | Notes |
|---|---|---|---|---|
| `ALLOWED_DIRS` | `mcp-files-connector` | yes | `/data` | path(s) inside the container the server exposes |
| `MCP_FS_VERSION` | build arg | yes | value of `UPSTREAM_REF` | pins the npm package version at build time |
| `MCP_BEARER_TOKEN` | `mcp-files-connector` | yes | a random 32+ char string | token your MCP client sends as `Authorization: Bearer ...` |
| bind mount mode | compose/host | yes | `:ro` or `:rw` | see above — pick deliberately per folder |

## docker-compose example

```yaml
services:
  mcp-files-connector:
    build:
      context: .
      dockerfile: files/Dockerfile.gateway
      args:
        MCP_FS_VERSION: "2026.8.31"   # keep in sync with UPSTREAM_REF
    # or: image: ghcr.io/<your-github-user>/<your-repo>/files:latest
    environment:
      ALLOWED_DIRS: /data
      MCP_BEARER_TOKEN: ${MCP_FILES_BEARER_TOKEN}
    volumes:
      - /path/on/host:/data:ro   # switch to :rw only if you deliberately want write access
    networks: [mcp]
    restart: unless-stopped

networks:
  mcp:
    driver: bridge
```

Expose port 8000 as described in the root README, and add it to your MCP client as
`https://<your-host>/mcp` with `Authorization: Bearer <MCP_FILES_BEARER_TOKEN>`.
