# Exposing connectors via Cloudflare Tunnel

*([Polska wersja poniżej ↓](#polski))*

One concrete, worked example of getting a gateway container's port 8000 reachable at a
public HTTPS hostname, using Cloudflare Tunnel. Not the only way to do this (see the
root README for alternatives) — documented here because it's what was actually tested,
including a few gotchas that cost real debugging time.

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

## One hostname for both the app's web UI and its MCP endpoint

For a connector whose wrapped application also has a web UI (`nametag/`, `trilium/`),
you can serve both from one hostname, e.g. `app.your-domain.example`: the UI for you, and
`/mcp` for the MCP client. This needs four pieces, all tested with TriliumNext:

1. **Two routes in the tunnel, path route first.** Tunnel routes are matched top to
   bottom and the first match wins, so the route with a path goes above the route
   without one:

   | # | Hostname | Path | Service |
   |---|---|---|---|
   | 1 | `app.your-domain.example` | `^/mcp` | `http://<connector-container>:8000` |
   | 2 | `app.your-domain.example` | *(empty)* | `http://<server-ip>:<published-port>` |

   The path is a regular expression. Use `^/mcp(/.*)?$` if you want it strict (only
   `/mcp` and below); `^/mcp` also matches `/mcpfoo`, which is harmless here because the
   connector answers 404 for it.
2. **Cloudflare Access in front of the UI only.** Create two Access applications: one for
   the whole host (`app.your-domain.example`) with an *Allow* policy for yourself, and
   one for `app.your-domain.example/mcp` and `app.your-domain.example/mcp/*` with a
   *Bypass* policy (Include: Everyone). Access picks the most specific application, so
   `/mcp` skips the login, while the bearer token on the connector is what protects it.
   Without the bypass app, Access answers the MCP client with a login redirect (`302`)
   and the connector looks broken.
3. **WAF rules: a path-scoped group for the MCP path.** Where you would add a whole host
   to the "allow only the provider's IP range" pair of rules (the Skip rule and its
   Block twin), add this instead, so the UI stays reachable for you and only `/mcp` is
   restricted to the provider's range:

   ```
   (http.host eq "app.your-domain.example" and starts_with(http.request.uri.path, "/mcp"))
   ```

   Put the same group in both rules (Skip: allow the provider's range; Block: block
   everyone outside it). Mind the 4000-character limit of an expression on the Free plan
   and the precedence trap from gotcha 1: the group goes *inside* the outer parentheses.
4. **The application address must be reachable from the connector's network.** See the
   next section.

## Gotcha 3: two Docker networks, and the app's address

The connector sits in the same Docker network as `cloudflared`, but the wrapped
application often lives in another one (typical on Unraid: `docker_network` for apps,
a separate network for MCP). A container name resolves only inside a shared network, so
`http://triliumnext:8080` or `http://nametag:3000` fails with a name-resolution error
even though both containers are healthy. Two ways out:

- put the connector (or the app) in both networks, or
- use the server's IP and the app's *published* port: `TRILIUM_URL=http://192.168.10.15:8887`,
  `NAMETAG_URL=http://192.168.10.15:3033`. The same applies to the tunnel's route for the
  UI (route 2 above): `cloudflared` is in the MCP network too, so it cannot resolve the
  app's container name either.

A quick check from inside the connector's network (a throwaway container on that
network): `curl -i http://<server-ip>:<published-port>/` should answer from the app, not
with a Cloudflare page.

---

<a id="polski"></a>
## Polski

*([English version above ↑](#exposing-connectors-via-cloudflare-tunnel))*

Jeden konkretny, przetestowany przykład tego, jak doprowadzić ruch do portu 8000
kontenera gatewaya pod publicznym hostname HTTPS, używając Cloudflare Tunnel. To nie
jedyny sposób (zobacz główne README po alternatywy) — udokumentowane tutaj, bo to
faktycznie zostało przetestowane, wraz z kilkoma pułapkami, które kosztowały realny czas
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

### Jeden hostname na interfejs WWW aplikacji i jej endpoint MCP

Dla connectora, którego opakowywana aplikacja ma też interfejs WWW (`nametag/`,
`trilium/`), oba można obsłużyć spod jednego hostname, np. `app.twoja-domena.example`:
interfejs dla ciebie, a `/mcp` dla klienta MCP. Potrzebne są cztery elementy, wszystkie
przetestowane z TriliumNext:

1. **Dwie trasy w tunelu, najpierw ta ze ścieżką.** Trasy tunelu są dopasowywane od góry
   i wygrywa pierwsza pasująca, więc trasa ze ścieżką stoi nad trasą bez ścieżki:

   | # | Hostname | Ścieżka | Usługa |
   |---|---|---|---|
   | 1 | `app.twoja-domena.example` | `^/mcp` | `http://<kontener-connectora>:8000` |
   | 2 | `app.twoja-domena.example` | *(puste)* | `http://<ip-serwera>:<opublikowany-port>` |

   Ścieżka to wyrażenie regularne. Użyj `^/mcp(/.*)?$`, jeśli chcesz ściśle (tylko
   `/mcp` i niżej); `^/mcp` pasuje też do `/mcpfoo`, co tu jest nieszkodliwe, bo
   connector odpowie na to 404.
2. **Cloudflare Access tylko przed interfejsem.** Utwórz dwie aplikacje Access: jedną na
   cały host (`app.twoja-domena.example`) z polityką *Allow* tylko dla ciebie i drugą na
   `app.twoja-domena.example/mcp` oraz `app.twoja-domena.example/mcp/*` z polityką
   *Bypass* (Include: Everyone). Access wybiera aplikację o najdokładniejszej ścieżce,
   więc `/mcp` pomija logowanie, a chroni je bearer token connectora. Bez aplikacji z
   bypassem Access odpowiada klientowi MCP przekierowaniem do logowania (`302`) i
   connector wygląda na zepsuty.
3. **Reguły WAF: grupa ograniczona do ścieżki MCP.** Tam, gdzie dopisałbyś cały host do
   pary reguł „tylko zakres IP providera" (reguła Skip i jej bliźniaczka Block), dopisz
   zamiast tego poniższą grupę, żeby interfejs został dostępny dla ciebie, a do `/mcp`
   wpuszczał tylko zakres providera:

   ```
   (http.host eq "app.twoja-domena.example" and starts_with(http.request.uri.path, "/mcp"))
   ```

   Ta sama grupa idzie do obu reguł (Skip: przepuść zakres providera; Block: zablokuj
   wszystkich spoza niego). Pilnuj limitu 4000 znaków wyrażenia na planie Free i
   pułapki z kolejnością operatorów (pułapka 1): grupa wchodzi *do środka* zewnętrznego
   nawiasu.
4. **Adres aplikacji musi być osiągalny z sieci connectora.** Patrz następna sekcja.

### Pułapka 3: dwie sieci Dockera i adres aplikacji

Connector stoi w tej samej sieci Dockera co `cloudflared`, ale opakowywana aplikacja
często leży w innej (typowo na Unraid: `docker_network` dla aplikacji i osobna sieć dla
MCP). Nazwa kontenera rozwiązuje się tylko we wspólnej sieci, więc
`http://triliumnext:8080` albo `http://nametag:3000` kończy się błędem rozwiązywania
nazwy, mimo że oba kontenery są zdrowe. Są dwa wyjścia:

- wstaw connector (albo aplikację) do obu sieci, albo
- użyj IP serwera i *opublikowanego* portu aplikacji: `TRILIUM_URL=http://192.168.10.15:8887`,
  `NAMETAG_URL=http://192.168.10.15:3033`. To samo dotyczy trasy tunelu dla interfejsu
  (trasa 2 wyżej): `cloudflared` też jest w sieci MCP, więc też nie rozwiąże nazwy
  kontenera aplikacji.

Szybki test z sieci connectora (jednorazowy kontener w tej sieci):
`curl -i http://<ip-serwera>:<opublikowany-port>/` powinno odpowiedzieć z aplikacji, a
nie stroną Cloudflare.
