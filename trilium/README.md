# trilium

*([Polska wersja poniżej ↓](#polski))*

MCP connector for [TriliumNext](https://github.com/TriliumNext/Trilium) built on its ETAPI. Made for planning and writing together with Claude (RPG scenarios, notes, a wiki): a tree of notes, links between them, labels and relations. Zero dependencies, same gateway as the other connectors in this repo.

Image: `ghcr.io/radzupl/mcp-connectors/trilium:latest`

## Safety model

| Switch | Effect |
|---|---|
| (default) | read-only: `status`, `search_notes`, `get_note`, `get_tree`, `recent_changes` |
| `TRILIUM_ENABLE_WRITE=true` | adds `create_note`, `update_note`, `move_note`, `clone_note`, `set_label`, `set_relation`, `remove_attribute`, `day_note`, `undelete_note`, `create_backup` |
| `TRILIUM_ENABLE_DESTRUCTIVE=true` (needs write) | adds `delete_note` (soft delete, `undelete_note` brings it back) |

An ETAPI token has no scopes, so unlike Nametag the read-only switch lives in this process (it refuses every non-GET request). Safety nets: every content change first saves a note revision and is refused if that fails; deletes are soft; `create_backup` writes a database backup. Import, export and auth routes are never reachable. Protected notes cannot be read or changed (ETAPI cannot open a protected session).

If you only write and edit notes, leave `TRILIUM_ENABLE_DESTRUCTIVE=false`: nothing is lost in day-to-day use and one more tool stays out of the model's reach.

## Links between notes

In text notes write `[[noteId]]` for a reference link (shows the note's title) or `[[noteId|label]]` for a link with your own text. The connector converts these to Trilium's HTML and back, and refuses ids that do not exist. `get_note` shows links in the same form and lists the titles behind them. Relations (`set_relation`) give typed links such as `~npc`, which Trilium can show and search. Markdown notes (`format=markdown`) are stored as typed (a `code` note with mime `text/x-markdown`, which Trilium opens in its Markdown editor with a preview), since `[[noteId]]` is native there.

`create_note` saves the content a second time when it contains links: Trilium only indexes links (the `internalLink` relation, i.e. backlinks) when the content is saved, not when the note is created.

The href format of a link is one constant (`REF_PREFIX` in `server.js`). If your Trilium version writes links differently, change it in one place.

## Setup

1. In Trilium: Options → ETAPI → create a token. Put it in `/mnt/user/appdata/mcp-trilium/trilium_etapi_token`.
2. Generate the bearer token Claude will use: `openssl rand -hex 32 > /mnt/user/appdata/mcp-trilium/bearer_token`.
3. Add the container from `unraid/mcp-trilium-connector.xml` (network `mcp_network`). Set `TRILIUM_URL` to an address that is reachable **from that network**: `http://triliumnext:8080` only works when Trilium is on the same Docker network; if it is not, use the host address and the published port, e.g. `http://192.168.1.10:8887`.
4. Expose it like the other connectors, see [`docs/exposing-with-cloudflare-tunnel.md`](../docs/exposing-with-cloudflare-tunnel.md). The Trilium UI and `/mcp` can share one hostname: a tunnel route for the path `^/mcp` goes to `http://mcp-trilium-connector:8000`, everything else goes to Trilium; Cloudflare Access protects the UI and a bypass Access application covers `/mcp` (the bearer token and the WAF rules protect that path).

## Environment

| Variable | Meaning |
|---|---|
| `TRILIUM_URL` | address of Trilium as seen from the connector's network, e.g. `http://triliumnext:8080` or `http://<host-ip>:8887` |
| `TRILIUM_TOKEN_FILE` | file with the ETAPI token (`TRILIUM_TOKEN` also works, the file is preferred) |
| `MCP_BEARER_TOKEN_FILE` | file with the bearer token checked by the gateway |
| `TRILIUM_ENABLE_WRITE`, `TRILIUM_ENABLE_DESTRUCTIVE` | see above |

## Tests

`node trilium/test-server.js` runs the tools against an in-memory mock of the ETAPI; `node trilium/test-links.js` checks the link conversion. Both run in CI before every build.

---

<a id="polski"></a>
## Polski

*([English version above ↑](#trilium))*

Connector MCP dla [TriliumNext](https://github.com/TriliumNext/Trilium) oparty na jego ETAPI. Powstał do planowania i pisania razem z Claude (scenariusze RPG, notatki, wiki): drzewo notatek, linki między nimi, etykiety i relacje. Zero zależności, ten sam gateway co pozostałe connectory w tym repo.

Obraz: `ghcr.io/radzupl/mcp-connectors/trilium:latest`

### Model bezpieczeństwa

| Przełącznik | Efekt |
|---|---|
| (domyślnie) | tylko odczyt: `status`, `search_notes`, `get_note`, `get_tree`, `recent_changes` |
| `TRILIUM_ENABLE_WRITE=true` | dodaje `create_note`, `update_note`, `move_note`, `clone_note`, `set_label`, `set_relation`, `remove_attribute`, `day_note`, `undelete_note`, `create_backup` |
| `TRILIUM_ENABLE_DESTRUCTIVE=true` (wymaga zapisu) | dodaje `delete_note` (miękkie usunięcie, `undelete_note` je cofa) |

Token ETAPI nie ma zakresów, więc w odróżnieniu od Nametaga przełącznik tylko-do-odczytu działa w tym procesie (odrzuca każde żądanie inne niż GET). Zabezpieczenia: każda zmiana treści najpierw zapisuje rewizję notatki i jest odrzucana, jeśli się nie uda; usuwanie jest miękkie; `create_backup` robi kopię bazy. Trasy import, export i auth są niedostępne. Notatki chronione (protected) są nieczytelne i niemodyfikowalne, bo ETAPI nie otworzy sesji chronionej.

Jeśli tylko piszesz i edytujesz notatki, zostaw `TRILIUM_ENABLE_DESTRUCTIVE=false`: na co dzień nic nie tracisz, a model ma jedno narzędzie mniej pod ręką.

### Linki między notatkami

W notatkach tekstowych pisz `[[noteId]]` dla linku referencyjnego (pokazuje tytuł notatki) albo `[[noteId|etykieta]]` dla linku z własnym tekstem. Connector zamienia to na HTML Triliuma i z powrotem, a nieistniejące id odrzuca. `get_note` pokazuje linki w tej samej formie i wypisuje tytuły celów. Relacje (`set_relation`) dają linki typowane, np. `~npc`, które Trilium pokazuje i potrafi przeszukiwać. Notatki Markdown (`format=markdown`) są zapisywane tak, jak je wpiszesz (notatka typu `code` z mime `text/x-markdown`, którą Trilium otwiera w edytorze Markdown z podglądem); tam `[[noteId]]` jest natywne.

`create_note` zapisuje treść drugi raz, gdy zawiera linki: Trilium indeksuje linki (relacja `internalLink`, czyli backlinki) dopiero przy zapisie treści, a nie przy tworzeniu notatki.

Format hrefa linku to jedna stała (`REF_PREFIX` w `server.js`). Jeśli twoja wersja Triliuma zapisuje linki inaczej, zmieniasz to w jednym miejscu.

### Instalacja

1. W Trilium: Options → ETAPI → utwórz token. Zapisz go w `/mnt/user/appdata/mcp-trilium/trilium_etapi_token`.
2. Wygeneruj bearer token dla Claude: `openssl rand -hex 32 > /mnt/user/appdata/mcp-trilium/bearer_token`.
3. Dodaj kontener z `unraid/mcp-trilium-connector.xml` (sieć `mcp_network`). W `TRILIUM_URL` wpisz adres osiągalny **z tej sieci**: `http://triliumnext:8080` działa tylko wtedy, gdy Trilium jest w tej samej sieci Dockera; jeśli nie jest, użyj adresu hosta i opublikowanego portu, np. `http://192.168.1.10:8887`.
4. Wystaw go jak pozostałe connectory, zobacz [`docs/exposing-with-cloudflare-tunnel.md`](../docs/exposing-with-cloudflare-tunnel.md). UI Triliuma i `/mcp` mogą dzielić jeden hostname: trasa tunelu dla ścieżki `^/mcp` idzie do `http://mcp-trilium-connector:8000`, reszta do Triliuma; Cloudflare Access chroni UI, a osobna aplikacja Access z polityką Bypass obejmuje `/mcp` (tę ścieżkę chronią bearer token i reguły WAF).

### Zmienne środowiskowe

| Zmienna | Znaczenie |
|---|---|
| `TRILIUM_URL` | adres Triliuma widziany z sieci connectora, np. `http://triliumnext:8080` albo `http://<ip-hosta>:8887` |
| `TRILIUM_TOKEN_FILE` | plik z tokenem ETAPI (`TRILIUM_TOKEN` też działa, plik ma pierwszeństwo) |
| `MCP_BEARER_TOKEN_FILE` | plik z bearer tokenem sprawdzanym przez gateway |
| `TRILIUM_ENABLE_WRITE`, `TRILIUM_ENABLE_DESTRUCTIVE` | zobacz wyżej |

### Testy

`node trilium/test-server.js` odpala narzędzia na mocku ETAPI w pamięci; `node trilium/test-links.js` sprawdza konwersję linków. Oba lecą w CI przed każdym buildem.
