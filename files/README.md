# files connector

*([Polska wersja poniżej ↓](#polski))*

Wraps the official [`@modelcontextprotocol/server-filesystem`](https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem),
pinned to the npm version in [`UPSTREAM_REF`](UPSTREAM_REF), and adds
[`supergateway`](https://github.com/supercorp-ai/supergateway) to expose it as
streamable-HTTP.

## Read-only vs read-write — a deliberate per-folder choice

The MCP server itself has no built-in, unbypassable "read-only" mode — the tools it
exposes are whatever its own code defines. Read-only enforcement here happens one layer
down, where the server has nothing left to say about it: mount the folder you're
sharing with `:ro` and it is physically impossible to write to it, no matter what the
server's code allows.

Whether to use `:ro` or `:rw` is a decision you make per mounted folder, based on how
much you trust write access to that specific directory — not a global default. If you
mount something `:rw`, know what you're accepting: the upstream server **has no delete
tool** (only read/write/edit/move/create — that's an upstream API design choice, not
something enforced here), so nothing can be permanently removed through this connector,
only overwritten, appended to, or moved. If you need to guarantee against writes, `:ro`
is what actually enforces it — don't rely on not asking for write tools.

## Access policy — hiding single files (`DENY_NAMES`, `ALLOW_ONLY`, `READ_ONLY`)

Sometimes a folder you want to share contains one file you do not: Home Assistant and
ESPHome keep `secrets.yaml` right next to the YAML files you want to edit. Mounting
cannot hide a single file, so the container can run the file server behind a small
policy proxy ([`deny-proxy.js`](deny-proxy.js), logic in [`deny-policy.js`](deny-policy.js)).
**It is off unless at least one of these variables is set**; without them the server
starts exactly as before.

| Variable | Example | Effect |
|---|---|---|
| `DENY_NAMES` | `secrets*,.esphome` | Comma-separated name patterns (`*` and `?`, case-insensitive). A path is refused when any segment below an allowed directory matches — files, directories and the targets of symlinks. Refused paths can be neither read nor written, and they disappear from `list_directory`, `list_directory_with_sizes`, `directory_tree` and `search_files`. |
| `ALLOW_ONLY` | `/data/ha-esphome=*.yaml\|*.yml` | Rules `absolute-prefix=glob\|glob`, separated by `;`. Below the prefix only files whose name matches can be read or written (directories stay listable), so nobody can drop a script next to your YAML. Other allowed directories are not affected. |
| `READ_ONLY` | `1` | Every write tool (`write_file`, `edit_file`, `create_directory`, `move_file`) is refused. |

What it does, in order of what matters:

- **Checked before the server.** A refused `tools/call` is answered by the proxy; the
  file server never sees it.
- **Fails closed.** A tool it does not know, a missing or malformed argument, a path
  that resolves outside `ALLOWED_DIRS`, a result it cannot parse: all refused. A bad
  `ALLOW_ONLY` stops the container from starting instead of silently turning the policy off.
- **Resolves paths first.** `..`, symlinks (also ones pointing at a hidden file) and
  non-existing targets are resolved before matching. Names are compared in several
  spellings (case, trailing dot or space, `name:stream`, Unicode compatibility forms,
  8.3 short names like `SECRET~1.YAM`), because a Samba/CIFS share can resolve those to
  the same file.
- **Cleans results, including `structuredContent`.** The upstream server repeats its
  text output there; both copies are rewritten.
- **Only passes `initialize`, `ping`, `tools/list`, `tools/call` and notifications.**

What it does **not** do — read this before relying on it:

- It is a layer, not a mount. `:ro` remains the only hard guarantee against writes, and
  keeping secrets out of the shared tree remains the only hard guarantee against reads.
  If you can, share a directory that does not contain them.
- **Write access to configuration is write access to what the configuration does.** A
  YAML you let an assistant edit can reference `!secret` values in a place you later
  read back (a sensor, a log line) once you compile and flash it. Review diffs before
  you build.
- Hard links to a hidden file under another name are not detected; the file server has
  no tool that creates them, but someone with a shell on the host does.
- Check-then-use race: someone who can swap symlinks on the host at the right moment can
  win it. The server has no tool to create symlinks.
- The tool table in `deny-policy.js` has to know every upstream tool. If an upgrade adds
  one, it is refused until added — [`test-deny-upstream.js`](test-deny-upstream.js) (run in CI against the pinned
  version) fails and says which.
- `list_directory_with_sizes` loses its `Total` and `Combined size` lines, since they
  would reveal what was hidden.

Example, ESPHome YAML files shared read-write without `secrets.yaml`:

```yaml
    environment:
      ALLOWED_DIRS: /data/sessions /data/ha-esphome
      DENY_NAMES: secrets*,.esphome
      ALLOW_ONLY: /data/ha-esphome=*.yaml|*.yml
    volumes:
      - /mnt/ha-config/esphome:/data/ha-esphome:rw
```

Tests: `node files/test-deny-policy.js` (logic), `node files/test-deny-proxy.js` (proxy with
a fake file server), `node files/test-deny-upstream.js` (needs the real server on `PATH`).

## Configuration

| Variable | Set on | Required | Example | Notes |
|---|---|---|---|---|
| `ALLOWED_DIRS` | `mcp-files-connector` | yes | `/data` | path(s) inside the container the server exposes |
| `MCP_FS_VERSION` | build arg | yes | value of `UPSTREAM_REF` | pins the npm package version at build time |
| `MCP_BEARER_TOKEN` | `mcp-files-connector` | yes | a random 32+ char string | token your MCP client sends as `Authorization: Bearer ...` |
| `DENY_NAMES` | `mcp-files-connector` | no | `secrets*,.esphome` | see "Access policy" |
| `ALLOW_ONLY` | `mcp-files-connector` | no | `/data/x=*.yaml\|*.yml` | see "Access policy" |
| `READ_ONLY` | `mcp-files-connector` | no | `1` | see "Access policy" |
| bind mount mode | compose/host | yes | `:ro` or `:rw` | see above — pick deliberately per folder |

## docker-compose example

```yaml
services:
  mcp-files-connector:
    build:
      context: .
      dockerfile: files/Dockerfile.gateway
      args:
        MCP_FS_VERSION: "2026.8.31"   # keep in sync with UPSTREAM_REF
    # or: image: ghcr.io/<your-github-user>/<your-repo>/files:latest
    environment:
      ALLOWED_DIRS: /data
      MCP_BEARER_TOKEN: ${MCP_FILES_BEARER_TOKEN}
    volumes:
      - /path/on/host:/data:ro   # switch to :rw only if you deliberately want write access
    networks: [mcp]
    restart: unless-stopped

networks:
  mcp:
    driver: bridge
```

Expose port 8000 as described in the root README, and add it to your MCP client as
`https://<your-host>/mcp` with `Authorization: Bearer <MCP_FILES_BEARER_TOKEN>`.

---

<a id="polski"></a>
## Polski

*([English version above ↑](#files-connector))*

Opakowuje oficjalny [`@modelcontextprotocol/server-filesystem`](https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem),
przypięty do wersji npm w [`UPSTREAM_REF`](UPSTREAM_REF), i dokleja
[`supergateway`](https://github.com/supercorp-ai/supergateway), żeby wystawić go jako
streamable-HTTP.

### Tylko odczyt vs odczyt i zapis — świadomy wybór per folder

Sam serwer MCP nie ma wbudowanego, niemożliwego do obejścia trybu "tylko odczyt" —
narzędzia, które wystawia, to cokolwiek definiuje jego własny kod. Wymuszenie trybu
tylko-do-odczytu dzieje się tu jedną warstwę niżej, tam gdzie serwer nie ma już nic do
powiedzenia: zamontuj folder, którym się dzielisz, z flagą `:ro`, a zapis staje się
fizycznie niemożliwy, niezależnie od tego, co pozwala kod serwera.

Czy użyć `:ro` czy `:rw` to decyzja podejmowana per zamontowany folder, w zależności od
tego, jak bardzo ufasz dostępowi do zapisu w danym konkretnym katalogu — nie globalny
domyślny wybór. Jeśli montujesz coś jako `:rw`, wiedz na co się zgadzasz: serwer
upstream **nie ma narzędzia do kasowania** (tylko read/write/edit/move/create — to
decyzja projektowa API upstreamu, nie coś wymuszonego tutaj), więc nic nie da się przez
ten connector trwale usunąć, tylko nadpisać, dopisać albo przenieść. Jeśli potrzebujesz
gwarancji braku zapisu, to `:ro` faktycznie to wymusza — nie polegaj na tym, że po
prostu nie poprosisz o narzędzia do zapisu.

### Polityka dostępu — ukrywanie pojedynczych plików (`DENY_NAMES`, `ALLOW_ONLY`, `READ_ONLY`)

Czasem w folderze, którym chcesz się podzielić, leży jeden plik, którym nie chcesz:
Home Assistant i ESPHome trzymają `secrets.yaml` tuż obok plików YAML, które chcesz
edytować. Montowanie nie ukryje pojedynczego pliku, więc kontener może uruchomić serwer
plików za małym proxy z polityką ([`deny-proxy.js`](deny-proxy.js), logika w
[`deny-policy.js`](deny-policy.js)). **Jest wyłączone, dopóki nie ustawisz przynajmniej
jednej z tych zmiennych**; bez nich serwer startuje dokładnie jak dotąd.

| Zmienna | Przykład | Działanie |
|---|---|---|
| `DENY_NAMES` | `secrets*,.esphome` | Wzorce nazw oddzielone przecinkami (`*` i `?`, bez rozróżniania wielkości liter). Ścieżka jest odrzucana, gdy którykolwiek jej element poniżej dozwolonego katalogu pasuje: pliki, katalogi i cele dowiązań symbolicznych. Odrzuconych ścieżek nie da się ani czytać, ani zapisywać, i znikają z `list_directory`, `list_directory_with_sizes`, `directory_tree` i `search_files`. |
| `ALLOW_ONLY` | `/data/ha-esphome=*.yaml\|*.yml` | Reguły `bezwzględny-prefiks=wzorzec\|wzorzec`, oddzielone `;`. Poniżej prefiksu można czytać i zapisywać tylko pliki o pasującej nazwie (katalogi nadal da się listować), więc nikt nie podrzuci skryptu obok twoich YAML-i. Inne dozwolone katalogi nie są dotknięte. |
| `READ_ONLY` | `1` | Każde narzędzie zapisu (`write_file`, `edit_file`, `create_directory`, `move_file`) jest odrzucane. |

Co robi, w kolejności ważności:

- **Sprawdza przed serwerem.** Odrzucone `tools/call` odpowiada samo proxy; serwer
  plików w ogóle go nie widzi.
- **Zawodzi w stronę odmowy.** Nieznane narzędzie, brakujący lub zniekształcony argument,
  ścieżka wychodząca poza `ALLOWED_DIRS`, wynik, którego nie umie sparsować: wszystko
  odrzucane. Błędny `ALLOW_ONLY` zatrzymuje start kontenera, zamiast po cichu wyłączać
  politykę.
- **Najpierw rozwiązuje ścieżki.** `..`, dowiązania symboliczne (także te wskazujące na
  ukryty plik) i nieistniejące cele są rozwiązywane przed dopasowaniem. Nazwy są
  porównywane w kilku zapisach (wielkość liter, końcowa kropka lub spacja, `nazwa:strumień`,
  formy zgodności Unicode, krótkie nazwy 8.3 jak `SECRET~1.YAM`), bo udział Samba/CIFS
  potrafi je rozwiązać do tego samego pliku.
- **Czyści wyniki, łącznie z `structuredContent`.** Serwer upstream powtarza tam swój
  tekst; przepisywane są obie kopie.
- **Przepuszcza tylko `initialize`, `ping`, `tools/list`, `tools/call` i powiadomienia.**

Czego **nie** robi — przeczytaj, zanim na tym polegasz:

- To warstwa, nie mount. `:ro` zostaje jedyną twardą gwarancją braku zapisu, a trzymanie
  sekretów poza udostępnianym drzewem jedyną twardą gwarancją braku odczytu. Jeśli się da,
  udostępniaj katalog, w którym ich nie ma.
- **Dostęp do zapisu konfiguracji to dostęp do tego, co ta konfiguracja robi.** YAML,
  który pozwolisz edytować asystentowi, może odwołać się przez `!secret` do wartości
  w miejscu, które potem odczytasz (czujnik, linia logu), gdy go skompilujesz i wgrasz.
  Przeglądaj różnice przed buildem.
- Twarde dowiązania do ukrytego pliku pod inną nazwą nie są wykrywane; serwer plików nie
  ma narzędzia, które je tworzy, ale ktoś z powłoką na hoście ma.
- Wyścig sprawdzenie–użycie: wygra go ten, kto w odpowiednim momencie zamieni dowiązania
  na hoście. Serwer nie ma narzędzia do tworzenia dowiązań.
- Tabela narzędzi w `deny-policy.js` musi znać każde narzędzie upstreamu. Jeśli aktualizacja
  doda nowe, jest odrzucane, dopóki go nie dopiszesz — [`test-deny-upstream.js`](test-deny-upstream.js)
  (odpalany w CI na przypiętej wersji) zawiedzie i wskaże które.
- `list_directory_with_sizes` traci linie `Total` i `Combined size`, bo zdradzałyby, co
  ukryto.

Przykład: pliki YAML ESPHome udostępnione do odczytu i zapisu bez `secrets.yaml`:

```yaml
    environment:
      ALLOWED_DIRS: /data/sessions /data/ha-esphome
      DENY_NAMES: secrets*,.esphome
      ALLOW_ONLY: /data/ha-esphome=*.yaml|*.yml
    volumes:
      - /mnt/ha-config/esphome:/data/ha-esphome:rw
```

Testy: `node files/test-deny-policy.js` (logika), `node files/test-deny-proxy.js` (proxy z
atrapą serwera plików), `node files/test-deny-upstream.js` (wymaga prawdziwego serwera w `PATH`).

### Konfiguracja

| Zmienna | Ustawiana na | Wymagana | Przykład | Uwagi |
|---|---|---|---|---|
| `ALLOWED_DIRS` | `mcp-files-connector` | tak | `/data` | ścieżka(-i) wewnątrz kontenera, które wystawia serwer |
| `MCP_FS_VERSION` | build arg | tak | wartość `UPSTREAM_REF` | przypina wersję pakietu npm w czasie builda |
| `MCP_BEARER_TOKEN` | `mcp-files-connector` | tak | losowy string 32+ znaków | token, który twój klient MCP wysyła jako `Authorization: Bearer ...` |
| `DENY_NAMES` | `mcp-files-connector` | nie | `secrets*,.esphome` | zobacz „Polityka dostępu” |
| `ALLOW_ONLY` | `mcp-files-connector` | nie | `/data/x=*.yaml\|*.yml` | zobacz „Polityka dostępu” |
| `READ_ONLY` | `mcp-files-connector` | nie | `1` | zobacz „Polityka dostępu” |
| tryb mounta | compose/host | tak | `:ro` albo `:rw` | zobacz wyżej — wybieraj świadomie per folder |

### Przykład docker-compose

```yaml
services:
  mcp-files-connector:
    build:
      context: .
      dockerfile: files/Dockerfile.gateway
      args:
        MCP_FS_VERSION: "2026.8.31"   # keep in sync with UPSTREAM_REF
    # or: image: ghcr.io/<your-github-user>/<your-repo>/files:latest
    environment:
      ALLOWED_DIRS: /data
      MCP_BEARER_TOKEN: ${MCP_FILES_BEARER_TOKEN}
    volumes:
      - /path/on/host:/data:ro   # switch to :rw only if you deliberately want write access
    networks: [mcp]
    restart: unless-stopped

networks:
  mcp:
    driver: bridge
```

Wystaw port 8000 w sposób opisany w głównym README, i dodaj go do swojego klienta MCP
jako `https://<twój-host>/mcp` z `Authorization: Bearer <MCP_FILES_BEARER_TOKEN>`.
