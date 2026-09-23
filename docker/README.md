# docker connector

*([Polska wersja poniżej ↓](#polski))*

Wraps [`ckreiling/mcp-server-docker`](https://github.com/ckreiling/mcp-server-docker), pinned
to the commit in [`UPSTREAM_REF`](UPSTREAM_REF), and adds [`supergateway`](https://github.com/supercorp-ai/supergateway)
to expose it as streamable-HTTP.

Read access to container/image state and logs; **no mutating Docker operations reach the
real socket**, enforced by the proxy in front of it — not by the MCP server's own
behavior.

## Architecture

```
MCP client (streamable-HTTP, bearer token)
   -> mcp-docker-connector (supergateway, stdio -> streamable-HTTP)
       -> docker-socket-proxy (POST=0, read-only)
           -> /var/run/docker.sock
```

`docker-socket-proxy` ([tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy))
is the only container that ever touches `docker.sock`, and it's mounted `:ro`. `POST=0`
hard-blocks every mutating API call, regardless of what the MCP server or the model
asks for — even a compromised or buggy MCP server can't get past it. Confirmed live: a
write attempt (e.g. `create_network`) returns `403` straight from the proxy, before it
ever reaches the real Docker daemon.

## Configuration

| Variable | Set on | Required | Example | Notes |
|---|---|---|---|---|
| `CONTAINERS` | `docker-socket-proxy` | yes | `1` | enables container-related read endpoints |
| `IMAGES` | `docker-socket-proxy` | yes | `1` | enables image-related read endpoints |
| `POST` | `docker-socket-proxy` | yes | `0` | **this is the read-only enforcement** — blocks all mutating calls |
| `DOCKER_HOST` | `mcp-docker-connector` | yes | `tcp://docker-socket-proxy:2375` | must point at the proxy, never directly at `docker.sock` |
| `MCP_BEARER_TOKEN` | `mcp-docker-connector` | yes | a random 32+ char string | token your MCP client sends as `Authorization: Bearer ...` |

`UPSTREAM_REF` pins the exact commit of `ckreiling/mcp-server-docker` that gets built —
see the root README's "Semi-automatic upstream updates" for how that gets bumped.

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
      MCP_BEARER_TOKEN: ${MCP_DOCKER_BEARER_TOKEN}
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
`Authorization: Bearer <MCP_DOCKER_BEARER_TOKEN>`.

---

<a id="polski"></a>
## Polski

*([English version above ↑](#docker-connector))*

Opakowuje [`ckreiling/mcp-server-docker`](https://github.com/ckreiling/mcp-server-docker),
przypięty do commita w [`UPSTREAM_REF`](UPSTREAM_REF), i dokleja
[`supergateway`](https://github.com/supercorp-ai/supergateway), żeby wystawić go jako
streamable-HTTP.

Odczyt stanu kontenerów/obrazów i logów; **żadna mutująca operacja Dockera nie dociera
do prawdziwego socketu** — wymuszone przez proxy stojące przed nim, nie przez
zachowanie samego serwera MCP.

### Architektura

```
MCP client (streamable-HTTP, bearer token)
   -> mcp-docker-connector (supergateway, stdio -> streamable-HTTP)
       -> docker-socket-proxy (POST=0, read-only)
           -> /var/run/docker.sock
```

`docker-socket-proxy` ([tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy))
to jedyny kontener, który w ogóle dotyka `docker.sock`, i jest zamontowany `:ro`.
`POST=0` twardo blokuje każde mutujące wywołanie API, niezależnie od tego o co poprosi
serwer MCP czy model — nawet skompromitowany albo błędny serwer MCP się przez to nie
przebije. Potwierdzone na żywo: próba zapisu (np. `create_network`) zwraca `403` wprost
z proxy, zanim w ogóle dotrze do prawdziwego demona Dockera.

### Konfiguracja

| Zmienna | Ustawiana na | Wymagana | Przykład | Uwagi |
|---|---|---|---|---|
| `CONTAINERS` | `docker-socket-proxy` | tak | `1` | włącza endpointy odczytu związane z kontenerami |
| `IMAGES` | `docker-socket-proxy` | tak | `1` | włącza endpointy odczytu związane z obrazami |
| `POST` | `docker-socket-proxy` | tak | `0` | **to jest właściwe wymuszenie trybu tylko-do-odczytu** — blokuje wszystkie mutujące wywołania |
| `DOCKER_HOST` | `mcp-docker-connector` | tak | `tcp://docker-socket-proxy:2375` | musi wskazywać na proxy, nigdy bezpośrednio na `docker.sock` |
| `MCP_BEARER_TOKEN` | `mcp-docker-connector` | tak | losowy string 32+ znaków | token, który twój klient MCP wysyła jako `Authorization: Bearer ...` |

`UPSTREAM_REF` przypina dokładny commit `ckreiling/mcp-server-docker`, który się buduje —
zobacz sekcję "Pół-automatyczne aktualizacje upstreamu" w głównym README, jak to jest
bumpowane.

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
      MCP_BEARER_TOKEN: ${MCP_DOCKER_BEARER_TOKEN}
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
`Authorization: Bearer <MCP_DOCKER_BEARER_TOKEN>`.
