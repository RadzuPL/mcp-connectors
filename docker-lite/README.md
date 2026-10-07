# docker-lite connector

A small, read-only Docker MCP server written for this repo, behind the same authenticating
front end as the other connectors ([`../gateway/`](../gateway/README.md)). It replaces
[`../docker/`](../docker/README.md) (ckreiling/mcp-server-docker) when the goal is **less
context sent to the model**: that server returns raw Docker API objects and whole log
dumps, and advertises about twenty tools with long schemas. Clients cut results that are
too long, and every token of it is paid for on each call.

## Tools

| Tool | Returns |
|---|---|
| `ps` | one line per container: `name \| status \| image \| published ports`. Args: `all`, `name` (substring) |
| `logs` | compact log text. Args: `container`, `tail` (default 40, max 1000), `since` (`30m`, `2h`, `1d`), `grep` (regex, searches the last 5000 lines or the `since` window), `max_chars` (default 4000, max 20000), `timestamps` |
| `inspect` | about ten lines: state, exit code / OOM, restarts, health, ports, networks, mounts, **env variable names only** |

What `logs` does to keep output small: strips ANSI colour codes, collapses consecutive
identical lines (`... (x20)`), cuts lines longer than 300 characters, and when over budget
keeps the **newest** lines and says how many were dropped in a one-line header.

Not included on purpose: images, networks, volumes, and every write operation. The write
operations never worked anyway (the proxy answers `403`, see below); they only cost tokens
in the tool list.

## Architecture and security

```
MCP client (streamable-HTTP, bearer token)
   -> mcp-docker-lite (token check + supergateway, stdio -> streamable-HTTP)
       -> docker-socket-proxy (POST=0, read-only)
           -> /var/run/docker.sock
```

Same layout as `docker/`: the server only ever sends `GET` requests, and
`docker-socket-proxy` with `POST=0` enforces that independently of this code. It needs
`CONTAINERS=1` on the proxy; nothing else. If an endpoint is not enabled, the tool answers
with a one-line message naming the proxy switch instead of a stack trace.

Environment variable **values** never leave the container: `inspect` prints names only,
and `ps` never prints labels.

## Configuration

| Variable | Set on | Required | Example | Notes |
|---|---|---|---|---|
| `CONTAINERS` | `docker-socket-proxy` | yes | `1` | the only read endpoint this connector uses |
| `POST` | `docker-socket-proxy` | yes | `0` | the read-only enforcement |
| `DOCKER_HOST` | `mcp-docker-lite` | yes | `tcp://dockersocket-mpc:2375` | must point at the proxy; `unix://` also works |
| `MCP_BEARER_TOKEN_FILE` | `mcp-docker-lite` | yes (or `MCP_BEARER_TOKEN`) | `/run/secrets/mcp_bearer_token` | see the [gateway README](../gateway/README.md#token) |

Image: `ghcr.io/<owner>/mcp-connectors/docker-lite:latest`, built by
[`build-docker-lite.yml`](../.github/workflows/build-docker-lite.yml). Port 8000, path
`/mcp`, same as the other connectors, so the Cloudflare tunnel route and WAF rule stay as
they are.

## Tests

```
node docker-lite/test-server.js
```

Runs the server against a fake Docker API (also in CI before the image is built).

---

## Polski

Mały serwer MCP do Dockera, tylko do odczytu, napisany na potrzeby tego repo, za tym samym
frontem z tokenem co pozostałe konektory ([`../gateway/`](../gateway/README.md)). Zastępuje
[`../docker/`](../docker/README.md) (ckreiling/mcp-server-docker), gdy chodzi o **mniej
kontekstu wysyłanego do modelu**: tamten serwer zwraca surowe obiekty API Dockera i całe
zrzuty logów, a w liście ma około dwudziestu narzędzi z długimi schematami. Klienci
obcinają zbyt długie wyniki, a każdy token tego kosztuje przy każdym wywołaniu.

### Narzędzia

| Narzędzie | Zwraca |
|---|---|
| `ps` | jedna linia na kontener: `nazwa \| status \| obraz \| opublikowane porty`. Argumenty: `all`, `name` (fragment nazwy) |
| `logs` | zwarty tekst logów. Argumenty: `container`, `tail` (domyślnie 40, max 1000), `since` (`30m`, `2h`, `1d`), `grep` (regex, przeszukuje ostatnie 5000 linii albo okno `since`), `max_chars` (domyślnie 4000, max 20000), `timestamps` |
| `inspect` | około dziesięciu linii: stan, kod wyjścia / OOM, restarty, health, porty, sieci, mounty, **same nazwy zmiennych środowiskowych** |

Co `logs` robi, żeby wynik był mały: wycina kody kolorów ANSI, zwija kolejne identyczne
linie (`... (x20)`), skraca linie dłuższe niż 300 znaków, a po przekroczeniu budżetu
zostawia **najnowsze** linie i w jednolinijkowym nagłówku podaje, ile odcięto.

Celowo brak: obrazów, sieci, wolumenów i wszystkich operacji zapisu. Operacje zapisu i
tak nie działały (proxy odpowiada `403`, patrz niżej), tylko zajmowały tokeny w liście
narzędzi.

### Architektura i bezpieczeństwo

Układ jak w `docker/`: serwer wysyła wyłącznie żądania `GET`, a `docker-socket-proxy` z
`POST=0` wymusza to niezależnie od tego kodu. Na proxy potrzebne jest `CONTAINERS=1` i nic
więcej. Gdy endpoint nie jest włączony, narzędzie odpowiada jedną linią z nazwą przełącznika
proxy zamiast stack trace.

**Wartości** zmiennych środowiskowych nigdy nie opuszczają kontenera: `inspect` wypisuje
same nazwy, a `ps` nigdy nie wypisuje labeli.

### Konfiguracja

Te same zmienne co w tabeli powyżej: `CONTAINERS=1` i `POST=0` na `docker-socket-proxy`,
oraz `DOCKER_HOST` i `MCP_BEARER_TOKEN_FILE` na `mcp-docker-lite`.

Obraz: `ghcr.io/<owner>/mcp-connectors/docker-lite:latest`, budowany przez
[`build-docker-lite.yml`](../.github/workflows/build-docker-lite.yml). Port 8000, ścieżka
`/mcp`, tak jak w pozostałych konektorach, więc trasa tunelu Cloudflare i reguła WAF zostają
bez zmian.

### Testy

```
node docker-lite/test-server.js
```

Uruchamia serwer na fałszywym API Dockera (w CI także przed zbudowaniem obrazu).
