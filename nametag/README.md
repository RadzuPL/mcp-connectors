# nametag connector

*([Polska wersja poniżej ↓](#polski))*

A small MCP server for [Nametag](https://github.com/mattogodoy/nametag), the self-hosted
personal relationships manager (people, groups as tags, notes, relationships, journal),
behind the same authenticating front end as the other connectors
([`../gateway/`](../gateway/README.md)). It talks to Nametag's REST API with an API token and
answers with short plain text instead of raw API objects, to keep the context small.

**Read-only by default.** Write tools exist but are not even advertised until you set
`NAMETAG_ENABLE_WRITE=true`.

## Tools

Always available:

| Tool | Returns |
|---|---|
| `find_people` | `id \| name \| nickname` lines. Args: `q` (names and nicknames, accent-insensitive: `lukasz` finds `Łukasz`), `deep` (also searches notes, groups and custom fields, with a snippet), `group` (name or id), `limit` (default 30, max 100), `offset` |
| `get_person` | one person in full: names, nickname, groups, custom fields, contact data, dates, relations (with the relationship type), notes |
| `catalog` | existing groups, relationship types and custom field templates, with ids |
| `journal` | journal entries, newest first. Args: `person`, `q`, `page` |

Only with `NAMETAG_ENABLE_WRITE=true`:

| Tool | Does |
|---|---|
| `add_person` | creates a person; groups and custom fields by name; refuses a name that already exists unless `allow_duplicate=true` |
| `update_person` | changes only the fields you pass; `add_nickname` adds an alias, `append_notes` appends to the notes, `custom_fields` sets only the named fields |
| `tag_people` | adds up to 100 people to groups (RPG, LARP, ...); only adds, never removes |
| `create_group` | creates a group (a tag), refuses an existing name |
| `link_people` | connects two people, optionally with a relationship type (Nametag adds the inverse itself) |
| `add_journal` | adds a journal entry, optionally tagging people |

Not included on purpose: deleting anything, merging people, import/export, accounts and
tokens, and removing people from groups. Nametag's own soft delete (30 days) is not
reachable from here.

## Things the server handles for you

These come from reading Nametag's source and are the reason `update_person` is not a thin
pass-through:

- **Custom fields are replaced as a whole** by Nametag on every update (fields not sent are
  deleted). The server reads the current values, merges yours in and sends the full list, so
  setting one field never wipes the others. Values are validated first (select options,
  numbers, true/false, no empty values).
- **Group membership** is added through Nametag's additive bulk action, never through the
  person update, which would replace the whole set.
- **Nickname is one field, max 100 chars.** Several aliases are kept comma separated
  (`add_nickname` appends one and refuses to go past the limit).
- **Notes** are Markdown, max 10000 chars. `append_notes` refuses to overflow and points to
  `add_journal` instead.
- **Where do you know them from?** Nametag has no such built-in field. Use a custom field
  (for example a text field `Skąd znam`, created under *Settings > Custom Fields* in Nametag),
  groups for contexts (a group per convention or campaign), `met_through` for "introduced by",
  or the notes.

## Architecture and security

```
MCP client (streamable-HTTP, bearer token)
   -> nametag connector container (token check + supergateway, stdio -> streamable-HTTP)
       -> NAMETAG_URL/api   (Nametag API token, READ or READ_WRITE)
```

Two independent secrets: the bearer token that clients present to the gateway, and the
Nametag API token that only this container knows. The Nametag token is only ever sent to
`NAMETAG_URL` and is never written to any output or error.

The limit that matters is enforced **below** the MCP server, in Nametag itself: create the
API token with scope **READ** and a compromised connector cannot write, whatever the code
does. Use a **READ_WRITE** token only together with `NAMETAG_ENABLE_WRITE=true`.

Privacy: supergateway logs the whole JSON-RPC traffic of its container, so the people you
look up end up in that container's logs. Keep the logs local, and read them with a small
`tail` or `grep`. This connector gives whatever is connected to it access to everything in
your Nametag; keep the client list short and the tunnel locked down (see
[`../docs/exposing-with-cloudflare-tunnel.md`](../docs/exposing-with-cloudflare-tunnel.md)).

## Configuration

| Variable | Required | Example | Notes |
|---|---|---|---|
| `NAMETAG_URL` | yes | `http://nametag:3000` or `http://192.168.10.15:3033` | where *this container* can reach Nametag. Same Docker network: container name and **internal** port (`http://nametag:3000`). Different networks (the usual case when the connector sits next to the tunnel): host IP and the **published** port (`http://<host-ip>:3033`) |
| `NAMETAG_API_TOKEN_FILE` | yes (or `NAMETAG_API_TOKEN`) | `/run/secrets/nametag_api_token` | the `ntag_...` token from Nametag |
| `NAMETAG_ENABLE_WRITE` | no | `true` | default off. Needs a READ_WRITE token |
| `MCP_BEARER_TOKEN_FILE` | yes (or `MCP_BEARER_TOKEN`) | `/run/secrets/mcp_bearer_token` | see the [gateway README](../gateway/README.md#token) |

Image: `ghcr.io/<owner>/mcp-connectors/nametag:latest`, built by
[`build-nametag.yml`](../.github/workflows/build-nametag.yml). Port 8000, path `/mcp`.
`GATEWAY_STATEFUL` is not needed (plain Node, starts in milliseconds).

## Setup

1. In Nametag open *Settings > API Tokens* and create a token. Scope **READ** for the
   read-only connector. Copy it once, it is not shown again.
2. Put the token into a file on the host, for example `/mnt/user/appdata/mcp/secrets/nametag_api_token`
   (just the `ntag_...` text) and mount it read-only into the container at
   `/run/secrets/nametag_api_token`. Do the same for the gateway bearer token.
3. Make the `nametag` package public in the GitHub package settings if the host pulls
   without credentials (packages published by Actions start out private).
4. Run the container with the variables above, in **the same Docker network as the
   tunnel's `cloudflared`** (the tunnel reaches it by container name on port 8000; no
   published port needed). If Nametag lives in another network, do not try to join both:
   point `NAMETAG_URL` at the host IP and Nametag's published port (for example
   `http://192.168.10.15:3033`). The connector only needs to reach Nametag over HTTP.
5. Add the hostname to the tunnel (service `http://<container-name>:8000`) and to the WAF
   rules as for the other connectors, then add the connector in the MCP client.

On Unraid, add the container through *Docker > Add Container*: repository
`ghcr.io/<owner>/mcp-connectors/nametag:latest`, the network of the tunnel, extra
parameter `--restart unless-stopped`, the four variables from the table above and two
read-only path mappings (the bearer token file to `/run/secrets/mcp_bearer_token`, the
Nametag token file to `/run/secrets/nametag_api_token`).

## Verify

Without a token the gateway must answer `401`; with it, `catalog` must list your groups.
Run from the Docker host, in the network the container is on (replace network, container
name and the path of the bearer token file):

```
docker run --rm --network mcp_network curlimages/curl -i -X POST http://mcp-nametag-connector:8000/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

```
docker run --rm --network mcp_network curlimages/curl -i -X POST http://mcp-nametag-connector:8000/mcp -H "Authorization: Bearer $(cat /mnt/user/appdata/mcp-nametag/bearer_token)" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"catalog","arguments":{}}}'
```

The first must return `401`, the second `200` with your groups. A reply
starting with `cannot reach Nametag at ...` points at `NAMETAG_URL` (wrong network or port);
`Nametag rejected the API token (401)` points at the token file.

## Tests

```
node nametag/test-server.js
```

Runs the server against a fake Nametag API (also in CI before the image is built). The
response shapes are taken from Nametag's OpenAPI document and source (0.63/0.64). Only
`catalog` has been checked against a live Nametag (0.64.1); the other tools were checked
against the OpenAPI document, the source and the fake API. If a newer Nametag changes the
shapes, `get_person` and `find_people` are the first places to look.

---

<a id="polski"></a>
## Polski

*([English version above ↑](#nametag-connector))*

Mały serwer MCP dla [Nametag](https://github.com/mattogodoy/nametag), samohostowanego
menedżera relacji (ludzie, grupy jako tagi, notatki, powiązania, dziennik), za tym samym
frontem z tokenem co pozostałe konektory ([`../gateway/`](../gateway/README.md)). Rozmawia z
REST API Nametaga przez token API i odpowiada krótkim tekstem zamiast surowych obiektów,
żeby kontekst był mały.

**Domyślnie tylko do odczytu.** Narzędzia zapisu istnieją, ale nie są nawet ogłaszane,
dopóki nie ustawisz `NAMETAG_ENABLE_WRITE=true`.

### Narzędzia

Zawsze dostępne:

| Narzędzie | Zwraca |
|---|---|
| `find_people` | linie `id \| imię \| ksywa`. Argumenty: `q` (imiona i ksywy, bez względu na ogonki: `lukasz` znajdzie `Łukasz`), `deep` (szuka też w notatkach, grupach i polach własnych, z wycinkiem), `group` (nazwa lub id), `limit` (domyślnie 30, max 100), `offset` |
| `get_person` | jedna osoba w całości: imiona, ksywa, grupy, pola własne, kontakt, daty, powiązania (z typem relacji), notatki |
| `catalog` | istniejące grupy, typy relacji i szablony pól własnych, z id |
| `journal` | wpisy dziennika od najnowszych. Argumenty: `person`, `q`, `page` |

Tylko z `NAMETAG_ENABLE_WRITE=true`:

| Narzędzie | Robi |
|---|---|
| `add_person` | tworzy osobę; grupy i pola własne po nazwie; odmawia, jeśli taka osoba już istnieje (chyba że `allow_duplicate=true`) |
| `update_person` | zmienia tylko podane pola; `add_nickname` dopisuje ksywę, `append_notes` dopisuje do notatek, `custom_fields` ustawia tylko wskazane pola |
| `tag_people` | dodaje do 100 osób do grup (RPG, LARP, ...); tylko dodaje, nigdy nie usuwa |
| `create_group` | tworzy grupę (tag), odmawia istniejącej nazwy |
| `link_people` | łączy dwie osoby, opcjonalnie typem relacji (odwrotną stronę dodaje sam Nametag) |
| `add_journal` | dodaje wpis do dziennika, opcjonalnie z osobami |

Celowo brak: usuwania czegokolwiek, scalania osób, importu/eksportu, kont i tokenów oraz
wyjmowania osób z grup. Miękkie usuwanie Nametaga (30 dni) nie jest stąd dostępne.

### Co serwer robi za Ciebie

To wynik czytania źródeł Nametaga i powód, dla którego `update_person` nie jest cienką
przelotką:

- **Pola własne Nametag nadpisuje w całości** przy każdej aktualizacji (niewysłane pola są
  kasowane). Serwer czyta obecne wartości, dokłada Twoje i wysyła pełną listę, więc ustawienie
  jednego pola nie wymazuje pozostałych. Wartości są wcześniej walidowane (opcje select,
  liczby, true/false, brak pustych wartości).
- **Członkostwo w grupach** jest dodawane przez addytywną akcję zbiorczą Nametaga, nigdy
  przez aktualizację osoby, która podmieniłaby cały zestaw.
- **Ksywa to jedno pole, max 100 znaków.** Kilka aliasów trzymane jest po przecinku
  (`add_nickname` dopisuje jeden i odmawia przekroczenia limitu).
- **Notatki** to Markdown, max 10000 znaków. `append_notes` nie pozwoli przepełnić i
  wskaże `add_journal`.
- **Skąd znam?** Nametag nie ma takiego wbudowanego pola. Użyj pola własnego (np. tekstowego
  `Skąd znam`, tworzonego w Nametagu w *Settings > Custom Fields*), grup jako kontekstów
  (grupa na konwent albo kampanię), `met_through` dla „poznany przez”, albo notatek.

### Architektura i bezpieczeństwo

```
MCP client (streamable-HTTP, bearer token)
   -> kontener konektora nametag (sprawdzenie tokenu + supergateway, stdio -> streamable-HTTP)
       -> NAMETAG_URL/api   (token API Nametaga, READ albo READ_WRITE)
```

Dwa niezależne sekrety: token bearer, który klienci pokazują bramce, i token API Nametaga,
który zna tylko ten kontener. Token Nametaga jest wysyłany wyłącznie na `NAMETAG_URL` i
nigdy nie trafia do żadnego wyniku ani błędu.

Ograniczenie, które się liczy, jest wymuszone **poniżej** serwera MCP, w samym Nametagu:
utwórz token API z zakresem **READ**, a przejęty konektor nie zapisze niczego, niezależnie
od kodu. Token **READ_WRITE** używaj tylko razem z `NAMETAG_ENABLE_WRITE=true`.

Prywatność: supergateway zapisuje w logach kontenera cały ruch JSON-RPC, więc osoby, które
wyszukujesz, lądują w logach tego kontenera. Trzymaj logi lokalnie i czytaj je małym `tail`
albo `grep`. Konektor daje wszystkiemu, co się z nim łączy, dostęp do całego Twojego
Nametaga; trzymaj listę klientów krótką, a tunel zamknięty (zobacz
[`../docs/exposing-with-cloudflare-tunnel.md`](../docs/exposing-with-cloudflare-tunnel.md)).

### Konfiguracja

| Zmienna | Wymagana | Przykład | Uwagi |
|---|---|---|---|
| `NAMETAG_URL` | tak | `http://nametag:3000` albo `http://192.168.10.15:3033` | adres, pod którym *ten kontener* widzi Nametaga. Ta sama sieć Dockera: nazwa kontenera i **wewnętrzny** port (`http://nametag:3000`). Różne sieci (typowo, gdy konektor stoi obok tunelu): IP hosta i port **opublikowany** (`http://<ip-hosta>:3033`) |
| `NAMETAG_API_TOKEN_FILE` | tak (albo `NAMETAG_API_TOKEN`) | `/run/secrets/nametag_api_token` | token `ntag_...` z Nametaga |
| `NAMETAG_ENABLE_WRITE` | nie | `true` | domyślnie wyłączone. Wymaga tokenu READ_WRITE |
| `MCP_BEARER_TOKEN_FILE` | tak (albo `MCP_BEARER_TOKEN`) | `/run/secrets/mcp_bearer_token` | zobacz [README bramki](../gateway/README.md#token) |

Obraz: `ghcr.io/<owner>/mcp-connectors/nametag:latest`, budowany przez
[`build-nametag.yml`](../.github/workflows/build-nametag.yml). Port 8000, ścieżka `/mcp`.
`GATEWAY_STATEFUL` nie jest potrzebne (zwykły Node, startuje w milisekundach).

### Uruchomienie

1. W Nametagu wejdź w *Settings > API Tokens* i utwórz token. Zakres **READ** dla konektora
   tylko do odczytu. Skopiuj go od razu, drugi raz się nie pokaże.
2. Wpisz token do pliku na hoście, np. `/mnt/user/appdata/mcp/secrets/nametag_api_token`
   (sam tekst `ntag_...`) i zamontuj go tylko do odczytu w kontenerze jako
   `/run/secrets/nametag_api_token`. To samo zrób z tokenem bearer bramki.
3. Ustaw pakiet `nametag` jako publiczny w ustawieniach pakietów GitHuba, jeśli host pobiera
   obrazy bez poświadczeń (pakiety publikowane przez Actions zaczynają jako prywatne).
4. Uruchom kontener z powyższymi zmiennymi w **tej samej sieci Dockera co `cloudflared`
   tunelu** (tunel dociera do niego po nazwie kontenera na porcie 8000; opublikowany port
   niepotrzebny). Jeśli Nametag stoi w innej sieci, nie łącz kontenera z obiema: ustaw
   `NAMETAG_URL` na IP hosta i opublikowany port Nametaga (np. `http://192.168.10.15:3033`).
   Konektor potrzebuje tylko dostępu do Nametaga po HTTP.
5. Dodaj hostname do tunelu (usługa `http://<nazwa-kontenera>:8000`) i do reguł WAF jak przy
   pozostałych konektorach, potem dodaj konektor w kliencie MCP.

Na Unraidzie kontener dodajesz przez *Docker > Add Container*: repozytorium
`ghcr.io/<owner>/mcp-connectors/nametag:latest`, sieć tunelu, dodatkowy parametr
`--restart unless-stopped`, cztery zmienne z tabeli powyżej i dwa mapowania ścieżek tylko do
odczytu (plik z tokenem bearer do `/run/secrets/mcp_bearer_token`, plik z tokenem Nametaga do
`/run/secrets/nametag_api_token`).

### Weryfikacja

Bez tokenu bramka musi odpowiedzieć `401`; z tokenem `catalog` musi wypisać Twoje grupy.
Uruchom na hoście Dockera, w sieci kontenera (podmień sieć, nazwę kontenera i ścieżkę pliku z
tokenem bearer):

```
docker run --rm --network mcp_network curlimages/curl -i -X POST http://mcp-nametag-connector:8000/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

```
docker run --rm --network mcp_network curlimages/curl -i -X POST http://mcp-nametag-connector:8000/mcp -H "Authorization: Bearer $(cat /mnt/user/appdata/mcp-nametag/bearer_token)" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"catalog","arguments":{}}}'
```

Pierwsze musi zwrócić `401`, drugie `200` z Twoimi grupami. Odpowiedź zaczynająca się od
`cannot reach Nametag at ...` wskazuje na `NAMETAG_URL` (zła sieć albo port);
`Nametag rejected the API token (401)` wskazuje na plik z tokenem.

### Testy

```
node nametag/test-server.js
```

Uruchamia serwer na fałszywym API Nametaga (w CI także przed zbudowaniem obrazu). Kształty
odpowiedzi pochodzą z dokumentu OpenAPI i źródeł Nametaga (0.63/0.64). Na żywym Nametagu
(0.64.1) sprawdzono dotąd tylko `catalog`; pozostałe narzędzia sprawdzono względem dokumentu
OpenAPI, źródeł i fałszywego API. Jeśli nowsza wersja zmieni kształty, pierwsze do
sprawdzenia są `get_person` i `find_people`.
