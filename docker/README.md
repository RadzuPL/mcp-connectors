# docker connector

*([Polska wersja poniżej ↓](#polski))*

Wraps [`ckreiling/mcp-server-docker`](https://github.com/ckreiling/mcp-server-docker), pinned
to the commit in [`UPSTREAM_REF`](UPSTREAM_REF), and adds [`supergateway`](https://github.com/supercorp-ai/supergateway)
to expose it as streamable-HTTP. The bearer token is checked by the shared front end in
[`../gateway/`](../gateway/README.md).

Read access to container/image state and logs; **no mutating Docker operations reach the
real socket**, enforced by the proxy in front of it — not by the MCP server's own
behavior.

## Architecture

```
MCP client (streamable-HTTP, bearer token)
   -> mcp-docker-connector (token check + supergateway, stdio -> streamable-HTTP)
       -> docker-socket-proxy (POST=0, read-only)
           -> /var/run/docker.sock
```

`docker-socket-proxy` ([tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy))
is the only container that ever touches `docker.sock`. The socket is mounted `:ro`, but
that only protects the socket file itself, not the API behind it: a client with access to
a `:ro` socket can still send any Docker API call. `POST=0` is what makes the API
read-only: it hard-blocks every mutating call, regardless of what the MCP server or the
model asks for — even a compromised or buggy MCP server can't get past it. Confirmed
live: a write attempt (e.g. `create_network`) returns `403` straight from the proxy,
before it ever reaches the real Docker daemon.

Everything that is not switched on at the proxy answers `403` too. For example
`list_networks` fails with `403` unless you set `NETWORKS=1` on the proxy (observed).
Enable only the endpoints you need.

## Configuration

| Variable | Set on | Required | Example | Notes |
|---|---|---|---|---|
| `CONTAINERS` | `docker-socket-proxy` | yes | `1` | enables container-related read endpoints |
| `IMAGES` | `docker-socket-proxy` | yes | `1` | enables image-related read endpoints |
| `POST` | `docker-socket-proxy` | yes | `0` | **this is the read-only enforcement** — blocks all mutating calls |
| `DOCKER_HOST` | `mcp-docker-connector` | yes | `tcp://docker-socket-proxy:2375` | must point at the proxy, never directly at `docker.sock` |
| `MCP_BEARER_TOKEN_FILE` | `mcp-docker-connector` | yes (or `MCP_BEARER_TOKEN`) | `/run/secrets/mcp_bearer_token` | file with the token your MCP client sends as `Authorization: Bearer ...`; see the [gateway README](../gateway/README.md#token) (create the file before the first start) |
| `GATEWAY_STATEFUL` | `mcp-docker-connector` | no | `true` | one `mcp-server-docker` process per client session instead of one per request. **Set it on slow or loaded hosts**, see below. Default `false` |
| `GATEWAY_SESSION_TIMEOUT_MS` | `mcp-docker-connector` | no | `1800000` | inactivity timeout of a stateful session; see the [gateway README](../gateway/README.md#stateless-or-stateful) before changing it |

`UPSTREAM_REF` pins the exact commit of `ckreiling/mcp-server-docker` that gets built —
see the root README's "Semi-automatic upstream updates" for how that gets bumped.

## Slow hosts: set `GATEWAY_STATEFUL=true`

By default every request starts a new `mcp-server-docker` process (Python). On a fast
host you will not notice. On a loaded host it took 5.7 to 8.4 s per request (measured at
load average about 7). A client opens with several requests, so it gave up and the
connector showed "Connection issue" even though the token, the proxy and the WAF were
fine. In the container log the symptom is a client that sends `initialize` again and
again and never follows up with `tools/list`.

With `GATEWAY_STATEFUL=true` the process is started once per session: the first
`initialize` of a session still takes the full startup time, and the requests after it
took 0.02 to 0.06 s. The default stays `false`, because on a fast host stateless mode
works and there are no sessions to expire or to pile up. The details (the `Mcp-Session-Id`
header a hand-written test needs, what happens when a session expires, how to watch the
processes accumulate) are in the
[gateway README](../gateway/README.md#stateless-or-stateful), together with a
[full-handshake test script](../gateway/README.md#full-handshake-works-in-both-modes).

## docker-compose example

```yaml
services:
  docker-socket-proxy:
    image: ghcr.io/tecnativa/docker-socket-proxy:latest
    environment:
      CONTAINERS: 1
      IMAGES: 1
      POST: 0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks: [mcp]
    restart: unless-stopped

  mcp-docker-connector:
    build:
      context: .
      dockerfile: docker/Dockerfile.gateway
    # or, once build-docker.yml has published an image for your fork:
    # image: ghcr.io/<your-github-user>/<your-repo>/docker:latest
    environment:
      DOCKER_HOST: tcp://docker-socket-proxy:2375
      MCP_BEARER_TOKEN_FILE: /run/secrets/mcp_bearer_token
      # GATEWAY_STATEFUL: "true"   # on slow or loaded hosts, see above
    volumes:
      - /path/on/host/bearer_token:/run/secrets/mcp_bearer_token:ro
    depends_on: [docker-socket-proxy]
    networks: [mcp]
    restart: unless-stopped

networks:
  mcp:
    driver: bridge
```

Give this its own network, isolated from any network your other, non-MCP containers
share — it doesn't need to reach them, and they don't need to reach it.

Then expose `mcp-docker-connector`'s port 8000 the way described in the root README, and
add it to your MCP client as `https://<your-host>/mcp` with
`Authorization: Bearer <token>`.

---

<a id="polski"></a>
## Polski

*([English version above ↑](#docker-connector))*

Opakowuje [`ckreiling/mcp-server-docker`](https://github.com/ckreiling/mcp-server-docker),
przypięty do commita w [`UPSTREAM_REF`](UPSTREAM_REF), i dokleja
[`supergateway`](https://github.com/supercorp-ai/supergateway), żeby wystawić go jako
streamable-HTTP. Token Bearer sprawdza wspólny front z [`../gateway/`](../gateway/README.md).

Odczyt stanu kontenerów/obrazów i logów; **żadna mutująca operacja Dockera nie dociera
do prawdziwego socketu** — wymuszone przez proxy stojące przed nim, nie przez
zachowanie samego serwera MCP.

### Architektura

```
MCP client (streamable-HTTP, bearer token)
   -> mcp-docker-connector (sprawdzenie tokenu + supergateway, stdio -> streamable-HTTP)
       -> docker-socket-proxy (POST=0, read-only)
           -> /var/run/docker.sock
```

`docker-socket-proxy` ([tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy))
to jedyny kontener, który w ogóle dotyka `docker.sock`. Socket jest zamontowany `:ro`, ale
to chroni tylko sam plik gniazda, a nie API za nim: klient z dostępem do gniazda `:ro`
nadal może wysłać dowolne wywołanie API Dockera. To `POST=0` robi z API interfejs tylko do
odczytu: twardo blokuje każde mutujące wywołanie, niezależnie od tego o co poprosi serwer
MCP czy model — nawet skompromitowany albo błędny serwer MCP się przez to nie przebije.
Potwierdzone na żywo: próba zapisu (np. `create_network`) zwraca `403` wprost z proxy,
zanim w ogóle dotrze do prawdziwego demona Dockera.

Wszystko, czego nie włączono na proxy, też odpowiada `403`. Na przykład `list_networks`
kończy się `403`, dopóki nie ustawisz `NETWORKS=1` na proxy (zaobserwowano). Włączaj tylko
te endpointy, których potrzebujesz.

### Konfiguracja

| Zmienna | Ustawiana na | Wymagana | Przykład | Uwagi |
|---|---|---|---|---|
| `CONTAINERS` | `docker-socket-proxy` | tak | `1` | włącza endpointy odczytu związane z kontenerami |
| `IMAGES` | `docker-socket-proxy` | tak | `1` | włącza endpointy odczytu związane z obrazami |
| `POST` | `docker-socket-proxy` | tak | `0` | **to jest właściwe wymuszenie trybu tylko-do-odczytu** — blokuje wszystkie mutujące wywołania |
| `DOCKER_HOST` | `mcp-docker-connector` | tak | `tcp://docker-socket-proxy:2375` | musi wskazywać na proxy, nigdy bezpośrednio na `docker.sock` |
| `MCP_BEARER_TOKEN_FILE` | `mcp-docker-connector` | tak (albo `MCP_BEARER_TOKEN`) | `/run/secrets/mcp_bearer_token` | plik z tokenem, który twój klient MCP wysyła jako `Authorization: Bearer ...`; zobacz [README bramki](../gateway/README.md#token) (utwórz plik przed pierwszym startem) |
| `GATEWAY_STATEFUL` | `mcp-docker-connector` | nie | `true` | jeden proces `mcp-server-docker` na sesję klienta zamiast jednego na żądanie. **Ustaw na wolnych lub obciążonych hostach**, zobacz niżej. Domyślnie `false` |
| `GATEWAY_SESSION_TIMEOUT_MS` | `mcp-docker-connector` | nie | `1800000` | limit bezczynności sesji stateful; przed zmianą zobacz [README bramki](../gateway/README.md#stateless-or-stateful) |

`UPSTREAM_REF` przypina dokładny commit `ckreiling/mcp-server-docker`, który się buduje —
zobacz sekcję "Pół-automatyczne aktualizacje upstreamu" w głównym README, jak to jest
bumpowane.

### Wolne hosty: ustaw `GATEWAY_STATEFUL=true`

Domyślnie każde żądanie uruchamia nowy proces `mcp-server-docker` (Python). Na szybkim
hoście tego nie zauważysz. Na obciążonym trwało to 5,7 do 8,4 s na żądanie (zmierzone przy
load average około 7). Klient zaczyna od kilku żądań, więc rezygnował, a konektor
pokazywał „Connection issue”, choć token, proxy i WAF były w porządku. W logu kontenera
objaw wygląda tak: klient wysyła `initialize` w kółko i nigdy nie przechodzi do
`tools/list`.

Z `GATEWAY_STATEFUL=true` proces startuje raz na sesję: pierwsze `initialize` w sesji nadal
trwa pełny czas startu, a kolejne żądania trwały 0,02 do 0,06 s. Domyślnie zostaje `false`,
bo na szybkim hoście tryb stateless działa i nie ma sesji, które mogą wygasać albo się
kumulować. Szczegóły (nagłówek `Mcp-Session-Id`, którego potrzebuje ręcznie napisany test,
co się dzieje po wygaśnięciu sesji, jak obserwować narastanie procesów) są w
[README bramki](../gateway/README.md#stateless-or-stateful), razem ze
[skryptem pełnego handshake](../gateway/README.md#full-handshake-works-in-both-modes).

### Przykład docker-compose

```yaml
services:
  docker-socket-proxy:
    image: ghcr.io/tecnativa/docker-socket-proxy:latest
    environment:
      CONTAINERS: 1
      IMAGES: 1
      POST: 0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks: [mcp]
    restart: unless-stopped

  mcp-docker-connector:
    build:
      context: .
      dockerfile: docker/Dockerfile.gateway
    # or, once build-docker.yml has published an image for your fork:
    # image: ghcr.io/<your-github-user>/<your-repo>/docker:latest
    environment:
      DOCKER_HOST: tcp://docker-socket-proxy:2375
      MCP_BEARER_TOKEN_FILE: /run/secrets/mcp_bearer_token
      # GATEWAY_STATEFUL: "true"   # on slow or loaded hosts, see above
    volumes:
      - /path/on/host/bearer_token:/run/secrets/mcp_bearer_token:ro
    depends_on: [docker-socket-proxy]
    networks: [mcp]
    restart: unless-stopped

networks:
  mcp:
    driver: bridge
```

Daj temu własną sieć, odizolowaną od sieci, której używają twoje inne, nie-MCP-owe
kontenery — nie musi się do nich dostać, a one nie muszą dostać się do niego.

Potem wystaw port 8000 kontenera `mcp-docker-connector` w sposób opisany w głównym
README, i dodaj go do swojego klienta MCP jako `https://<twój-host>/mcp` z
`Authorization: Bearer <token>`.
