# mcp-connectors

*([Polska wersja poniżej ↓](#polski))*

Gateway containers that take an existing MCP server — often stdio-only, or speaking a
legacy transport — and re-expose it as an authenticated streamable-HTTP endpoint, so it
can be added as a custom connector in Claude or any other MCP client that speaks
streamable-HTTP.

> **Security notice (2026-10-05) — read before exposing anything.** Until this date every
> gateway in this repo started `supergateway` with `--oauth2Bearer "$MCP_BEARER_TOKEN"`.
> In supergateway 4.1.0 that flag only *adds* an `Authorization` header; it does **not**
> check the header of incoming requests, so images built before 2026-10-05 answered `200`
> to a request with no token. All four modules now put a small authenticating proxy
> ([`gateway/auth-proxy.js`](gateway/auth-proxy.js), tested in CI before every build) in
> front of `supergateway`. **Rebuild, redeploy, then verify**: a request without a token
> must return `401` (see [`gateway/README.md`](gateway/README.md#verify-your-deployment)).
> If you copied the old pattern, treat your gateways as unauthenticated until you have.

This repo grew out of connecting an AI agent to a single home server, but nothing in it
is tied to that server. Every piece here — the gateway pattern, the read-only
enforcement, the update automation — works the same on any Docker host you point it at.

## Design principle: blast radius

Every connector gets its own container, its own bearer token, its own exposed
hostname/path, and its own access rule wherever you terminate TLS. No connector can do
more than it was built for, and that boundary is enforced **below** the MCP server
itself, not by trusting the server's own flags or the model's good behavior:

- a proxy in front of a socket/API that hard-blocks mutating calls (`POST=0` on
  `docker-socket-proxy`, in the `docker/` example),
- a `:ro` bind mount so a filesystem server has nothing to write to, even if its own
  code has a write tool (the `files/` example), or
- a credential that can only read, issued by the system being wrapped (the `unifi/`
  example: a view-only local account on the controller).

This is defense in depth: even if a given MCP server had a bug, or a malicious change
landed in its code, the layer underneath would still stop it.

## How a connector works

```
MCP client (streamable-HTTP, bearer token)
   -> gateway container: supergateway (stdio -> streamable-HTTP, own bearer token)
       -> the wrapped MCP server (stdio)
```

Between the client and `supergateway` sits the authenticating proxy from
[`gateway/`](gateway/README.md): `supergateway` has no inbound authentication of its own,
so the proxy is what checks the token.

If the wrapped server only speaks the legacy SSE transport instead of stdio, add one
more hop — a client-side bridge that connects to it and re-exposes it over stdio, so
`supergateway` has something it can wrap (see `metrics/` for a working example using
[`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy)):

```
MCP client (streamable-HTTP, bearer token)
   -> gateway container: supergateway (stdio -> streamable-HTTP, own bearer token)
       -> mcp-proxy (SSE client -> stdio)
           -> the wrapped MCP server (SSE transport)
```

Two independent secrets are involved, and they are never the same thing: the bearer
token the client presents to the gateway, and (only where relevant) whatever
credentials the gateway itself needs to reach the wrapped server.

## Connectors in this repo

Four connectors are included, each wrapping a different real MCP server. Full
parameter tables and docker-compose examples live in each connector's own README. All
four share the authenticating front end in [`gateway/`](gateway/README.md).

| Connector | Folder | Wraps | Read-only enforced by |
|---|---|---|---|
| docker | [`docker/`](docker/README.md) | [`ckreiling/mcp-server-docker`](https://github.com/ckreiling/mcp-server-docker), pinned to a commit | `docker-socket-proxy` in front of it (`POST=0`) |
| files | [`files/`](files/README.md) | the official [`@modelcontextprotocol/server-filesystem`](https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem) | `:ro` bind mounts (swap for `:rw` deliberately, per folder, if you want write access) |
| metrics | [`metrics/`](metrics/README.md) | an SSE-only MCP server (built against [Glances](https://nicolargo.github.io/glances/)) via an `mcp-proxy` + `supergateway` chain | nothing to enforce — the wrapped server only exposes read-only resources and prompts, no tools |
| unifi | [`unifi/`](unifi/README.md) | [`unifi-network-mcp`](https://pypi.org/project/unifi-network-mcp/) from PyPI, pinned to a version, over stdio | a view-only local account on the UniFi controller, with the server's own `UNIFI_POLICY_NETWORK_*` gates as a second line |

`metrics/` is the odd one out on purpose: it doesn't vendor a single pinned upstream
like the other three, it composes two independently-versioned off-the-shelf tools. See
its README for why that means no `UPSTREAM_REF` and no auto-bump job for it.

## Exposing a gateway container

Each gateway listens on port 8000 inside its container and requires
`Authorization: Bearer <token>` (checked by [`gateway/auth-proxy.js`](gateway/auth-proxy.js)).
Getting HTTPS traffic to that port is outside the scope of this repo — put it behind
whatever reverse proxy or tunnel you already use: Cloudflare Tunnel, Tailscale
Funnel/Serve, nginx + Let's Encrypt, Caddy, anything that can terminate TLS and forward
to a container. Point your MCP client at `https://<your-host>/mcp` with that header.

If you use Cloudflare Tunnel, [`docs/exposing-with-cloudflare-tunnel.md`](docs/exposing-with-cloudflare-tunnel.md)
walks through one concrete setup, including two gotchas worth knowing about up front:
an operator-precedence trap in Cloudflare's rule expressions, and a real upstream bug
in Glances that breaks any reverse-proxied deployment on the default HTTPS port.

## Semi-automatic upstream updates

Connectors that vendor someone else's code (`ckreiling/mcp-server-docker`, the official
`@modelcontextprotocol/server-filesystem`, `unifi-network-mcp` from PyPI) pin the version
they build in an `UPSTREAM_REF` file in their folder, instead of tracking
`main`/`latest` live. That version only changes through a deliberate, reviewed merge.

`check-upstream.yml` runs weekly, checks whether the upstream has something newer, and
if so opens a pull request bumping `UPSTREAM_REF` on its own. Nothing builds or
publishes automatically — merging that PR (a conscious decision) is what triggers the
real build and updates `:latest`. It's a trade-off: zero manual version-hunting, but
still a review step before anything new reaches your server.

`metrics/` is the exception: it doesn't vendor one pinned external repo, it composes two
off-the-shelf tools (`mcp-proxy`, `supergateway`) installed straight from PyPI/npm in its
Dockerfile. It has no `UPSTREAM_REF` and `check-upstream.yml` has no job for it —
bumping those package versions (including the `mcp<2.0` pin, see its README) is a manual
edit to `metrics/Dockerfile.gateway` when needed. The same goes for the pinned
`supergateway` version (`SUPERGATEWAY_VERSION`) that every Dockerfile uses.

Every built image gets an immutable tag alongside `:latest`, so you can always roll back
to a specific build. Images publish to `ghcr.io/<your-github-user-or-org>/<this-repo>/<connector>`
automatically — nothing to edit, the workflows derive the path from the repo they run in.

**One-time setup:** in your repo's Settings → Actions → General → Workflow permissions,
check "Allow GitHub Actions to create and approve pull requests" — otherwise
`check-upstream.yml` won't be able to open its PRs.

## License

MIT — see [LICENSE](LICENSE).

---

<a id="polski"></a>
## Polski

*([English version above ↑](#mcp-connectors))*

Kontenery-gatewaye, które biorą istniejący serwer MCP — często dostępny tylko po stdio,
albo mówiący starszym transportem — i wystawiają go na zewnątrz jako uwierzytelniony
endpoint streamable-HTTP, żeby dało się go dodać jako custom connector w Claude albo w
dowolnym innym kliencie MCP, który mówi streamable-HTTP.

> **Ostrzeżenie o bezpieczeństwie (2026-10-05) — przeczytaj, zanim cokolwiek wystawisz.**
> Do tej daty każdy gateway w tym repo startował `supergateway` z
> `--oauth2Bearer "$MCP_BEARER_TOKEN"`. W supergateway 4.1.0 ta flaga tylko *dodaje*
> nagłówek `Authorization`; **nie** sprawdza nagłówka w żądaniach przychodzących, więc
> obrazy zbudowane przed 2026-10-05 odpowiadały `200` na żądanie bez tokenu. Wszystkie
> cztery moduły mają teraz przed `supergateway` małe proxy z uwierzytelnianiem
> ([`gateway/auth-proxy.js`](gateway/auth-proxy.js), testowane w CI przed każdym buildem).
> **Zbuduj, wdróż ponownie i sprawdź**: żądanie bez tokenu musi zwrócić `401` (zobacz
> [`gateway/README.md`](gateway/README.md#sprawdź-swój-deployment)). Jeśli skopiowałeś stary
> wzorzec, traktuj swoje bramki jako nieuwierzytelnione, dopóki tego nie zrobisz.

To repo wzięło się z podłączania agenta AI do jednego konkretnego domowego serwera, ale
nic tu nie jest do niego przywiązane. Każdy element — wzorzec gatewaya, wymuszanie trybu
tylko-do-odczytu, automatyzacja aktualizacji — działa tak samo na dowolnym hoście
Dockera, do którego go skierujesz.

### Zasada projektowa: blast radius

Każdy connector dostaje własny kontener, własny bearer token, własny wystawiony
hostname/ścieżkę i własną regułę dostępu tam, gdzie terminujesz TLS. Żaden connector nie
może zrobić więcej niż to, do czego został zbudowany, a ta granica jest wymuszana
**poniżej** samego serwera MCP, a nie przez zaufanie do flag serwera czy dobrego
zachowania modelu:

- proxy przed socketem/API, które twardo blokuje wywołania mutujące (`POST=0` na
  `docker-socket-proxy`, w przykładzie `docker/`),
- mount `:ro`, dzięki któremu serwer plikowy fizycznie nie ma na czym zapisać, nawet
  jeśli jego własny kod ma narzędzie do zapisu (przykład `files/`), albo
- poświadczenie, które potrafi tylko czytać, wystawione przez opakowywany system
  (przykład `unifi/`: lokalne konto tylko do podglądu na kontrolerze).

To defense in depth: nawet gdyby dany serwer MCP miał błąd, albo trafiła do niego
złośliwa zmiana w kodzie, warstwa niżej i tak by to zablokowała.

### Jak działa connector

```
MCP client (streamable-HTTP, bearer token)
   -> gateway container: supergateway (stdio -> streamable-HTTP, own bearer token)
       -> the wrapped MCP server (stdio)
```

Między klientem a `supergateway` stoi proxy z uwierzytelnianiem z
[`gateway/`](gateway/README.md): `supergateway` nie ma własnego uwierzytelniania żądań
przychodzących, więc to proxy sprawdza token.

Jeśli opakowywany serwer mówi tylko starym transportem SSE zamiast stdio, dochodzi jeden
dodatkowy hop — most łączący się z nim jako klient i wystawiający go z powrotem po
stdio, żeby `supergateway` miał co opakować (zobacz `metrics/` — działający przykład z
użyciem [`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy)):

```
MCP client (streamable-HTTP, bearer token)
   -> gateway container: supergateway (stdio -> streamable-HTTP, own bearer token)
       -> mcp-proxy (SSE client -> stdio)
           -> the wrapped MCP server (SSE transport)
```

Występują dwa niezależne sekrety, i nigdy nie są tym samym: bearer token, który klient
pokazuje gatewayowi, oraz (tylko tam gdzie to istotne) dane uwierzytelniające, których
sam gateway potrzebuje, żeby dostać się do opakowywanego serwera.

### Connectory w tym repo

W repo są cztery connectory, każdy opakowuje inny, prawdziwy serwer MCP. Pełne tabele
parametrów i przykłady docker-compose są w README każdego connectora. Wszystkie cztery
korzystają ze wspólnego frontu z uwierzytelnianiem w [`gateway/`](gateway/README.md).

| Connector | Folder | Opakowuje | Tryb tylko-do-odczytu wymuszony przez |
|---|---|---|---|
| docker | [`docker/`](docker/README.md) | [`ckreiling/mcp-server-docker`](https://github.com/ckreiling/mcp-server-docker), przypięty do commita | `docker-socket-proxy` przed nim (`POST=0`) |
| files | [`files/`](files/README.md) | oficjalny [`@modelcontextprotocol/server-filesystem`](https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem) | mounty `:ro` (świadomie zamieniane na `:rw` per folder, jeśli chcesz dostęp do zapisu) |
| metrics | [`metrics/`](metrics/README.md) | serwer MCP tylko-SSE (zbudowany i przetestowany na [Glances](https://nicolargo.github.io/glances/)) przez łańcuch `mcp-proxy` + `supergateway` | nie ma czego wymuszać — opakowywany serwer wystawia tylko zasoby (resources) i prompty do odczytu, zero narzędzi (tools) |
| unifi | [`unifi/`](unifi/README.md) | [`unifi-network-mcp`](https://pypi.org/project/unifi-network-mcp/) z PyPI, przypięty do wersji, po stdio | lokalne konto tylko do podglądu na kontrolerze UniFi, a własne bramki `UNIFI_POLICY_NETWORK_*` serwera jako druga linia |

`metrics/` jest wyjątkiem celowo: nie opakowuje jednego przypiętego upstreamu jak
pozostałe trzy, tylko składa dwa niezależnie wersjonowane, gotowe narzędzia. Zobacz jego
README, dlaczego oznacza to brak `UPSTREAM_REF` i brak joba auto-bumpującego.

### Wystawianie kontenera gatewaya

Każdy gateway nasłuchuje na porcie 8000 wewnątrz kontenera i wymaga
`Authorization: Bearer <token>` (sprawdza to [`gateway/auth-proxy.js`](gateway/auth-proxy.js)).
Doprowadzenie ruchu HTTPS do tego portu jest poza zakresem tego repo — postaw go za
dowolnym reverse proxy albo tunelem, którego już używasz: Cloudflare Tunnel, Tailscale
Funnel/Serve, nginx + Let's Encrypt, Caddy, cokolwiek, co potrafi terminować TLS i
przekazać ruch do kontenera. Skieruj swojego klienta MCP na `https://<twój-host>/mcp` z
tym nagłówkiem.

Jeśli używasz Cloudflare Tunnel, [`docs/exposing-with-cloudflare-tunnel.md`](docs/exposing-with-cloudflare-tunnel.md)
prowadzi przez jeden konkretny setup, razem z dwiema pułapkami, o których warto wiedzieć
z góry: kolejnością operatorów w wyrażeniach reguł Cloudflare i prawdziwym bugiem w
Glances, który psuje każdy deployment za reverse proxy na domyślnym porcie HTTPS.

### Pół-automatyczne aktualizacje upstreamu

Connectory, które opakowują cudzy kod (`ckreiling/mcp-server-docker`, oficjalny
`@modelcontextprotocol/server-filesystem`, `unifi-network-mcp` z PyPI), przypinają
budowaną wersję w pliku `UPSTREAM_REF` w swoim folderze, zamiast śledzić `main`/`latest`
na żywo. Ta wersja zmienia się tylko przez świadomy, przejrzany merge.

`check-upstream.yml` odpala się co tydzień, sprawdza czy upstream ma coś nowszego, i
jeśli tak — sam otwiera Pull Requesta z bumpem `UPSTREAM_REF`. Nic się nie buduje ani nie
publikuje automatycznie — dopiero zmergowanie tego PR-a (świadoma decyzja) odpala
właściwy build i aktualizuje `:latest`. To kompromis: zero ręcznego szukania nowych
wersji, ale zawsze jest moment przeglądu, zanim coś nowego trafi na twój serwer.

`metrics/` jest wyjątkiem: nie opakowuje jednego przypiętego, zewnętrznego repo, tylko
składa dwa gotowe narzędzia (`mcp-proxy`, `supergateway`) instalowane wprost z PyPI/npm w
Dockerfile. Nie ma tu `UPSTREAM_REF`, a `check-upstream.yml` nie ma dla niego joba —
aktualizacja wersji tych pakietów (w tym pin `mcp<2.0`, zobacz jego README) to ręczna
edycja `metrics/Dockerfile.gateway`, gdy zajdzie potrzeba. To samo dotyczy przypiętej
wersji `supergateway` (`SUPERGATEWAY_VERSION`), której używają wszystkie Dockerfile.

Każdy zbudowany obraz dostaje, obok `:latest`, własny niezmienny tag, więc zawsze można
wrócić do konkretnego builda. Obrazy publikują się pod
`ghcr.io/<twój-użytkownik-lub-organizacja-github>/<to-repo>/<connector>` automatycznie —
nic do edycji, workflowy same wyliczają ścieżkę z repo, w którym się odpalają.

**Wymaga jednorazowo:** w ustawieniach swojego repo, Settings → Actions → General →
Workflow permissions, zaznacz "Allow GitHub Actions to create and approve pull
requests" — inaczej `check-upstream.yml` nie będzie mógł otwierać swoich PR-ów.

### Licencja

MIT — patrz [LICENSE](LICENSE).
