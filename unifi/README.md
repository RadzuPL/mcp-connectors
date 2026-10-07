# unifi connector

*([Polska wersja poniżej ↓](#polski))*

Wraps [`unifi-network-mcp`](https://pypi.org/project/unifi-network-mcp/) (source:
[`sirkirby/unifi-mcp`](https://github.com/sirkirby/unifi-mcp)), pinned to the PyPI
version in [`UPSTREAM_REF`](UPSTREAM_REF), and exposes it as streamable-HTTP behind a
bearer token that is actually checked.

## Authentication and sessions

The token check is done by the shared front end in [`../gateway/`](../gateway/README.md):
`supergateway` itself has no inbound authentication, so an authenticating proxy sits in
front of it. That README has the environment variables, how to verify a deployment and
how to add the connector in Claude.

This connector runs with `GATEWAY_STATEFUL=true`. `unifi-network-mcp` logs in to the
controller every time it starts, and in stateless mode supergateway starts a new server
for every HTTP request. Observed on 2026-10-05: three requests within nine seconds meant
three logins, then `AuthenticationRateLimitError` and a 60-second lockout. Stateful mode
keeps one server process, and one login, per client **session**. Claude opens a new session
for every tool call, though (observed 2026-10-07: three calls, three server starts, three
logins; no lockout at that rate), so stateful alone means one login per call, not one per
container lifetime.

To get one login per container lifetime, set `GATEWAY_SHARED_SESSION=true` (opt-in, not
baked into the image; see [Shared-session mode](../gateway/README.md#shared-session-mode)).
In Unraid: Edit the container, *Add another Path, Port, Variable, Label or Device*, Config
Type `Variable`, Name `GATEWAY_SHARED_SESSION`, Key `GATEWAY_SHARED_SESSION`, Value `true`,
Apply. To roll back, remove the variable. Verify with `docker logs mcp-unifi-connector`:
the proxy line must say `shared-session mode ON`, and several tool calls must add no new
wrapped-server start or login after the first. This mode has been tested against a mock
upstream only, not against a real supergateway in CI.

## Read-only: two layers, and neither is a substitute for checking

1. **The account on the controller (the layer that actually enforces it).** Use a
   dedicated *local* account — upstream does not support Ubiquiti SSO accounts or
   accounts with MFA — and give it a view-only role for the Network application, nothing
   for other applications you don't need (e.g. Protect). This is below the MCP server,
   in the same sense as `POST=0` or `:ro` in the other connectors.
2. **The server's policy gates** `UNIFI_POLICY_NETWORK_CREATE`, `_UPDATE` and `_DELETE`
   set to `false`. These are enforced by the server's own code, so treat them as a second
   line, not as the boundary. Without them the server allows mutations behind a
   preview-then-confirm step.

After setup, ask for a mutating tool and confirm it is refused. Don't assume that a
view-only role covers every read you want either — try the reads you care about.

The server also redacts known secret fields (Wi-Fi passphrases, VPN keys, SNMP
community strings, ...) in responses by default; leave `UNIFI_REDACT_SENSITIVE_FIELDS`
at its default.

## Tool discovery

The server defaults to `lazy` registration: a client first sees a handful of meta-tools
(e.g. `unifi_load_tools`, `unifi_execute`, `unifi_batch`) instead of all 203 Network
tools (209 with the meta-tools), which keeps the client's context small. No setting needed.

## Configuration

The gateway variables (`MCP_BEARER_TOKEN_FILE`, `MCP_BEARER_TOKEN`, `MCP_ALLOW_PATH_TOKEN`,
`GATEWAY_SESSION_TIMEOUT_MS`, ...) are described in [`../gateway/README.md`](../gateway/README.md#environment).
The ones specific to this connector:

| Variable | Set on | Required | Example | Notes |
|---|---|---|---|---|
| `UNIFI_MCP_VERSION` | build arg | yes | value of `UPSTREAM_REF` | pins the PyPI version at build time |
| `UNIFI_NETWORK_HOST` | `mcp-unifi-connector` | yes | `192.168.1.1` | controller IP or hostname; must be reachable from the container |
| `UNIFI_NETWORK_USERNAME` | `mcp-unifi-connector` | yes | `claude-ro` | local, view-only account |
| `UNIFI_NETWORK_PASSWORD_FILE` | `mcp-unifi-connector` | yes | `/run/secrets/unifi_password` | path to a file with the password; keeps it out of `docker inspect`. `UNIFI_NETWORK_PASSWORD` also works but is visible in the container's environment |
| `UNIFI_NETWORK_VERIFY_SSL` | `mcp-unifi-connector` | no | `false` | upstream default is `false`; UniFi controllers usually use a self-signed certificate |
| `UNIFI_POLICY_NETWORK_CREATE` / `_UPDATE` / `_DELETE` | `mcp-unifi-connector` | recommended | `false` | see above |
| `UNIFI_NETWORK_SITE`, `UNIFI_NETWORK_PORT` | `mcp-unifi-connector` | no | `default`, `443` | only if yours differ |

Note: the container runs as root, like the other connectors here, so secret files with
mode `600` owned by root are readable. Mount them `:ro`, and create them before the first
start (see the token section of the gateway README).

## docker-compose example

```yaml
services:
  mcp-unifi-connector:
    build:
      context: .
      dockerfile: unifi/Dockerfile.gateway
      args:
        UNIFI_MCP_VERSION: "0.36.2"   # keep in sync with UPSTREAM_REF
    # or: image: ghcr.io/<your-github-user>/<your-repo>/unifi:latest
    environment:
      MCP_BEARER_TOKEN_FILE: /run/secrets/mcp_bearer_token
      UNIFI_NETWORK_HOST: 192.168.1.1
      UNIFI_NETWORK_USERNAME: claude-ro
      UNIFI_NETWORK_PASSWORD_FILE: /run/secrets/unifi_password
      UNIFI_NETWORK_VERIFY_SSL: "false"
      UNIFI_POLICY_NETWORK_CREATE: "false"
      UNIFI_POLICY_NETWORK_UPDATE: "false"
      UNIFI_POLICY_NETWORK_DELETE: "false"
    volumes:
      - /path/on/host/bearer_token:/run/secrets/mcp_bearer_token:ro
      - /path/on/host/unifi_password:/run/secrets/unifi_password:ro
    networks: [mcp]
    restart: unless-stopped

networks:
  mcp:
    driver: bridge
```

Expose port 8000 as described in the root README, and add it to your MCP client as
`https://<your-host>/mcp` with `Authorization: Bearer <token>`.

## Verify your deployment

See [`../gateway/README.md`](../gateway/README.md#verify-your-deployment): without a token
the answer must be `401`, with it `200`, and port 8001 must not answer at all.

## Updates

`unifi-network-mcp` publishes new releases several times a week, and some past releases
were yanked from PyPI because of broken dependencies. That is why the version is pinned
and only moves through a reviewed merge of the weekly PR from `check-upstream.yml`.

---

<a id="polski"></a>
## Polski

*([English version above ↑](#unifi-connector))*

Opakowuje [`unifi-network-mcp`](https://pypi.org/project/unifi-network-mcp/) (kod:
[`sirkirby/unifi-mcp`](https://github.com/sirkirby/unifi-mcp)), przypięty do wersji z
PyPI w [`UPSTREAM_REF`](UPSTREAM_REF), i wystawia go jako streamable-HTTP za tokenem
Bearer, który jest naprawdę sprawdzany.

### Uwierzytelnianie i sesje

Token sprawdza wspólny front z [`../gateway/`](../gateway/README.md): sam `supergateway`
nie ma uwierzytelniania żądań przychodzących, więc przed nim stoi proxy. Tam są zmienne
środowiskowe, sprawdzanie deploymentu i dodawanie connectora w Claude.

Ten connector działa z `GATEWAY_STATEFUL=true`. `unifi-network-mcp` loguje się do
kontrolera przy każdym starcie, a w trybie stateless supergateway uruchamia nowy serwer
dla każdego żądania HTTP. Zaobserwowane 2026-10-05: trzy żądania w dziewięć sekund
oznaczały trzy logowania, potem `AuthenticationRateLimitError` i 60 sekund blokady. Tryb
stateful trzyma jeden proces serwera, i jedno logowanie, na **sesję** klienta. Claude
otwiera jednak nową sesję przy każdym wywołaniu narzędzia (zaobserwowano 2026-10-07: trzy
wywołania, trzy starty serwera, trzy logowania; przy takim tempie bez blokady), więc samo
stateful oznacza jedno logowanie na wywołanie, nie jedno na życie kontenera.

Żeby mieć jedno logowanie na życie kontenera, ustaw `GATEWAY_SHARED_SESSION=true` (opt-in,
nie wbudowane w obraz; zobacz [Tryb współdzielonej sesji](../gateway/README.md#tryb-współdzielonej-sesji)).
W Unraid: Edit kontenera, *Add another Path, Port, Variable, Label or Device*, Config Type
`Variable`, Name `GATEWAY_SHARED_SESSION`, Key `GATEWAY_SHARED_SESSION`, Value `true`,
Apply. Cofnięcie: usuń zmienną. Weryfikacja przez `docker logs mcp-unifi-connector`: linia
proxy ma mówić `shared-session mode ON`, a kolejne wywołania narzędzi nie mogą dodawać
nowego startu serwera ani logowania po pierwszym. Tryb przetestowano tylko na atrapie
upstream, nie na prawdziwym supergateway w CI.

### Tylko odczyt: dwie warstwy, i żadna nie zwalnia ze sprawdzenia

1. **Konto na kontrolerze (warstwa, która faktycznie to wymusza).** Użyj dedykowanego
   konta *lokalnego* — upstream nie wspiera kont SSO Ubiquiti ani kont z MFA — z rolą
   tylko do podglądu w aplikacji Network i bez dostępu do aplikacji, których nie
   potrzebujesz (np. Protect). To działa poniżej serwera MCP, w tym samym sensie co
   `POST=0` albo `:ro` w pozostałych connectorach.
2. **Bramki polityki serwera** `UNIFI_POLICY_NETWORK_CREATE`, `_UPDATE` i `_DELETE`
   ustawione na `false`. Wymusza je kod samego serwera, więc to druga linia obrony, a nie
   granica. Bez nich serwer dopuszcza zmiany po kroku podgląd-i-potwierdzenie.

Po uruchomieniu poproś o narzędzie zmieniające konfigurację i sprawdź, że zostanie
odrzucone. Nie zakładaj też, że rola tylko-do-podglądu pokrywa każdy odczyt, który chcesz
wykonać — wypróbuj te, na których ci zależy.

Serwer domyślnie zaciemnia też znane pola z sekretami (hasła Wi-Fi, klucze VPN, community
SNMP, ...) w odpowiedziach; zostaw `UNIFI_REDACT_SENSITIVE_FIELDS` na wartości domyślnej.

### Wykrywanie narzędzi

Serwer domyślnie działa w trybie `lazy`: klient widzi najpierw kilka meta-narzędzi (np.
`unifi_load_tools`, `unifi_execute`, `unifi_batch`) zamiast wszystkich 203 narzędzi
Network (209 z meta-narzędziami), co oszczędza kontekst klienta. Nic nie trzeba ustawiać.

### Konfiguracja

Zmienne bramki (`MCP_BEARER_TOKEN_FILE`, `MCP_BEARER_TOKEN`, `MCP_ALLOW_PATH_TOKEN`,
`GATEWAY_SESSION_TIMEOUT_MS`, ...) są opisane w [`../gateway/README.md`](../gateway/README.md#zmienne-środowiskowe).
Te specyficzne dla tego connectora:

| Zmienna | Ustawiana na | Wymagana | Przykład | Uwagi |
|---|---|---|---|---|
| `UNIFI_MCP_VERSION` | build arg | tak | wartość `UPSTREAM_REF` | przypina wersję z PyPI w czasie builda |
| `UNIFI_NETWORK_HOST` | `mcp-unifi-connector` | tak | `192.168.1.1` | IP lub nazwa kontrolera; musi być osiągalny z kontenera |
| `UNIFI_NETWORK_USERNAME` | `mcp-unifi-connector` | tak | `claude-ro` | lokalne konto tylko do podglądu |
| `UNIFI_NETWORK_PASSWORD_FILE` | `mcp-unifi-connector` | tak | `/run/secrets/unifi_password` | ścieżka do pliku z hasłem; hasło nie jest widoczne w `docker inspect`. `UNIFI_NETWORK_PASSWORD` też działa, ale jest widoczne w środowisku kontenera |
| `UNIFI_NETWORK_VERIFY_SSL` | `mcp-unifi-connector` | nie | `false` | domyślnie upstream ma `false`; kontrolery UniFi zwykle mają certyfikat samopodpisany |
| `UNIFI_POLICY_NETWORK_CREATE` / `_UPDATE` / `_DELETE` | `mcp-unifi-connector` | zalecane | `false` | patrz wyżej |
| `UNIFI_NETWORK_SITE`, `UNIFI_NETWORK_PORT` | `mcp-unifi-connector` | nie | `default`, `443` | tylko jeśli twoje są inne |

Uwaga: kontener działa jako root, tak jak pozostałe connectory w tym repo, więc pliki z
sekretami z trybem `600` należące do roota da się odczytać. Montuj je jako `:ro` i
twórz przed pierwszym startem (zobacz sekcję o tokenie w README bramki).

### Przykład docker-compose

```yaml
services:
  mcp-unifi-connector:
    build:
      context: .
      dockerfile: unifi/Dockerfile.gateway
      args:
        UNIFI_MCP_VERSION: "0.36.2"   # keep in sync with UPSTREAM_REF
    # or: image: ghcr.io/<your-github-user>/<your-repo>/unifi:latest
    environment:
      MCP_BEARER_TOKEN_FILE: /run/secrets/mcp_bearer_token
      UNIFI_NETWORK_HOST: 192.168.1.1
      UNIFI_NETWORK_USERNAME: claude-ro
      UNIFI_NETWORK_PASSWORD_FILE: /run/secrets/unifi_password
      UNIFI_NETWORK_VERIFY_SSL: "false"
      UNIFI_POLICY_NETWORK_CREATE: "false"
      UNIFI_POLICY_NETWORK_UPDATE: "false"
      UNIFI_POLICY_NETWORK_DELETE: "false"
    volumes:
      - /path/on/host/bearer_token:/run/secrets/mcp_bearer_token:ro
      - /path/on/host/unifi_password:/run/secrets/unifi_password:ro
    networks: [mcp]
    restart: unless-stopped

networks:
  mcp:
    driver: bridge
```

Wystaw port 8000 w sposób opisany w głównym README, i dodaj go do swojego klienta MCP
jako `https://<twój-host>/mcp` z `Authorization: Bearer <token>`.

### Sprawdź swój deployment

Zobacz [`../gateway/README.md`](../gateway/README.md#sprawdź-swój-deployment): bez tokenu
odpowiedź musi brzmieć `401`, z tokenem `200`, a port 8001 nie może odpowiadać w ogóle.

### Aktualizacje

`unifi-network-mcp` wydaje nowe wersje kilka razy w tygodniu, a część dawnych wydań była
wycofana z PyPI przez zepsute zależności. Dlatego wersja jest przypięta i zmienia się
tylko przez przejrzany merge cotygodniowego PR-a z `check-upstream.yml`.
