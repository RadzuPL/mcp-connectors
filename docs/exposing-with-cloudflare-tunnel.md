# Exposing connectors via Cloudflare Tunnel

*([Polska wersja poniżej ↓](#polski))*

One concrete, worked example of getting a gateway container's port 8000 reachable at a
public HTTPS hostname, using Cloudflare Tunnel. Not the only way to do this (see the
root README for alternatives) — documented here because it's what was actually tested,
including two gotchas that cost real debugging time.

## Setup

1. Run a dedicated `cloudflared` tunnel container on the same Docker network as your
   gateway containers (a separate tunnel from any you already use for other services
   keeps this traffic's routing and rules independent of everything else).
2. In the tunnel's public hostname configuration, point each connector's hostname
   (e.g. `mcp-docker.your-domain.example`) at `http://<gateway-container-name>:8000`.
3. Add a Cloudflare **Custom Rule** (Security → WAF → Custom rules) that lets your MCP
   provider's traffic through *before* any existing rules that would otherwise block it
   (geographic restrictions, bot-fight rules, etc. all apply to the whole zone by
   default, and most AI providers' outbound IP ranges don't originate from wherever you
   normally allow traffic from).

## Gotcha 1: operator precedence in the rule expression

```
(http.host eq "mcp-docker.your-domain.example" or http.host eq "mcp-files.your-domain.example")
  and ip.src in {<provider's published IP range>}
```

`and` binds tighter than `or` in Cloudflare's rule syntax. Without the parentheses
around the hostname alternatives, the IP condition would only apply to the last host in
the list, silently leaving the others unprotected (or unreachable, depending on which
way the mistake goes). Double-check this every time you edit the rule.

Action: **Skip** — "All remaining custom rules" + "All Super Bot Fight Mode Rules".
Execution order: **first**, above your other zone rules, so `Skip` actually has
something below it to skip.

If you're adding this for Claude specifically, Anthropic publishes its current IP
ranges at https://platform.claude.com/docs/en/api/ip-addresses — that range can change
without notice, so don't treat it as permanent.

## Gotcha 2: an SSE-only server's own Host-header check, through a reverse proxy on 443

If one of your connectors bridges an SSE-only MCP server (see `metrics/`), that server
may do its own Host-header validation independent of anything Cloudflare or your tunnel
does. Standard HTTPS clients never send an explicit port for the default port 443 — and
some servers' allowlist logic assumes a port is always present, so no list of hostnames
you configure will ever match. See `metrics/README.md` for the specific bug this hit
(Glances 4.5.6) and its fix. If you hit an unexplained `421` from a server you're
exposing this way, this class of bug is worth checking for.

---

<a id="polski"></a>
## Polski

*([English version above ↑](#exposing-connectors-via-cloudflare-tunnel))*

Jeden konkretny, przetestowany przykład tego, jak doprowadzić ruch do portu 8000
kontenera gatewaya pod publicznym hostname HTTPS, używając Cloudflare Tunnel. To nie
jedyny sposób (zobacz główne README po alternatywy) — udokumentowane tutaj, bo to
faktycznie zostało przetestowane, wraz z dwiema pułapkami, które kosztowały realny czas
debugowania.

### Setup

1. Odpal dedykowany kontener tunelu `cloudflared` w tej samej sieci Dockera co twoje
   kontenery gatewayów (osobny tunel od tego, którego może już używasz do innych usług,
   trzyma routing i reguły tego ruchu niezależnie od reszty).
2. W konfiguracji public hostname tunelu, skieruj hostname każdego connectora (np.
   `mcp-docker.twoja-domena.example`) na `http://<nazwa-kontenera-gatewaya>:8000`.
3. Dodaj Cloudflare **Custom Rule** (Security → WAF → Custom rules), która przepuszcza
   ruch twojego providera MCP *przed* jakimikolwiek istniejącymi regułami, które by go
   inaczej zablokowały (ograniczenia geograficzne, reguły bot-fight itd. domyślnie
   działają na całą strefę, a zakresy IP większości providerów AI nie pochodzą z
   miejsc, skąd normalnie wpuszczasz ruch).

### Pułapka 1: kolejność operatorów w wyrażeniu reguły

```
(http.host eq "mcp-docker.your-domain.example" or http.host eq "mcp-files.your-domain.example")
  and ip.src in {<provider's published IP range>}
```

`and` wiąże mocniej niż `or` w składni reguł Cloudflare. Bez nawiasów wokół alternatywy
hostów, warunek na IP dotyczyłby tylko ostatniego hosta z listy, po cichu zostawiając
resztę bez ochrony (albo bez dostępu — zależnie w którą stronę pójdzie pomyłka).
Sprawdzaj to za każdym razem, gdy edytujesz tę regułę.

Action: **Skip** — "All remaining custom rules" + "All Super Bot Fight Mode Rules".
Execution order: **first**, nad resztą reguł strefy, żeby `Skip` miał w ogóle co
pomijać.

Jeśli dodajesz to konkretnie dla Claude, Anthropic publikuje swoje aktualne zakresy IP
pod https://platform.claude.com/docs/en/api/ip-addresses — ten zakres może się zmienić
bez zapowiedzi, więc nie traktuj go jako stały.

### Pułapka 2: własne sprawdzanie nagłówka Host przez serwer tylko-SSE, przez reverse proxy na 443

Jeśli jeden z twoich connectorów mostkuje serwer MCP tylko-SSE (zobacz `metrics/`),
taki serwer może robić własną walidację nagłówka Host, niezależną od tego co robi
Cloudflare czy twój tunel. Standardowi klienci HTTPS nigdy nie wysyłają jawnego portu
dla domyślnego portu 443 — a logika allowlisty niektórych serwerów zakłada, że port
zawsze jest obecny, więc żadna skonfigurowana przez ciebie lista hostów nigdy się nie
dopasuje. Zobacz `metrics/README.md` po konkretny bug, na który to trafiło (Glances
4.5.6) i jego fix. Jeśli trafisz na niewyjaśniony `421` od serwera, który wystawiasz w
ten sposób, warto sprawdzić właśnie tę klasę buga.
