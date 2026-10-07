# docker-lite connector

*([Polska wersja poniżej ↓](#polski))*

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
   -> docker-lite container (token check + supergateway, stdio -> streamable-HTTP)
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
| `DOCKER_HOST` | docker-lite container | yes | `tcp://docker-socket-proxy:2375` | must point at the proxy; `unix://` also works |
| `MCP_BEARER_TOKEN_FILE` | docker-lite container | yes (or `MCP_BEARER_TOKEN`) | `/run/secrets/mcp_bearer_token` | see the [gateway README](../gateway/README.md#token) |

`GATEWAY_STATEFUL` is **not** needed: the server starts in milliseconds (it is plain
Node, not a Python process), so even a slow or loaded host does not hit the "Connection
issue" described in the [docker README](../docker/README.md#slow-hosts-set-gateway_statefultrue).

Image: `ghcr.io/<owner>/mcp-connectors/docker-lite:latest`, built by
[`build-docker-lite.yml`](../.github/workflows/build-docker-lite.yml). Port 8000, path
`/mcp`, same as the other connectors.

## Replacing the `docker` connector in place

Same environment variables, same port, same path, so only the image changes:

1. Make the `docker-lite` package public in the GitHub package settings if your host
   pulls without credentials (packages published by Actions start out private).
2. In the existing container, change the image to
   `ghcr.io/<owner>/mcp-connectors/docker-lite:latest`. Keep the **container name**, the
   token file mount and `DOCKER_HOST`: the tunnel route, the WAF rules and the connector
   entry in the MCP client then stay as they are. Remove `GATEWAY_STATEFUL` if it was set.
3. Re-connect the connector in the client so it fetches the new tool list (`ps`, `logs`,
   `inspect`).
4. To roll back, put the old image back.

Do not enable both connectors in the client at the same time: two tool lists cost tokens
and defeat the purpose.

## Verify

Without a token the gateway must answer `401`; with it, `ps` must return a list. Run from
the Docker host, in the network the container is on (replace the network, the container
name and the token):

```
docker run --rm --network mcp_network curlimages/curl -i -X POST http://mcp-docker-connector:8000/mcp -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ps","arguments":{}}}'
```

Note that supergateway logs the whole JSON-RPC traffic of its container. When you read the
logs of the connector container itself, use a small `tail` or `grep`.

## Tests

```
node docker-lite/test-server.js
```

Runs the server against a fake Docker API (also in CI before the image is built).

---

<a id="polski"></a>
## Polski

*([English version above ↑](#docker-lite-connector))*

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

```
MCP client (streamable-HTTP, bearer token)
   -> kontener docker-lite (sprawdzenie tokenu + supergateway, stdio -> streamable-HTTP)
       -> docker-socket-proxy (POST=0, read-only)
           -> /var/run/docker.sock
```

Układ jak w `docker/`: serwer wysyła wyłącznie żądania `GET`, a `docker-socket-proxy` z
`POST=0` wymusza to niezależnie od tego kodu. Na proxy potrzebne jest `CONTAINERS=1` i nic
więcej. Gdy endpoint nie jest włączony, narzędzie odpowiada jedną linią z nazwą przełącznika
proxy zamiast stack trace.

**Wartości** zmiennych środowiskowych nigdy nie opuszczają kontenera: `inspect` wypisuje
same nazwy, a `ps` nigdy nie wypisuje labeli.

### Konfiguracja

| Zmienna | Ustawiana na | Wymagana | Przykład | Uwagi |
|---|---|---|---|---|
| `CONTAINERS` | `docker-socket-proxy` | tak | `1` | jedyny endpoint odczytu, którego używa ten konektor |
| `POST` | `docker-socket-proxy` | tak | `0` | wymuszenie trybu tylko-do-odczytu |
| `DOCKER_HOST` | kontener docker-lite | tak | `tcp://docker-socket-proxy:2375` | musi wskazywać na proxy; `unix://` też działa |
| `MCP_BEARER_TOKEN_FILE` | kontener docker-lite | tak (albo `MCP_BEARER_TOKEN`) | `/run/secrets/mcp_bearer_token` | zobacz [README bramki](../gateway/README.md#token) |

`GATEWAY_STATEFUL` **nie jest potrzebne**: serwer startuje w milisekundach (to zwykły
Node, a nie proces Pythona), więc nawet wolny albo obciążony host nie trafia na „Connection
issue” opisane w [README docker](../docker/README.md#wolne-hosty-ustaw-gateway_statefultrue).

Obraz: `ghcr.io/<owner>/mcp-connectors/docker-lite:latest`, budowany przez
[`build-docker-lite.yml`](../.github/workflows/build-docker-lite.yml). Port 8000, ścieżka
`/mcp`, tak jak w pozostałych konektorach.

### Wymiana konektora `docker` w miejscu

Te same zmienne środowiskowe, ten sam port, ta sama ścieżka, więc zmienia się tylko obraz:

1. Ustaw pakiet `docker-lite` jako publiczny w ustawieniach pakietów GitHuba, jeśli host
   pobiera obrazy bez poświadczeń (pakiety publikowane przez Actions zaczynają jako prywatne).
2. W istniejącym kontenerze zmień obraz na
   `ghcr.io/<owner>/mcp-connectors/docker-lite:latest`. Zostaw **nazwę kontenera**, mount
   pliku z tokenem i `DOCKER_HOST`: trasa tunelu, reguły WAF i wpis konektora w kliencie MCP
   zostają bez zmian. Usuń `GATEWAY_STATEFUL`, jeśli było ustawione.
3. Połącz konektor w kliencie od nowa, żeby pobrał nową listę narzędzi (`ps`, `logs`,
   `inspect`).
4. Wycofanie to przywrócenie starego obrazu.

Nie włączaj obu konektorów w kliencie naraz: dwie listy narzędzi kosztują tokeny i
niweczą cel.

### Weryfikacja

Bez tokenu bramka musi odpowiedzieć `401`; z tokenem `ps` musi zwrócić listę. Uruchom na
hoście Dockera, w sieci, w której stoi kontener (podmień sieć, nazwę kontenera i token):

```
docker run --rm --network mcp_network curlimages/curl -i -X POST http://mcp-docker-connector:8000/mcp -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ps","arguments":{}}}'
```

Uwaga: supergateway zapisuje w logach swojego kontenera cały ruch JSON-RPC. Czytając logi
samego kontenera konektora, używaj małego `tail` albo `grep`.

### Testy

```
node docker-lite/test-server.js
```

Uruchamia serwer na fałszywym API Dockera (w CI także przed zbudowaniem obrazu).
