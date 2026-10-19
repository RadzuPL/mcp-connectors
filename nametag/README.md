# nametag connector

*([Polska wersja poniżej ↓](#polski))*

A small MCP server for [Nametag](https://github.com/mattogodoy/nametag), the self-hosted
personal relationships manager (people, groups as tags, notes, relationships, journal),
behind the same authenticating front end as the other connectors
([`../gateway/`](../gateway/README.md)). It talks to Nametag's REST API with an API token and
answers with short plain text instead of raw API objects, to keep the context small.

**Read-only by default.** Write tools exist but are not even advertised until you set
`NAMETAG_ENABLE_WRITE=true`. Deleting a person and merging people need a second switch,
`NAMETAG_ENABLE_DESTRUCTIVE=true`, on top of that.

## Tools

Always available:

| Tool | Returns |
|---|---|
| `find_people` | `id \| name \| nickname \| relation \| groups` lines. Args: `q` (names and nicknames, accent-insensitive: `lukasz` finds `Łukasz`), `deep` (also searches notes, groups and custom fields, with a snippet), `group` / `groups` (names or ids; any of them, or all with `all_groups=true`), `relationship` (only people with that relation to you, e.g. `Nie znam`), `limit` (default 30, max 100), `offset` |
| `get_person` | one person in full: names, nickname, groups, custom fields, contact data, dates, relations (with the relationship type), notes |
| `catalog` | existing groups, relationship types and custom field templates, with ids |
| `journal` | journal entries, newest first, tagged people as `name [id]`. Args: `person`, `q`, `page` |
| `trash` | deleted people and groups still in Nametag's trash (kept 30 days), with ids and days left. Arg: `type` (`person` or `group`, default both) |

Only with `NAMETAG_ENABLE_WRITE=true`:

| Tool | Does |
|---|---|
| `add_person` | creates a person; `relationship` (your relation to them) is required; groups and custom fields by name; `met_through` needs `met_through_type`; refuses a name that already exists unless `allow_duplicate=true` |
| `update_person` | changes only the fields you pass: `add_nickname`, `append_notes`, `custom_fields`, `relationship` (your relation), `last_contact` (`YYYY-MM-DD`, empty clears), `add_phones` / `add_emails` / `add_urls`, `remove_contact`, `add_dates` / `remove_dates` |
| `tag_people` / `untag_people` | add up to 100 people to groups (RPG, LARP, ...) / remove them from groups; people and groups stay |
| `set_relationship` | sets your relationship type (Poznany, Znajomy, ...) for up to 100 people at once |
| `create_group` / `update_group` / `delete_group` | create, rename / change description or color, delete a group. Deleting removes the tag only, never its members |
| `restore` | brings a deleted person or group back from the trash, by id or exact name (see `trash`) |
| `link_people` / `update_link` / `unlink_people` | connect two people with a relationship type (required), change the type or notes of a link, remove a link (the inverse follows) |
| `create_relationship_type` / `create_custom_field` | new relationship type (`symmetric`, `inverse_label` or `inverse`), new custom field template (TEXT, NUMBER, BOOLEAN, SELECT) |
| `add_journal` / `update_journal` / `delete_journal` | add an entry, edit title / body / date / tagged people, delete an entry. Last contact dates are touched only when asked |

Only with `NAMETAG_ENABLE_WRITE=true` **and** `NAMETAG_ENABLE_DESTRUCTIVE=true`:

| Tool | Does |
|---|---|
| `delete_person` | deletes one person (Nametag keeps it 30 days). Never deletes anyone else, never touches CardDAV |
| `merge_people` | merges a duplicate into the person you keep; aliases and notes are combined, the later last contact date wins |

Deleted people and groups can be brought back with `restore` for 30 days. Not included on purpose: permanent deletion (every `/permanent` route is blocked in the
request layer), bulk deletion, import/export, accounts and tokens. Deleted journal entries
cannot be restored by Nametag; `delete_journal` returns the whole entry so it can be re-added
with `add_journal`.

## Things the server handles for you

These come from reading Nametag's source and are the reason `update_person` is not a thin
pass-through:

- **Custom fields are replaced as a whole** by Nametag on every update (fields not sent are
  deleted). The server reads the current values, merges yours in and sends the full list, so
  setting one field never wipes the others. Values are validated first (select options,
  numbers, true/false, no empty values).
- **Group membership** is added through Nametag's additive bulk action and removed one
  membership at a time, never through the person update, which would replace the whole set.
- **Contact lists** (phones, emails, URLs) are replaced as a whole too, so the server reads
  the current ones, merges your change in and sends only the lists that changed. Important
  dates use Nametag's own add / delete routes.
- **Group and journal edits** need the full object on Nametag's side (a missing description
  or a missing list of tagged people is wiped). The server reads the current state and sends
  it back with your change.
- **Your relation to a person** is its own field. Creating a person with `connectedThroughId`
  makes Nametag drop that relation, so `met_through` is done as a separate typed link after
  the person exists (a failure there is reported as a warning, the person stays).
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
| `NAMETAG_ENABLE_DESTRUCTIVE` | no | `true` | default off. Only has an effect together with `NAMETAG_ENABLE_WRITE`; unlocks `delete_person` and `merge_people` |
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
parameter `--restart unless-stopped`, the variables from the table above and two
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
fake reproduces the Nametag behaviours the server works around (replace-on-update, required
relationship type, wiped description). The response shapes are taken from Nametag's OpenAPI
document and source (0.63/0.64). Only `catalog` and the read tools have been checked against a
live Nametag (0.64.1); the write tools were checked against the source and the fake API, so
test them on a throwaway person first. If a newer Nametag changes the
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
dopóki nie ustawisz `NAMETAG_ENABLE_WRITE=true`. Usuwanie osoby i scalanie osób wymaga
dodatkowo drugiego przełącznika, `NAMETAG_ENABLE_DESTRUCTIVE=true`.

### Narzędzia

Zawsze dostępne:

| Narzędzie | Zwraca |
|---|---|
| `find_people` | linie `id \| imię \| ksywa \| relacja \| grupy`. Argumenty: `q` (imiona i ksywy, bez względu na ogonki: `lukasz` znajdzie `Łukasz`), `deep` (szuka też w notatkach, grupach i polach własnych, z wycinkiem), `group` / `groups` (nazwy lub id; dowolna z nich, albo wszystkie z `all_groups=true`), `relationship` (tylko osoby z taką relacją do Ciebie, np. `Nie znam`), `limit` (domyślnie 30, max 100), `offset` |
| `get_person` | jedna osoba w całości: imiona, ksywa, grupy, pola własne, kontakt, daty, powiązania (z typem relacji), notatki |
| `catalog` | istniejące grupy, typy relacji i szablony pól własnych, z id |
| `journal` | wpisy dziennika od najnowszych, oznaczone osoby jako `imię [id]`. Argumenty: `person`, `q`, `page` |
| `trash` | usunięte osoby i grupy, które są jeszcze w koszu Nametaga (30 dni), z id i liczbą dni do skasowania. Argument: `type` (`person` albo `group`, domyślnie obie) |

Tylko z `NAMETAG_ENABLE_WRITE=true`:

| Narzędzie | Robi |
|---|---|
| `add_person` | tworzy osobę; `relationship` (Twoja relacja do niej) jest wymagana; grupy i pola własne po nazwie; `met_through` wymaga `met_through_type`; odmawia, jeśli taka osoba już istnieje (chyba że `allow_duplicate=true`) |
| `update_person` | zmienia tylko podane pola: `add_nickname`, `append_notes`, `custom_fields`, `relationship` (Twoja relacja), `last_contact` (`YYYY-MM-DD`, puste czyści), `add_phones` / `add_emails` / `add_urls`, `remove_contact`, `add_dates` / `remove_dates` |
| `tag_people` / `untag_people` | dodaje do 100 osób do grup (RPG, LARP, ...) / wyjmuje je z grup; osoby i grupy zostają |
| `set_relationship` | ustawia Twój typ relacji (Poznany, Znajomy, ...) do 100 osobom naraz |
| `create_group` / `update_group` / `delete_group` | tworzy, zmienia nazwę / opis / kolor, usuwa grupę. Usunięcie kasuje sam tag, nigdy jej członków |
| `restore` | przywraca usuniętą osobę lub grupę z kosza, po id albo dokładnej nazwie (zobacz `trash`) |
| `link_people` / `update_link` / `unlink_people` | łączy dwie osoby typem relacji (wymagany), zmienia typ albo notatkę powiązania, usuwa powiązanie (odwrotna strona idzie razem) |
| `create_relationship_type` / `create_custom_field` | nowy typ relacji (`symmetric`, `inverse_label` albo `inverse`), nowy szablon pola własnego (TEXT, NUMBER, BOOLEAN, SELECT) |
| `add_journal` / `update_journal` / `delete_journal` | dodaje wpis, edytuje tytuł / treść / datę / oznaczone osoby, usuwa wpis. Daty ostatniego kontaktu zmieniane są tylko na prośbę |

Tylko z `NAMETAG_ENABLE_WRITE=true` **i** `NAMETAG_ENABLE_DESTRUCTIVE=true`:

| Narzędzie | Robi |
|---|---|
| `delete_person` | usuwa jedną osobę (Nametag trzyma ją 30 dni). Nigdy nie usuwa nikogo innego i nie rusza CardDAV |
| `merge_people` | scala duplikat z osobą, którą zostawiasz; ksywy i notatki są łączone, wygrywa późniejsza data ostatniego kontaktu |

Usuniętą osobę lub grupę można przez 30 dni przywrócić przez `restore`. Celowo brak: trwałego usuwania (każda ścieżka `/permanent` jest blokowana w warstwie
zapytań), usuwania zbiorczego, importu/eksportu, kont i tokenów. Nametag nie potrafi
przywrócić usuniętego wpisu dziennika; `delete_journal` zwraca cały wpis, żeby dało się go
dodać z powrotem przez `add_journal`.

### Co serwer robi za Ciebie

To wynik czytania źródeł Nametaga i powód, dla którego `update_person` nie jest cienką
przelotką:

- **Pola własne Nametag nadpisuje w całości** przy każdej aktualizacji (niewysłane pola są
  kasowane). Serwer czyta obecne wartości, dokłada Twoje i wysyła pełną listę, więc ustawienie
  jednego pola nie wymazuje pozostałych. Wartości są wcześniej walidowane (opcje select,
  liczby, true/false, brak pustych wartości).
- **Członkostwo w grupach** jest dodawane przez addytywną akcję zbiorczą Nametaga, a
  usuwane pojedynczo, nigdy przez aktualizację osoby, która podmieniłaby cały zestaw.
- **Listy kontaktowe** (telefony, maile, adresy URL) Nametag też podmienia w całości, więc
  serwer czyta obecne, dokłada Twoją zmianę i wysyła tylko zmienione listy. Ważne daty idą
  przez własne ścieżki Nametaga (dodaj / usuń).
- **Edycja grupy i wpisu dziennika** wymaga po stronie Nametaga pełnego obiektu (brak opisu
  albo brak listy oznaczonych osób to ich skasowanie). Serwer czyta obecny stan i odsyła go
  razem z Twoją zmianą.
- **Twoja relacja do osoby** to osobne pole. Utworzenie osoby z `connectedThroughId` każe
  Nametagowi tę relację porzucić, więc `met_through` jest robione jako osobne, otypowane
  powiązanie już po utworzeniu osoby (błąd tutaj to ostrzeżenie, osoba zostaje).
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
| `NAMETAG_ENABLE_DESTRUCTIVE` | nie | `true` | domyślnie wyłączone. Działa tylko razem z `NAMETAG_ENABLE_WRITE`; odblokowuje `delete_person` i `merge_people` |
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
`--restart unless-stopped`, zmienne z tabeli powyżej i dwa mapowania ścieżek tylko do
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

Uruchamia serwer na fałszywym API Nametaga (w CI także przed zbudowaniem obrazu). Fałszywe
API odtwarza zachowania Nametaga, które serwer obchodzi (podmiana przy aktualizacji, wymagany
typ relacji, kasowany opis). Kształty odpowiedzi pochodzą z dokumentu OpenAPI i źródeł
Nametaga (0.63/0.64). Na żywym Nametagu (0.64.1) sprawdzono dotąd tylko `catalog` i
narzędzia odczytu; narzędzia zapisu sprawdzono względem źródeł i fałszywego API, więc
przetestuj je najpierw na tymczasowej osobie. Jeśli nowsza wersja zmieni kształty, pierwsze do
sprawdzenia są `get_person` i `find_people`.
