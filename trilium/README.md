# trilium

MCP connector for [TriliumNext](https://github.com/TriliumNext/Trilium) built on its ETAPI. Made for planning and writing together with Claude (RPG scenarios, notes, a wiki): a tree of notes, links between them, labels and relations. Zero dependencies, same gateway as the other connectors in this repo.

Image: `ghcr.io/radzupl/mcp-connectors/trilium:latest`

## Safety model

| Switch | Effect |
|---|---|
| (default) | read-only: `status`, `search_notes`, `get_note`, `get_tree`, `recent_changes` |
| `TRILIUM_ENABLE_WRITE=true` | adds `create_note`, `update_note`, `move_note`, `clone_note`, `set_label`, `set_relation`, `remove_attribute`, `day_note`, `undelete_note`, `create_backup` |
| `TRILIUM_ENABLE_DESTRUCTIVE=true` (needs write) | adds `delete_note` (soft delete, `undelete_note` brings it back) |

An ETAPI token has no scopes, so unlike Nametag the read-only switch lives in this process (it refuses every non-GET request). Safety nets: every content change first saves a note revision and is refused if that fails; deletes are soft; `create_backup` writes a database backup. Import, export and auth routes are never reachable. Protected notes cannot be read or changed (ETAPI cannot open a protected session).

## Links between notes

In text notes write `[[noteId]]` for a reference link (shows the note's title) or `[[noteId|label]]` for a link with your own text. The connector converts these to Trilium's HTML and back, and refuses ids that do not exist. `get_note` shows links in the same form and lists the titles behind them. Relations (`set_relation`) give typed links such as `~npc`, which Trilium can show and search. Markdown notes (`format=markdown`) are stored as typed, since `[[noteId]]` is native there.

The href format of a link is one constant (`REF_PREFIX` in `server.js`). If your Trilium version writes links differently, change it in one place.

## Setup

1. In Trilium: Options → ETAPI → create a token. Put it in `/mnt/user/appdata/mcp-trilium/trilium_etapi_token`.
2. Generate the bearer token Claude will use: `openssl rand -hex 32 > /mnt/user/appdata/mcp-trilium/bearer_token`.
3. Add the container from `unraid/mcp-trilium-connector.xml` (network `mcp_network`, same as Trilium so that `TRILIUM_URL=http://triliumnext:8080` works).
4. Expose it like the other connectors: see `docs/exposing-with-cloudflare-tunnel.md`; the hostname points to `http://mcp-trilium-connector:8000`, path `/mcp`.

## Environment

| Variable | Meaning |
|---|---|
| `TRILIUM_URL` | address of Trilium, e.g. `http://triliumnext:8080` |
| `TRILIUM_TOKEN_FILE` | file with the ETAPI token (`TRILIUM_TOKEN` also works, the file is preferred) |
| `MCP_BEARER_TOKEN_FILE` | file with the bearer token checked by the gateway |
| `TRILIUM_ENABLE_WRITE`, `TRILIUM_ENABLE_DESTRUCTIVE` | see above |

## Tests

`node trilium/test-server.js` runs the tools against an in-memory mock of the ETAPI.
