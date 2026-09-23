# metrics connector

*([Polska wersja poniżej ↓](#polski))*

An example of bridging an **SSE-only** MCP server into streamable-HTTP. Built and
tested against [Glances](https://nicolargo.github.io/glances/) (`--enable-mcp`), but the
technique — an `mcp-proxy` client bridge in front of `supergateway` — works for any MCP
server that only speaks the legacy SSE transport, not just Glances.

## Why the extra hop

Glances' MCP server (like some other SSE-only servers) exposes two endpoints
(`/mcp/sse` for the event stream, `/mcp/messages/` for JSON-RPC) instead of a single
streamable-HTTP endpoint. MCP clients that expect streamable-HTTP can't talk to that
directly. [`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy) connects to the SSE
server **as a client** and re-exposes it over stdio; `supergateway` then wraps that
stdio and exposes it as streamable-HTTP with its own bearer token — exactly like the
`docker/` and `files/` connectors.

```
MCP client (streamable-HTTP, bearer token)
   -> mcp-metrics-connector: supergateway (stdio -> streamable-HTTP)
       -> mcp-proxy (SSE client -> stdio)
           -> the wrapped MCP server (SSE transport, Basic Auth)
```

## Why there's no `UPSTREAM_REF` here

Unlike `docker/` and `files/`, this folder doesn't vendor one pinned external repo — it
composes two independently-versioned, off-the-shelf tools (`mcp-proxy` from PyPI,
`supergateway` from npm) directly in the Dockerfile. There's nothing for a single
`UPSTREAM_REF` to pin, so this folder deliberately has none, and `check-upstream.yml`
has no job tracking it. Bump package versions by hand in `Dockerfile.gateway` when
needed.

## A real version pin you should keep

`Dockerfile.gateway` pins `"mcp<2.0"` alongside `mcp-proxy`:

```dockerfile
RUN pip install --no-cache-dir "mcp<2.0" mcp-proxy
```

This isn't a style choice — it's a genuine incompatibility between two PyPI packages.
`mcp-proxy` 0.12.0 (the latest release at the time this was built) imports `request_ctx`
from `mcp.server.lowlevel.server`; the `mcp` SDK removed/relocated that in its 2.x
releases. Install both at their current latest versions and the container crash-loops
on startup with `ImportError: cannot import name 'request_ctx'`. Re-check this pin if
you bump either package.

## Your SSE server needs to allow the Host header it'll actually see

If you put this behind a reverse proxy on the default HTTPS port (443), the client
never sends an explicit port in its `Host` header. Some MCP servers' host-allowlist
checks assume a port is always present and never match in that case — Glances 4.5.6 has
exactly this bug (`_build_transport_security()` appends `:*` to every bare hostname in
`mcp_allowed_hosts`, and the SDK's wildcard-port matching requires the incoming `Host`
header to literally start with `"<host>:"`, which a default-port HTTPS client never
sends). No list of hostnames can work around it. If you hit a `421 Invalid Host header`
here, the fix on the Glances side is `mcp_allowed_hosts=*` — Glances' own documented
escape hatch, with a logged warning that you need a trusted reverse proxy in front of
it (which, if you're reading this, you do).

## No tools — resources and prompts only

Glances' MCP server exposes **resources and prompts, not tools**:
`glances://stats`, `glances://stats/{plugin}`, `glances://limits`, `glances://plugins`;
prompts `system_health_summary`, `alert_analysis`, `top_processes_report`,
`storage_health`. Your MCP client can't call anything on this connector mid-conversation
the way it would call a tool — you (or the model, if your client supports it) have to
manually attach a resource first (e.g. "All stats"), and only then does the assistant
have data to work with. A client showing "no tools available" for this connector is
expected, not a sign anything is broken.

## Configuration

| Variable | Set on | Required | Example | Notes |
|---|---|---|---|---|
| `GLANCES_SSE_URL` | `mcp-metrics-connector` | yes | `http://glances-host:61208/mcp/sse` | the wrapped server's SSE endpoint |
| `GLANCES_USER` | `mcp-metrics-connector` | yes | `claude` | Basic Auth login for the wrapped server |
| `GLANCES_PASSWORD` | `mcp-metrics-connector` | yes | — | Basic Auth password |
| `MCP_BEARER_TOKEN` | `mcp-metrics-connector` | yes | a random 32+ char string | token your MCP client sends as `Authorization: Bearer ...` — unrelated to the Basic Auth credentials above, a separate layer |

## docker-compose example

```yaml
services:
  mcp-metrics-connector:
    build:
      context: .
      dockerfile: metrics/Dockerfile.gateway
    # or: image: ghcr.io/<your-github-user>/<your-repo>/metrics:latest
    environment:
      GLANCES_SSE_URL: http://your-glances-host:61208/mcp/sse
      GLANCES_USER: claude
      GLANCES_PASSWORD: ${GLANCES_PASSWORD}
      MCP_BEARER_TOKEN: ${MCP_METRICS_BEARER_TOKEN}
    networks: [mcp]
    restart: unless-stopped

networks:
  mcp:
    driver: bridge
```

Expose port 8000 as described in the root README, and add it to your MCP client as
`https://<your-host>/mcp` with `Authorization: Bearer <MCP_METRICS_BEARER_TOKEN>`.

---

<a id="polski"></a>
## Polski

*([English version above ↑](#metrics-connector))*

Przykład mostkowania serwera MCP dostępnego **tylko po SSE** do streamable-HTTP.
Zbudowane i przetestowane na [Glances](https://nicolargo.github.io/glances/)
(`--enable-mcp`), ale technika — most kliencki `mcp-proxy` przed `supergateway` —
działa dla dowolnego serwera MCP, który mówi tylko starym transportem SSE, nie tylko
dla Glances.

### Po co ten dodatkowy hop

Serwer MCP Glances (jak niektóre inne serwery tylko-SSE) wystawia dwa endpointy
(`/mcp/sse` dla strumienia zdarzeń, `/mcp/messages/` dla JSON-RPC) zamiast jednego
endpointu streamable-HTTP. Klienci MCP, którzy oczekują streamable-HTTP, nie potrafią
się z tym bezpośrednio dogadać. [`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy)
łączy się z serwerem SSE **jako klient** i wystawia go z powrotem po stdio;
`supergateway` opakowuje potem ten stdio i wystawia go jako streamable-HTTP z własnym
bearer tokenem — dokładnie jak connectory `docker/` i `files/`.

```
MCP client (streamable-HTTP, bearer token)
   -> mcp-metrics-connector: supergateway (stdio -> streamable-HTTP)
       -> mcp-proxy (SSE client -> stdio)
           -> the wrapped MCP server (SSE transport, Basic Auth)
```

### Dlaczego nie ma tu `UPSTREAM_REF`

W przeciwieństwie do `docker/` i `files/`, ten folder nie opakowuje jednego przypiętego,
zewnętrznego repo — składa dwa niezależnie wersjonowane, gotowe narzędzia (`mcp-proxy`
z PyPI, `supergateway` z npm) wprost w Dockerfile. Nie ma tu czego przypiąć jednym
`UPSTREAM_REF`, więc ten folder celowo go nie ma, a `check-upstream.yml` nie ma dla
niego joba. Wersje pakietów bumpuje się ręcznie w `Dockerfile.gateway`, gdy zajdzie
potrzeba.

### Prawdziwy pin wersji, który warto zostawić

`Dockerfile.gateway` przypina `"mcp<2.0"` obok `mcp-proxy`:

```dockerfile
RUN pip install --no-cache-dir "mcp<2.0" mcp-proxy
```

To nie jest kwestia stylu — to realna niezgodność między dwoma pakietami na PyPI.
`mcp-proxy` 0.12.0 (najnowsze wydanie w chwili budowania tego) importuje `request_ctx`
z `mcp.server.lowlevel.server`; SDK `mcp` usunął/przeniósł to w wydaniach 2.x. Zainstaluj
oba pakiety w ich aktualnie najnowszych wersjach, a kontener wpada w crash-loop przy
starcie z `ImportError: cannot import name 'request_ctx'`. Sprawdź ten pin ponownie,
jeśli bumpujesz którykolwiek z pakietów.

### Twój serwer SSE musi zaakceptować nagłówek Host, jaki faktycznie zobaczy

Jeśli stawiasz to za reverse proxy na domyślnym porcie HTTPS (443), klient nigdy nie
wysyła jawnego portu w nagłówku `Host`. Niektóre serwery MCP mają w sprawdzaniu
allowlisty hostów założenie, że port zawsze jest obecny, i nigdy się w takim przypadku
nie dopasują — Glances 4.5.6 ma dokładnie taki bug (`_build_transport_security()`
dokleja `:*` do każdego gołego hosta w `mcp_allowed_hosts`, a dopasowywanie z
wildcardem portu w SDK wymaga, żeby przychodzący nagłówek `Host` dosłownie zaczynał się
od `"<host>:"`, czego klient HTTPS na domyślnym porcie nigdy nie wysyła). Żadna lista
hostów nie może tego obejść. Jeśli trafisz tu na `421 Invalid Host header`,
rozwiązaniem po stronie Glances jest `mcp_allowed_hosts=*` — własny, udokumentowany
wentyl bezpieczeństwa Glances, z logowanym ostrzeżeniem że potrzebujesz przed sobą
zaufanego reverse proxy (co, jeśli to czytasz, masz).

### Brak narzędzi — tylko zasoby i prompty

Server MCP Glances wystawia **zasoby (resources) i prompty, nie narzędzia (tools)**:
`glances://stats`, `glances://stats/{plugin}`, `glances://limits`, `glances://plugins`;
prompty `system_health_summary`, `alert_analysis`, `top_processes_report`,
`storage_health`. Twój klient MCP nie może nic wywołać na tym connectorze w trakcie
rozmowy tak, jak wywołałby narzędzie — trzeba (Ty, albo model, jeśli klient na to
pozwala) ręcznie dołączyć zasób (np. "All stats"), i dopiero wtedy asystent ma dane do
pracy. Klient pokazujący "no tools available" dla tego connectora jest oczekiwany, nie
jest oznaką awarii.

### Konfiguracja

| Zmienna | Ustawiana na | Wymagana | Przykład | Uwagi |
|---|---|---|---|---|
| `GLANCES_SSE_URL` | `mcp-metrics-connector` | tak | `http://glances-host:61208/mcp/sse` | endpoint SSE opakowywanego serwera |
| `GLANCES_USER` | `mcp-metrics-connector` | tak | `claude` | login Basic Auth do opakowywanego serwera |
| `GLANCES_PASSWORD` | `mcp-metrics-connector` | tak | — | hasło Basic Auth |
| `MCP_BEARER_TOKEN` | `mcp-metrics-connector` | tak | losowy string 32+ znaków | token, który twój klient MCP wysyła jako `Authorization: Bearer ...` — niezwiązany z danymi Basic Auth wyżej, osobna warstwa |

### Przykład docker-compose

```yaml
services:
  mcp-metrics-connector:
    build:
      context: .
      dockerfile: metrics/Dockerfile.gateway
    # or: image: ghcr.io/<your-github-user>/<your-repo>/metrics:latest
    environment:
      GLANCES_SSE_URL: http://your-glances-host:61208/mcp/sse
      GLANCES_USER: claude
      GLANCES_PASSWORD: ${GLANCES_PASSWORD}
      MCP_BEARER_TOKEN: ${MCP_METRICS_BEARER_TOKEN}
    networks: [mcp]
    restart: unless-stopped

networks:
  mcp:
    driver: bridge
```

Wystaw port 8000 w sposób opisany w głównym README, i dodaj go do swojego klienta MCP
jako `https://<twój-host>/mcp` z `Authorization: Bearer <MCP_METRICS_BEARER_TOKEN>`.
