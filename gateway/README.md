# gateway: the shared authenticating front of every connector

*([Polska wersja poniżej ↓](#polski))*

Every connector image in this repo (`docker/`, `files/`, `metrics/`, `unifi/`) runs the same small front end. It lives here once, and each connector's Dockerfile copies it into its image.

## Why it exists

`supergateway` 4.1.0 has **no inbound authentication**. Its `--oauth2Bearer` flag only adds an `Authorization` header; it never checks the header of incoming requests. Verified on 2026-10-05: gateways started with `--oauth2Bearer "$MCP_BEARER_TOKEN"` answered `200` to a request with no token at all. The same flag also put the token into the process arguments, where `ps` and any monitor that lists processes can read it.

## What runs in the container

```
MCP client (streamable-HTTP, Authorization: Bearer <token>)
   -> auth-proxy.js on :8000                 checks the token, answers 401 otherwise
       -> supergateway on 127.0.0.1:8001     stdio -> streamable-HTTP, no auth of its own
           -> the wrapped MCP server (stdio)
```

| File | What it does |
|---|---|
| [`auth-proxy.js`](auth-proxy.js) | About 100 lines of plain Node (core modules only). Compares the token in constant time, strips the `Authorization` header before forwarding, streams SSE responses through unchanged, and refuses to start if no token (or one shorter than 24 characters) is configured. |
| [`entrypoint.sh`](entrypoint.sh) | Starts the proxy and supergateway, and stops the whole container if either dies, so a dead proxy can never leave an unauthenticated gateway behind. |
| [`force-loopback.js`](force-loopback.js) | supergateway 4.1.0 has no `--host` flag and listens on every interface, so other containers on the Docker network could skip the proxy. This preload pins its port to `127.0.0.1`. It is not used when supergateway has `--host`. |
| `test-proxy.js`, `test-loopback.js`, `test-entrypoint.sh` | Run in CI before every image build. If one fails, no image is published. |

## Using it in a connector

The build context must be the repository root. supergateway 4.1.0 needs Node 20 or newer, so check which Node your base image gets.

```dockerfile
COPY gateway/ /app/gateway/
RUN chmod +x /app/gateway/entrypoint.sh
ENV GATEWAY_STDIO_CMD="<command line of the wrapped MCP server>"
ENTRYPOINT []
CMD ["/app/gateway/entrypoint.sh"]
```

## Environment

| Variable | Required | Notes |
|---|---|---|
| `GATEWAY_STDIO_CMD` | yes | Command line of the wrapped MCP server. supergateway runs it through a shell, so it can contain variables (the files connector uses `mcp-server-filesystem $ALLOWED_DIRS`). |
| `MCP_BEARER_TOKEN_FILE` | yes, or `MCP_BEARER_TOKEN` | Path to a file containing the token, at least 24 characters. Preferred: the token stays out of `docker inspect`, out of container templates and out of the process list. |
| `MCP_BEARER_TOKEN` | alternative to the file | The token itself. Works, but it is visible in `docker inspect` and in container templates. |
| `MCP_ALLOW_PATH_TOKEN` | no | `true` also accepts the token as the first URL path segment (`https://<host>/<token>/mcp`), for clients that cannot send an `Authorization` header. Off by default, because URLs end up in logs. |
| `GATEWAY_STATEFUL` | no | `true` runs supergateway with `--stateful`: one wrapped-server process per client session instead of one per request. Needed by servers that log in somewhere on every start (`unifi/`). Default `false`. |
| `GATEWAY_SESSION_TIMEOUT_MS` | no | Inactivity timeout of a stateful session. Default `1800000` (30 minutes). |
| `LISTEN_PORT` / `UPSTREAM_PORT` | no | `8000` (the proxy) and `8001` (supergateway, loopback only). |

## Token

Generate one with `openssl rand -hex 32` and keep it in a file mounted read-only into the container (`-v /path/on/host/bearer_token:/run/secrets/mcp_bearer_token:ro` plus `MCP_BEARER_TOKEN_FILE=/run/secrets/mcp_bearer_token`). Create the file **before** you start the container: if the host path does not exist, Docker creates a directory with that name, and the container keeps mounting a directory even after you create the file (remove the container and create it again).

## Using it from Claude

Settings → Connectors → Add custom connector. URL `https://<your-host>/mcp`. Under Authentication choose **No sign-in**, and under Request headers add `authorization` with the value `Bearer <token>`. Claude will still show "Sign in now" tagged Detected, with a warning: that is only because the server answers `401` to a request without credentials, and these servers have no OAuth.

## Verify your deployment

From a container on the same Docker network. Without a token the answer must be `401`:

```bash
docker run --rm --network <your-network> curlimages/curl -s -o /dev/null -w "%{http_code}\n" -X POST http://<container>:8000/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
```

The same request with `-H "Authorization: Bearer <token>"` must return `200`. supergateway's own port must not be reachable at all (the answer is `000`):

```bash
docker run --rm --network <your-network> curlimages/curl -s -m 3 -o /dev/null -w "%{http_code}\n" http://<container>:8001/mcp
```

## Tests

```bash
node gateway/test-proxy.js
node gateway/test-loopback.js
bash gateway/test-entrypoint.sh
```

---

<a id="polski"></a>
## Polski

*([English version above ↑](#gateway-the-shared-authenticating-front-of-every-connector))*

Każdy obraz connectora w tym repo (`docker/`, `files/`, `metrics/`, `unifi/`) uruchamia ten sam mały front. Leży tu raz, a Dockerfile każdego connectora kopiuje go do swojego obrazu.

### Dlaczego istnieje

`supergateway` 4.1.0 **nie ma uwierzytelniania żądań przychodzących**. Jego flaga `--oauth2Bearer` tylko dodaje nagłówek `Authorization`; nigdy nie sprawdza nagłówka w żądaniach przychodzących. Sprawdzone 2026-10-05: bramki uruchomione z `--oauth2Bearer "$MCP_BEARER_TOKEN"` odpowiadały `200` na żądanie bez żadnego tokenu. Ta sama flaga wpisywała też token do argumentów procesu, skąd czyta go `ps` i każdy monitoring, który wypisuje procesy.

### Co działa w kontenerze

```
MCP client (streamable-HTTP, Authorization: Bearer <token>)
   -> auth-proxy.js na :8000                 sprawdza token, w przeciwnym razie 401
       -> supergateway na 127.0.0.1:8001     stdio -> streamable-HTTP, bez własnej autoryzacji
           -> opakowywany serwer MCP (stdio)
```

| Plik | Co robi |
|---|---|
| [`auth-proxy.js`](auth-proxy.js) | Około 100 linii czystego Node (tylko moduły core). Porównuje token w stałym czasie, usuwa nagłówek `Authorization` przed przekazaniem dalej, przepuszcza odpowiedzi SSE strumieniowo i odmawia startu, jeśli nie ma tokenu (albo jest krótszy niż 24 znaki). |
| [`entrypoint.sh`](entrypoint.sh) | Uruchamia proxy i supergateway i zatrzymuje cały kontener, jeśli któryś padnie, więc martwe proxy nie zostawi nigdy nieuwierzytelnionej bramki. |
| [`force-loopback.js`](force-loopback.js) | supergateway 4.1.0 nie ma flagi `--host` i słucha na wszystkich interfejsach, więc inne kontenery w sieci Dockera mogłyby ominąć proxy. Ten preload przypina jego port do `127.0.0.1`. Nieużywany, gdy supergateway ma `--host`. |
| `test-proxy.js`, `test-loopback.js`, `test-entrypoint.sh` | Odpalane w CI przed każdym buildem obrazu. Jeśli któryś padnie, żaden obraz się nie publikuje. |

### Użycie w connectorze

Kontekstem builda musi być korzeń repozytorium. supergateway 4.1.0 wymaga Node 20 lub nowszego, więc sprawdź, jaki Node dostaje twój obraz bazowy.

```dockerfile
COPY gateway/ /app/gateway/
RUN chmod +x /app/gateway/entrypoint.sh
ENV GATEWAY_STDIO_CMD="<linia poleceń opakowywanego serwera MCP>"
ENTRYPOINT []
CMD ["/app/gateway/entrypoint.sh"]
```

### Zmienne środowiskowe

| Zmienna | Wymagana | Uwagi |
|---|---|---|
| `GATEWAY_STDIO_CMD` | tak | Linia poleceń opakowywanego serwera MCP. supergateway uruchamia ją przez powłokę, więc może zawierać zmienne (connector plików używa `mcp-server-filesystem $ALLOWED_DIRS`). |
| `MCP_BEARER_TOKEN_FILE` | tak, albo `MCP_BEARER_TOKEN` | Ścieżka do pliku z tokenem, minimum 24 znaki. Zalecane: token nie jest widoczny w `docker inspect`, w szablonach kontenerów ani na liście procesów. |
| `MCP_BEARER_TOKEN` | alternatywa dla pliku | Sam token. Działa, ale jest widoczny w `docker inspect` i w szablonach kontenerów. |
| `MCP_ALLOW_PATH_TOKEN` | nie | `true` przyjmuje też token jako pierwszy segment ścieżki (`https://<host>/<token>/mcp`), dla klientów, które nie potrafią wysłać nagłówka `Authorization`. Domyślnie wyłączone, bo adresy URL trafiają do logów. |
| `GATEWAY_STATEFUL` | nie | `true` uruchamia supergateway z `--stateful`: jeden proces opakowywanego serwera na sesję klienta zamiast jednego na żądanie. Potrzebne serwerom, które logują się gdzieś przy każdym starcie (`unifi/`). Domyślnie `false`. |
| `GATEWAY_SESSION_TIMEOUT_MS` | nie | Limit bezczynności sesji stateful. Domyślnie `1800000` (30 minut). |
| `LISTEN_PORT` / `UPSTREAM_PORT` | nie | `8000` (proxy) i `8001` (supergateway, tylko loopback). |

### Token

Wygeneruj go przez `openssl rand -hex 32` i trzymaj w pliku montowanym tylko do odczytu (`-v /sciezka/na/hoscie/bearer_token:/run/secrets/mcp_bearer_token:ro` oraz `MCP_BEARER_TOKEN_FILE=/run/secrets/mcp_bearer_token`). Utwórz plik **przed** startem kontenera: jeśli ścieżka na hoście nie istnieje, Docker zakłada katalog o tej nazwie, a kontener dalej montuje katalog, nawet gdy potem utworzysz plik (usuń kontener i utwórz go od nowa).

### Użycie z Claude

Settings → Connectors → Add custom connector. Adres `https://<twój-host>/mcp`. W „Authentication” wybierz **No sign-in**, a w „Request headers” dodaj `authorization` z wartością `Bearer <token>`. Claude i tak pokaże „Sign in now” z oznaczeniem Detected i ostrzeżeniem: to tylko dlatego, że serwer odpowiada `401` na żądanie bez poświadczeń, a te serwery nie mają OAuth.

### Sprawdź swój deployment

Z kontenera w tej samej sieci Dockera. Bez tokenu odpowiedź musi brzmieć `401`:

```bash
docker run --rm --network <twoja-siec> curlimages/curl -s -o /dev/null -w "%{http_code}\n" -X POST http://<kontener>:8000/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
```

To samo żądanie z `-H "Authorization: Bearer <token>"` musi zwrócić `200`. Własny port supergateway nie może być w ogóle osiągalny (odpowiedź `000`):

```bash
docker run --rm --network <twoja-siec> curlimages/curl -s -m 3 -o /dev/null -w "%{http_code}\n" http://<kontener>:8001/mcp
```

### Testy

```bash
node gateway/test-proxy.js
node gateway/test-loopback.js
bash gateway/test-entrypoint.sh
```
