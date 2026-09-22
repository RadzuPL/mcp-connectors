# martinez-mcp-connectors

MCP connectory łączące Claude z moim domowym serwerem Unraid ("Martinez"),
budowane pod jedną zasadą: **każdy connector ma osobny blast radius**.
Osobny token, osobny kontener, osobny publiczny hostname, osobna reguła
dostępu. Żaden nie może zrobić więcej niż to, do czego został pomyślany -
i to jest wymuszane niżej niż na poziomie samego serwera MCP (patrz
"Dlaczego docker-socket-proxy / :ro mounty" niżej).

## Connectory

| Connector | Folder | Obraz | Co robi | Zakres |
|---|---|---|---|---|
| `mcp-docker-connector` | [`docker/`](docker/) | `ghcr.io/radzupl/mcp-connectors/docker` | Odczyt stanu kontenerów, obrazów, logów przez Docker API | tylko odczyt (wymuszone przez docker-socket-proxy przed nim, nie przez sam serwer MCP) |
| `mcp-files-connector` | [`files/`](files/) | `ghcr.io/radzupl/mcp-connectors/files` | Odczyt plików z wybranych folderów na serwerze | tylko odczyt (wymuszone przez `:ro` bind mounty), zakres folderów rośnie w miarę potrzeb |
| `mcp-metrics-connector` | *(planowany)* | `ghcr.io/radzupl/mcp-connectors/metrics` *(planowany)* | CPU/RAM/GPU telemetry (Glances + nvidia-status) | tylko odczyt, czysta telemetria, bez akcji |

Każdy connector jest wystawiony pod osobną subdomeną przez jeden tunel
Cloudflare (`cloudflared-mcp`), z osobnym tokenem bearer i osobnym
connectorem skonfigurowanym w Claude. Żaden token nie działa na drugim
connectorze.

## Dlaczego docker-socket-proxy / :ro mounty

Żaden z tych serwerów MCP nie ma wbudowanego, wymuszalnego trybu
"tylko odczyt" - to zwykle flaga aplikacyjna, którą można obejść albo
która po prostu nie istnieje dla wszystkich operacji. Dlatego odczyt
wymuszamy warstwę niżej, tam gdzie sam serwer MCP nie ma już nic do
powiedzenia:

- **Docker** - `docker-socket-proxy` (tecnativa) stoi między connectorem
  a `docker.sock`. `POST=0` blokuje wszystkie operacje mutujące,
  niezależnie od tego jakie flagi zasobów są włączone. Nawet gdyby
  connector chciał coś utworzyć albo skasować, proxy odpowie 403 zanim
  to dotrze do prawdziwego Dockera.
- **Pliki** - foldery są montowane do kontenera z flagą `:ro` na poziomie
  Dockera. Serwer plikowy ma narzędzia do zapisu i kasowania w swoim
  kodzie, ale fizycznie nie ma jak zapisać na mouncie tylko-do-odczytu.

To jest defense in depth: nawet gdyby sam serwer MCP miał błąd albo
złośliwą zmianę w kodzie, warstwa niżej i tak by to zablokowała.

## Aktualizacje upstreamu - pół-auto

Każdy connector opakowuje cudzy kod (ckreiling/mcp-server-docker,
oficjalny `@modelcontextprotocol/server-filesystem`). Zamiast śledzić
`main`/`latest` na żywo, wersja jest przypięta w pliku `UPSTREAM_REF`
w folderze danego connectora - i zmienia się tylko przez świadomy,
przejrzany merge.

`check-upstream.yml` co tydzień sprawdza czy upstream ma coś nowego i
jeśli tak, sam otwiera Pull Requesta z bumpem `UPSTREAM_REF`. Nic się nie
buduje ani nie publikuje automatycznie - dopiero merge tego PR-a (czyli
świadoma decyzja) odpala właściwy build i aktualizuje `:latest`. To
kompromis: zero ręcznego szukania nowych wersji, ale zawsze jest moment
przeglądu zanim coś nowego trafi na serwer.

Każdy zbudowany obraz dostaje, oprócz `:latest`, własny niezmienny tag
(`data-skrócony_ref`), więc da się w każdej chwili wrócić do konkretnego
builda.

**Wymaga jednorazowo:** w ustawieniach repo, Settings → Actions →
General → Workflow permissions, zaznaczyć "Allow GitHub Actions to
create and approve pull requests" - inaczej `check-upstream.yml` nie
będzie mógł otworzyć PR-a.

## Dodawanie nowego connectora

1. Nowy folder na poziomie repo (np. `metrics/`).
2. `Dockerfile.gateway` w tym folderze + `UPSTREAM_REF` jeśli opakowuje
   cudzy kod.
3. `.github/workflows/build-<nazwa>.yml`, trigger na paths ograniczony
   do plików tego folderu (żeby nie odpalał się przy zmianach w innych
   connectorach).
4. Jeśli ma śledzić upstream, dopisać drugi job do `check-upstream.yml`.
5. Nowa subdomena, nowa reguła Cloudflare (albo dopisanie `or
   http.host eq "..."` do istniejącej), nowy connector w Claude z
   własnym tokenem.

## Licencja

MIT - patrz [LICENSE](LICENSE).
