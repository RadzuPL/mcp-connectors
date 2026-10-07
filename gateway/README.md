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
| `GATEWAY_STATEFUL` | no | `true` runs supergateway with `--stateful`: one wrapped-server process per client session instead of one per request. Use it when the wrapped server is slow to start or logs in somewhere on every start (`unifi/`, and `docker/` on a loaded host). Default `false`. See [Stateless or stateful?](#stateless-or-stateful). |
| `GATEWAY_SESSION_TIMEOUT_MS` | no | Inactivity timeout of a stateful session. Default `1800000` (30 minutes). Every session keeps its own wrapped-server process until it expires, so read [Stateless or stateful?](#stateless-or-stateful) before changing it. |
| `GATEWAY_SHARED_SESSION` | no | `true` makes the proxy funnel every client into **one** stateful session: one wrapped-server process and one login for the lifetime of the container, however many sessions the client opens. Needs `GATEWAY_STATEFUL=true`; without a stateful supergateway it is switched off with a warning. Default `false`. See [Shared-session mode](#shared-session-mode). |
| `LISTEN_PORT` / `UPSTREAM_PORT` | no | `8000` (the proxy) and `8001` (supergateway, loopback only). |

## Stateless or stateful?

By default (`GATEWAY_STATEFUL=false`) supergateway is stateless: it starts a **new copy of the wrapped server for every HTTP request**. That is simple and robust, and it is fine for fast servers (`files/`, `metrics/`).

It breaks down when the wrapped server is slow to start. A client opens with several requests (`initialize`, then `tools/list`, `prompts/list`, `resources/list`), and each one pays the whole startup cost. Measured on a loaded host (load average about 7): `mcp-server-docker` (Python) needed 5.7 to 8.4 s per request. The client gave up on some of them (cloudflared logged `Incoming request ended abruptly: context canceled`), and Claude showed "Connection issue" although the token, the backend and the WAF were all fine. In the container log the symptom is a client that sends `initialize` again and again and never follows up with `tools/list`.

`GATEWAY_STATEFUL=true` starts one wrapped-server process per client **session**. Caution: Claude opens a new session for every tool call, so per call this is no cheaper than stateless in the number of server starts; see [Shared-session mode](#shared-session-mode). The first `initialize` of a session still pays the startup cost once (about 6 s in the example above); the requests after it took 0.02 to 0.06 s.

Things to know in stateful mode:

- Every request after `initialize` must carry the `Mcp-Session-Id` header from the `initialize` response. Without it the gateway answers `400 Bad Request: No valid session ID provided`. That is correct behaviour, not a fault. The plain `initialize` checks below are unaffected, but a hand-written `tools/list` test needs the header (see the full handshake script below).
- A session the gateway no longer knows (expired, or lost in a restart) gets `404`, which the MCP specification tells a client to answer with a new session. That is what supergateway's source does; it has not been exercised against Claude's client here. The first `initialize` of the new session pays the startup cost again.
- Every session keeps its own wrapped-server process until `GATEWAY_SESSION_TIMEOUT_MS` of inactivity. Clients also open short probe sessions that are never reused, so processes and memory accumulate for up to the timeout (observed on one deployment: 15 `mcp-server-docker` lines in `docker top` and about 490 MiB for the container). Check with `docker top <container>` and `docker stats --no-stream <container>`.
- A shorter timeout frees memory sooner but makes new sessions, and with them the slow `initialize`, more frequent. Shorten it only if you actually see the processes pile up.

## Shared-session mode

Stateful mode gives one wrapped-server process per client *session*. Claude's client, however, opens a **new session for every tool call** (observed on `unifi/`: three calls, three `initialize`, three server starts, three logins). For a server that logs in somewhere on start, stateful mode alone therefore does not mean "one login": it means one login per call, and a burst of calls can still hit the login rate limit.

`GATEWAY_SHARED_SESSION=true` (together with `GATEWAY_STATEFUL=true`) changes that. The proxy opens a single upstream session on first use and keeps it:

- every client `initialize` is answered from the cached result of the upstream `initialize` (with a fresh random `Mcp-Session-Id`, which the proxy ignores on later requests);
- every request is forwarded on the shared upstream session; JSON-RPC ids are replaced by unique `gw-N` ids and restored in the answer, so concurrent clients cannot receive each other's answers;
- if the upstream session disappears (404, or 400 mentioning the session) the proxy opens a new one and retries the request once.

Limitations, stated plainly:

- All clients share one session and therefore one wrapped-server state. Fine for a single-user connector behind a bearer token; not for anything that needs per-client state.
- No server-initiated messages: `GET /mcp` answers `405`, `DELETE /mcp` answers `204` and is **not** forwarded (a client closing its session must not kill the shared one).
- The upstream session is opened with the protocol version of the first client that connects.
- The unit tests (`gateway/test-shared-session.js`) run against a mock stateful upstream. Compatibility with a real supergateway was not verified in CI; check a deployment in the container log: several tool calls must produce **one** start/login of the wrapped server.
- Off by default; remove the variable to go back to plain stateful behaviour.

## Token

Generate one with `openssl rand -hex 32` and keep it in a file mounted read-only into the container (`-v /path/on/host/bearer_token:/run/secrets/mcp_bearer_token:ro` plus `MCP_BEARER_TOKEN_FILE=/run/secrets/mcp_bearer_token`). Create the file **before** you start the container: if the host path does not exist, Docker creates a directory with that name, and the container keeps mounting a directory even after you create the file (remove the container and create it again).

## Using it from Claude

Settings → Connectors → Add custom connector. URL `https://<your-host>/mcp`. Under Authentication choose **No sign-in**, and under Request headers add `authorization` with the value `Bearer <token>`. Claude will still show "Sign in now" tagged Detected, with a warning: that is only because the server answers `401` to a request without credentials, and these servers have no OAuth.

If a connector that has been idle shows "Connection issue", press **Reconnect**: a new session starts, and with a slow wrapped server its first `initialize` can take several seconds (see above).

## Verify your deployment

From a container on the same Docker network. Without a token the answer must be `401`:

```bash
docker run --rm --network <your-network> curlimages/curl -s -o /dev/null -w "%{http_code}\n" -X POST http://<container>:8000/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
```

The same request with `-H "Authorization: Bearer <token>"` must return `200`. supergateway's own port must not be reachable at all (the answer is `000`):

```bash
docker run --rm --network <your-network> curlimages/curl -s -m 3 -o /dev/null -w "%{http_code}\n" http://<container>:8001/mcp
```

### Full handshake (works in both modes)

This script does what a client does: `initialize`, then the follow-up requests with the session id from the response (in stateless mode there is none, and that is fine). It prints the HTTP code and time of every step, which also shows how slow the wrapped server is to start. Replace `<container>`:

```bash
cat > /tmp/mcp-test.sh <<'EOF'
U=http://<container>:8000/mcp
J='Content-Type: application/json'
A='Accept: application/json, text/event-stream'
P='MCP-Protocol-Version: 2025-11-25'
AUTH="Authorization: Bearer $T"

echo "--- initialize"
curl -s -m 30 -D /tmp/h -o /dev/null -w "HTTP %{http_code}, %{time_total}s\n" -X POST "$U" -H "$AUTH" -H "$J" -H "$A" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
SID=$(tr -d '\r' < /tmp/h | grep -i '^mcp-session-id:' | cut -d' ' -f2)
echo "session: ${SID:-none}"

for body in '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' '{"jsonrpc":"2.0","id":3,"method":"prompts/list"}' '{"jsonrpc":"2.0","id":4,"method":"resources/list"}'; do
  echo "--- $(echo "$body" | cut -c1-60)"
  curl -s -m 30 -o /dev/null -w "HTTP %{http_code}, %{time_total}s\n" -X POST "$U" -H "$AUTH" -H "$J" -H "$A" -H "$P" -H "Mcp-Session-Id: $SID" -d "$body"
done
EOF
```

```bash
docker run --rm --network <your-network> -e T="$(cat /path/to/bearer_token)" -v /tmp/mcp-test.sh:/t.sh:ro curlimages/curl sh /t.sh
```

Expect `200` for `initialize`, `202` for `notifications/initialized` and `200` for the rest. In stateful mode only the first line is slow.

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
| `GATEWAY_STATEFUL` | nie | `true` uruchamia supergateway z `--stateful`: jeden proces opakowywanego serwera na sesję klienta zamiast jednego na żądanie. Używaj, gdy opakowywany serwer wolno startuje albo loguje się gdzieś przy każdym starcie (`unifi/` oraz `docker/` na obciążonym hoście). Domyślnie `false`. Zobacz [Stateless czy stateful?](#stateless-czy-stateful). |
| `GATEWAY_SESSION_TIMEOUT_MS` | nie | Limit bezczynności sesji stateful. Domyślnie `1800000` (30 minut). Każda sesja trzyma własny proces opakowywanego serwera aż do wygaśnięcia, więc przeczytaj [Stateless czy stateful?](#stateless-czy-stateful) przed zmianą. |
| `GATEWAY_SHARED_SESSION` | nie | `true` sprawia, że proxy kieruje wszystkich klientów do **jednej** sesji stateful: jeden proces opakowywanego serwera i jedno logowanie przez cały czas życia kontenera, niezależnie od liczby sesji otwieranych przez klienta. Wymaga `GATEWAY_STATEFUL=true`; bez stateful supergateway jest wyłączane z ostrzeżeniem. Domyślnie `false`. Zobacz [Tryb współdzielonej sesji](#tryb-współdzielonej-sesji). |
| `LISTEN_PORT` / `UPSTREAM_PORT` | nie | `8000` (proxy) i `8001` (supergateway, tylko loopback). |

### Stateless czy stateful?

Domyślnie (`GATEWAY_STATEFUL=false`) supergateway jest stateless: uruchamia **nową kopię opakowywanego serwera dla każdego żądania HTTP**. To proste i odporne, i wystarcza dla szybkich serwerów (`files/`, `metrics/`).

Przestaje działać, gdy opakowywany serwer wolno startuje. Klient zaczyna od kilku żądań (`initialize`, potem `tools/list`, `prompts/list`, `resources/list`), a każde płaci pełny koszt startu. Zmierzone na obciążonym hoście (load average około 7): `mcp-server-docker` (Python) potrzebował 5,7 do 8,4 s na żądanie. Klient rezygnował z części z nich (cloudflared logował `Incoming request ended abruptly: context canceled`), a Claude pokazywał „Connection issue”, choć token, backend i WAF były w porządku. W logu kontenera objaw wygląda tak: klient wysyła `initialize` w kółko i nigdy nie przechodzi do `tools/list`.

`GATEWAY_STATEFUL=true` uruchamia jeden proces opakowywanego serwera na **sesję** klienta. Uwaga: Claude otwiera nową sesję przy każdym wywołaniu narzędzia, więc w liczbie startów serwera na wywołanie nie jest to tańsze niż stateless; zobacz [Tryb współdzielonej sesji](#tryb-współdzielonej-sesji). Pierwsze `initialize` w sesji nadal płaci koszt startu raz (w przykładzie około 6 s); kolejne żądania trwały 0,02 do 0,06 s.

Co warto wiedzieć w trybie stateful:

- Każde żądanie po `initialize` musi nieść nagłówek `Mcp-Session-Id` z odpowiedzi na `initialize`. Bez niego bramka odpowiada `400 Bad Request: No valid session ID provided`. To poprawne zachowanie, nie usterka. Zwykłe testy `initialize` poniżej nie są dotknięte, ale ręcznie napisany test `tools/list` potrzebuje tego nagłówka (zobacz skrypt pełnego handshake poniżej).
- Sesja, której bramka już nie zna (wygasła albo zginęła przy restarcie), dostaje `404`, na co specyfikacja MCP każe klientowi odpowiedzieć nową sesją. Tak działa kod supergateway; nie sprawdzono tego tu na kliencie Claude. Pierwsze `initialize` nowej sesji płaci koszt startu ponownie.
- Każda sesja trzyma własny proces opakowywanego serwera aż do `GATEWAY_SESSION_TIMEOUT_MS` bezczynności. Klienci otwierają też krótkie sesje-sondy, które nigdy nie są ponownie używane, więc procesy i pamięć narastają przez czas limitu (zaobserwowano na jednym wdrożeniu: 15 linii `mcp-server-docker` w `docker top` i około 490 MiB dla kontenera). Sprawdzisz to przez `docker top <kontener>` i `docker stats --no-stream <kontener>`.
- Krótszy limit szybciej zwalnia pamięć, ale sprawia, że nowe sesje, a z nimi wolne `initialize`, zdarzają się częściej. Skracaj go tylko wtedy, gdy faktycznie widzisz narastanie procesów.

### Tryb współdzielonej sesji

Tryb stateful daje jeden proces opakowywanego serwera na *sesję* klienta. Klient Claude otwiera jednak **nową sesję przy każdym wywołaniu narzędzia** (zaobserwowano na `unifi/`: trzy wywołania, trzy `initialize`, trzy starty serwera, trzy logowania). Dla serwera logującego się przy starcie sam tryb stateful nie oznacza więc „jednego logowania”, tylko jedno logowanie na wywołanie, a seria wywołań nadal może trafić w limit logowań.

`GATEWAY_SHARED_SESSION=true` (razem z `GATEWAY_STATEFUL=true`) to zmienia. Proxy otwiera jedną sesję upstream przy pierwszym użyciu i ją trzyma:

- każde `initialize` klienta jest obsługiwane z zapamiętanego wyniku `initialize` upstream (z nowym losowym `Mcp-Session-Id`, który proxy ignoruje w kolejnych żądaniach);
- każde żądanie idzie przez wspólną sesję upstream; identyfikatory JSON-RPC są zamieniane na unikalne `gw-N` i przywracane w odpowiedzi, więc równoległe zapytania nie dostaną cudzych odpowiedzi;
- jeśli sesja upstream zniknie (404 albo 400 wspominające sesję), proxy otwiera nową i ponawia żądanie raz.

Ograniczenia, wprost:

- Wszyscy klienci dzielą jedną sesję, a więc jeden stan opakowywanego serwera. Dobre dla connectora jednego użytkownika za tokenem; złe dla czegokolwiek, co wymaga stanu per klient.
- Brak wiadomości inicjowanych przez serwer: `GET /mcp` zwraca `405`, `DELETE /mcp` zwraca `204` i **nie** jest przekazywane (klient zamykający swoją sesję nie może zabić wspólnej).
- Sesja upstream jest otwierana z wersją protokołu pierwszego klienta.
- Testy jednostkowe (`gateway/test-shared-session.js`) działają na atrapie stateful upstream. Zgodność z prawdziwym supergateway nie została sprawdzona w CI; wdrożenie zweryfikujesz w logu kontenera: kilka wywołań narzędzi ma dać **jeden** start/logowanie opakowywanego serwera.
- Domyślnie wyłączone; usuń zmienną, żeby wrócić do zwykłego stateful.

### Token

Wygeneruj go przez `openssl rand -hex 32` i trzymaj w pliku montowanym tylko do odczytu (`-v /sciezka/na/hoscie/bearer_token:/run/secrets/mcp_bearer_token:ro` oraz `MCP_BEARER_TOKEN_FILE=/run/secrets/mcp_bearer_token`). Utwórz plik **przed** startem kontenera: jeśli ścieżka na hoście nie istnieje, Docker zakłada katalog o tej nazwie, a kontener dalej montuje katalog, nawet gdy potem utworzysz plik (usuń kontener i utwórz go od nowa).

### Użycie z Claude

Settings → Connectors → Add custom connector. Adres `https://<twój-host>/mcp`. W „Authentication” wybierz **No sign-in**, a w „Request headers” dodaj `authorization` z wartością `Bearer <token>`. Claude i tak pokaże „Sign in now” z oznaczeniem Detected i ostrzeżeniem: to tylko dlatego, że serwer odpowiada `401` na żądanie bez poświadczeń, a te serwery nie mają OAuth.

Jeśli konektor, który długo stał nieużywany, pokazuje „Connection issue”, kliknij **Reconnect**: startuje nowa sesja, a przy wolnym opakowywanym serwerze jej pierwsze `initialize` może trwać kilka sekund (zobacz wyżej).

### Sprawdź swój deployment

Z kontenera w tej samej sieci Dockera. Bez tokenu odpowiedź musi brzmieć `401`:

```bash
docker run --rm --network <twoja-siec> curlimages/curl -s -o /dev/null -w "%{http_code}\n" -X POST http://<kontener>:8000/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
```

To samo żądanie z `-H "Authorization: Bearer <token>"` musi zwrócić `200`. Własny port supergateway nie może być w ogóle osiągalny (odpowiedź `000`):

```bash
docker run --rm --network <twoja-siec> curlimages/curl -s -m 3 -o /dev/null -w "%{http_code}\n" http://<kontener>:8001/mcp
```

#### Pełny handshake (działa w obu trybach)

Skrypt robi to, co klient: `initialize`, potem kolejne żądania z identyfikatorem sesji z odpowiedzi (w trybie stateless go nie ma i to jest w porządku). Wypisuje kod HTTP i czas każdego kroku, co przy okazji pokazuje, jak wolno startuje opakowywany serwer. Podmień `<kontener>`:

```bash
cat > /tmp/mcp-test.sh <<'EOF'
U=http://<kontener>:8000/mcp
J='Content-Type: application/json'
A='Accept: application/json, text/event-stream'
P='MCP-Protocol-Version: 2025-11-25'
AUTH="Authorization: Bearer $T"

echo "--- initialize"
curl -s -m 30 -D /tmp/h -o /dev/null -w "HTTP %{http_code}, %{time_total}s\n" -X POST "$U" -H "$AUTH" -H "$J" -H "$A" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
SID=$(tr -d '\r' < /tmp/h | grep -i '^mcp-session-id:' | cut -d' ' -f2)
echo "session: ${SID:-none}"

for body in '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' '{"jsonrpc":"2.0","id":3,"method":"prompts/list"}' '{"jsonrpc":"2.0","id":4,"method":"resources/list"}'; do
  echo "--- $(echo "$body" | cut -c1-60)"
  curl -s -m 30 -o /dev/null -w "HTTP %{http_code}, %{time_total}s\n" -X POST "$U" -H "$AUTH" -H "$J" -H "$A" -H "$P" -H "Mcp-Session-Id: $SID" -d "$body"
done
EOF
```

```bash
docker run --rm --network <twoja-siec> -e T="$(cat /sciezka/do/bearer_token)" -v /tmp/mcp-test.sh:/t.sh:ro curlimages/curl sh /t.sh
```

Oczekuj `200` dla `initialize`, `202` dla `notifications/initialized` i `200` dla reszty. W trybie stateful wolny jest tylko pierwszy wiersz.

### Testy

```bash
node gateway/test-proxy.js
node gateway/test-loopback.js
bash gateway/test-entrypoint.sh
```
