# mcp-docker-connector

Buduje ckreiling/mcp-server-docker (przypięty commit w `UPSTREAM_REF`) + dokleja
`supergateway`, żeby wystawić to po HTTP zamiast tylko po stdio.
Publikuje do `ghcr.io/radzupl/mcp-docker-connector`.

## Jak zaktualizować do nowszej wersji upstreamu

1. Sprawdź na https://github.com/ckreiling/mcp-server-docker/commits/main co się zmieniło.
2. Podmień SHA w pliku `UPSTREAM_REF`.
3. Commit + push (albo ręcznie odpal workflow z zakładki Actions -> workflow_dispatch).

## Zmienne środowiskowe kontenera na Unraidzie

- `DOCKER_HOST` = `tcp://docker-socket-proxy:2375` (albo nazwa Twojego kontenera proxy)
- `MCP_BEARER_TOKEN` = losowy token (np. `openssl rand -hex 32`)
