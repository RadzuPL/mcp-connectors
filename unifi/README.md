# unifi connector

*([Polska wersja poniżej ↓](#polski))*

Wraps [`unifi-network-mcp`](https://pypi.org/project/unifi-network-mcp/) (source:
[`sirkirby/unifi-mcp`](https://github.com/sirkirby/unifi-mcp)), pinned to the PyPI
version in [`UPSTREAM_REF`](UPSTREAM_REF), and exposes it as streamable-HTTP behind a
bearer token that is actually checked.

## Authentication: why there is a proxy in this container

`supergateway` 4.1.0 has **no inbound authentication**. Its `--oauth2Bearer` flag only
adds an `Authorization` header; it never checks the header of incoming requests.
Verified on 2026-10-05: gateways started with `--oauth2Bearer "$MCP_BEARER_TOKEN"`
answer `200` to a request with no token at all.

So this image runs two processes:

```
MCP client (streamable-HTTP, Authorization: Bearer <token>)
   -> auth-proxy.js on :8000   (checks the token, answers 401 otherwise)
       -> supergateway on 127.0.0.1:8001   (stdio -> streamable-HTTP, no auth of its own)
           -> unifi-network-mcp (stdio)
```

[`auth-proxy.js`](auth-proxy.js) is ~100 lines of plain Node (core modules only),
compares the token in constant time, strips the `Authorization` header before
forwarding, streams SSE responses through unchanged, and refuses to start if no token
(or one shorter than 24 characters) is configured. [`entrypoint.sh`](entrypoint.sh)
stops the whole container if either process dies, so a dead proxy can never leave an
unauthenticated gateway behind. [`test-proxy.js`](test-proxy.js) runs in CI before every
build; if it fails, no image is published.

The server's own HTTP transport (unauthenticated upstream, meant for trusted local
clients) is deliberately not enabled; upstream's Host-header validation never comes into
play.

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
(e.g. `unifi_load_tools`, `unifi_execute`, `unifi_batch`) instead of all 209 Network
tools, which keeps the client's context small. No setting needed.

## Configuration

| Variable | Set on | Required | Example | Notes |
|---|---|---|---|---|
| `UNIFI_MCP_VERSION` | build arg | yes | value of `UPSTREAM_REF` | pins the PyPI version at build time |
| `MCP_BEARER_TOKEN_FILE` | `mcp-unifi-connector` | yes (or `MCP_BEARER_TOKEN`) | `/run/secrets/mcp_bearer_token` | file containing the token, at least 24 characters (`openssl rand -hex 32`). Preferred: the token stays out of `docker inspect` and out of the process list |
| `MCP_BEARER_TOKEN` | `mcp-unifi-connector` | alternative to the file | a random 32+ char string | works, but the value is visible in `docker inspect` and in container templates (it is no longer in the process list) |
| `MCP_ALLOW_PATH_TOKEN` | `mcp-unifi-connector` | no | `true` | also accepts the token as the first URL path segment (`https://<host>/<token>/mcp`), for clients that cannot send an `Authorization` header. Off by default, because URLs end up in logs |
| `UNIFI_NETWORK_HOST` | `mcp-unifi-connector` | yes | `192.168.1.1` | controller IP or hostname; must be reachable from the container |
| `UNIFI_NETWORK_USERNAME` | `mcp-unifi-connector` | yes | `claude-ro` | local, view-only account |
| `UNIFI_NETWORK_PASSWORD_FILE` | `mcp-unifi-connector` | yes | `/run/secrets/unifi_password` | path to a file with the password; keeps it out of `docker inspect`. `UNIFI_NETWORK_PASSWORD` also works but is visible in the container's environment |
| `UNIFI_NETWORK_VERIFY_SSL` | `mcp-unifi-connector` | no | `false` | upstream default is `false`; UniFi controllers usually use a self-signed certificate |
| `UNIFI_POLICY_NETWORK_CREATE` / `_UPDATE` / `_DELETE` | `mcp-unifi-connector` | recommended | `false` | see above |
| `UNIFI_NETWORK_SITE`, `UNIFI_NETWORK_PORT` | `mcp-unifi-connector` | no | `default`, `443` | only if yours differ |

Note: the container runs as root, like the other connectors here, so secret files with
mode `600` owned by root are readable. Mount them `:ro`.

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

From a container on the same Docker network. Without a token the answer must be `401`;
if you get `200`, the gateway is open.

```bash
docker run --rm --network mcp curlimages/curl -s -o /dev/null -w "%{http_code}\n" -X POST http://mcp-unifi-connector:8000/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
```

The same request with `-H "Authorization: Bearer <token>"` must return `200`.

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

### Uwierzytelnianie: dlaczego w tym kontenerze jest proxy

`supergateway` 4.1.0 **nie ma uwierzytelniania żądań przychodzących**. Flaga
`--oauth2Bearer` tylko dodaje nagłówek `Authorization`; nigdy nie sprawdza nagłówka w
żądaniach przychodzących. Sprawdzone 2026-10-05: bramki uruchomione z
`--oauth2Bearer "$MCP_BEARER_TOKEN"` odpowiadają `200` na żądanie bez żadnego tokenu.

Dlatego ten obraz uruchamia dwa procesy:

```
MCP client (streamable-HTTP, Authorization: Bearer <token>)
   -> auth-proxy.js na :8000   (sprawdza token, w przeciwnym razie odpowiada 401)
       -> supergateway na 127.0.0.1:8001   (stdio -> streamable-HTTP, bez własnej autoryzacji)
           -> unifi-network-mcp (stdio)
```

[`auth-proxy.js`](auth-proxy.js) to ok. 100 linii czystego Node (tylko moduły core),
porównuje token w stałym czasie, usuwa nagłówek `Authorization` przed przekazaniem
dalej, przepuszcza odpowiedzi SSE strumieniowo i odmawia startu, jeśli nie ma tokenu
(albo jest krótszy niż 24 znaki). [`entrypoint.sh`](entrypoint.sh) zatrzymuje cały
kontener, jeśli któryś z procesów padnie, więc martwe proxy nie zostawi nigdy
nieuwierzytelnionej bramki. [`test-proxy.js`](test-proxy.js) odpala się w CI przed każdym
buildem; jeśli padnie, żaden obraz się nie publikuje.

Własny transport HTTP serwera (nieuwierzytelniony w upstreamie, przeznaczony dla
zaufanych klientów lokalnych) jest celowo wyłączony; własna walidacja nagłówka Host
upstreamu nie wchodzi w grę.

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
`unifi_load_tools`, `unifi_execute`, `unifi_batch`) zamiast wszystkich 209 narzędzi
Network, co oszczędza kontekst klienta. Nic nie trzeba ustawiać.

### Konfiguracja

| Zmienna | Ustawiana na | Wymagana | Przykład | Uwagi |
|---|---|---|---|---|
| `UNIFI_MCP_VERSION` | build arg | tak | wartość `UPSTREAM_REF` | przypina wersję z PyPI w czasie builda |
| `MCP_BEARER_TOKEN_FILE` | `mcp-unifi-connector` | tak (albo `MCP_BEARER_TOKEN`) | `/run/secrets/mcp_bearer_token` | plik z tokenem, minimum 24 znaki (`openssl rand -hex 32`). Zalecane: token nie jest widoczny w `docker inspect` ani na liście procesów |
| `MCP_BEARER_TOKEN` | `mcp-unifi-connector` | alternatywa dla pliku | losowy string 32+ znaków | działa, ale wartość jest widoczna w `docker inspect` i w szablonach kontenerów (nie ma jej już na liście procesów) |
| `MCP_ALLOW_PATH_TOKEN` | `mcp-unifi-connector` | nie | `true` | przyjmuje też token jako pierwszy segment ścieżki (`https://<host>/<token>/mcp`), dla klientów, które nie potrafią wysłać nagłówka `Authorization`. Domyślnie wyłączone, bo adresy URL trafiają do logów |
| `UNIFI_NETWORK_HOST` | `mcp-unifi-connector` | tak | `192.168.1.1` | IP lub nazwa kontrolera; musi być osiągalny z kontenera |
| `UNIFI_NETWORK_USERNAME` | `mcp-unifi-connector` | tak | `claude-ro` | lokalne konto tylko do podglądu |
| `UNIFI_NETWORK_PASSWORD_FILE` | `mcp-unifi-connector` | tak | `/run/secrets/unifi_password` | ścieżka do pliku z hasłem; hasło nie jest widoczne w `docker inspect`. `UNIFI_NETWORK_PASSWORD` też działa, ale jest widoczne w środowisku kontenera |
| `UNIFI_NETWORK_VERIFY_SSL` | `mcp-unifi-connector` | nie | `false` | domyślnie upstream ma `false`; kontrolery UniFi zwykle mają certyfikat samopodpisany |
| `UNIFI_POLICY_NETWORK_CREATE` / `_UPDATE` / `_DELETE` | `mcp-unifi-connector` | zalecane | `false` | patrz wyżej |
| `UNIFI_NETWORK_SITE`, `UNIFI_NETWORK_PORT` | `mcp-unifi-connector` | nie | `default`, `443` | tylko jeśli twoje są inne |

Uwaga: kontener działa jako root, tak jak pozostałe connectory w tym repo, więc pliki z
sekretami z trybem `600` należące do roota da się odczytać. Montuj je jako `:ro`.

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

Z kontenera w tej samej sieci Dockera. Bez tokenu odpowiedź musi brzmieć `401`; jeśli
dostaniesz `200`, bramka jest otwarta.

```bash
docker run --rm --network mcp curlimages/curl -s -o /dev/null -w "%{http_code}\n" -X POST http://mcp-unifi-connector:8000/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
```

To samo żądanie z `-H "Authorization: Bearer <token>"` musi zwrócić `200`.

### Aktualizacje

`unifi-network-mcp` wydaje nowe wersje kilka razy w tygodniu, a część dawnych wydań była
wycofana z PyPI przez zepsute zależności. Dlatego wersja jest przypięta i zmienia się
tylko przez przejrzany merge cotygodniowego PR-a z `check-upstream.yml`.
