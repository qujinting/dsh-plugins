# dsh-secret-broker

English | [简体中文](README.zh-CN.md)

A DSH desktop plugin: enter sensitive data as key → value pairs in the settings UI, and a session only ever receives the **key name**. The host injects the value into a child process at the moment a command or script actually runs.

- UI: **Settings → Secrets**, or the key icon in the session title bar (three scopes: global / project / session)
- Session side: `$env:DSH_SECRET_<KEY_NAME_UPPERCASED>`; the `secret_list` tool lists key names and descriptions, never values
- At rest: `data/secrets.dpapi`, encrypted with Windows DPAPI (CurrentUser)
- Result redaction: if a known value appears in any tool result, it is replaced with `«redacted:KEY»` before the result is committed to the session log

## Why not just paste the token into the chat

Once a value enters the conversation, it has already been sent to the model provider, indexed by session search, and copied into every backup of the session log. This plugin's stance is the opposite: **the value never enters the model context**, and exists in plaintext in exactly one place, at exactly one moment — the child process environment of a shell call.

```
enter in UI  ──▶  data/secrets.dpapi (DPAPI ciphertext)
                    │
model writes: pwsh -Command 'curl -H "Authorization: Bearer $env:DSH_SECRET_API_TOKEN" …'
                    │
       ctx.shellEnv.collect(exec)  ← injects only keys that the command names and whose scope applies
                    │
       child process env (never in argv, never in tool arguments)
                    │
       tool result ──▶ tools/post-execute redaction ──▶ only then written to the session log
```

## Usage

The plugin offers two entry points:

| Entry point | Where | What it does |
|---|---|---|
| **Title bar** | A key icon among the icons on the right of the session title bar | Opens a modal listing the **global / this project / this session** key-value groups, and lets you **add, edit, and delete right there** |
| **Settings page** | Settings → Secrets | The same, plus a **cross-scope overview** (see secrets from every scope, enter one for another project or session, promote an orphan entry to global) |

That icon button follows the same spec as the row beside it (new tab / split / fullscreen / collapse sidebar): 28×28, 8px radius, transparent background, layer-2 fill on hover, 14px line-art SVG — it sits in that row without taking extra width or changing the title bar height. Clicking it opens a centered modal (28px radius, layer surface, scrim, closes on Esc or scrim click), so by construction it cannot affect title bar layout.

Each row in the modal offers: `show / hide`, `copy` (once the value is visible), `edit`, `promote` (project and session rows only), `delete`. Each of the three groups (global / this project / this session) has an `add` that opens an inline form (key name / value / description); the scope is decided by which group you clicked. `delete` takes **two clicks** (the second turns the button into "confirm delete", which resets after 4 seconds without a click). `edit` only takes a new value — the old value is never echoed back into the form, because that would put the secret on screen for you to type over.

Values are masked by default; `show` reveals one in plaintext for 30 seconds (`titleBarValues: plain` makes the modal open unmasked).

### 1. Entering a secret

Open **Settings → Secrets**, fill in a key name and value, pick a scope, save.

| Field | Meaning |
|---|---|
| Key name | Starts with a letter; letters, digits, `_`, `-`; up to 64 characters. `gh-token` → `DSH_SECRET_GH_TOKEN` |
| Value | Not shown again after saving (you can reveal it for 30 seconds) |
| Scope | See below |
| Description | Optional; appears in the key list the session sees |

**Three scopes, the more specific one wins** (`session > project > global`; same-named keys are overridden by the more specific entry):

| Scope | When it applies | What it suits |
|---|---|---|
| **Global** | Every session | Your personal long-lived tokens |
| **Project** | The session's **working directory** equals that directory, **or is below it** (subdirectories count; the deepest match wins) | A repository's deploy key, a project's database password |
| **Session** | Only that one session | Temporary credentials, one-off debugging |

A project is keyed **by directory**, not by session: a new session in the same project still sees it, and archiving the session keeps the secret — which is exactly why it suits project-specific credentials better than session scope. Nested projects (`repo` and `repo\packages\app`) override each other, and the deepest one wins.

Row actions: `reveal` (auto-hides after 30 seconds), `promote to global`, `delete`.

### 2. Using it in a session

```powershell
# The variable name must appear in the command text for that one variable to be injected
curl -sS -H "Authorization: Bearer $env:DSH_SECRET_API_TOKEN" https://api.example.com/v1/items

git clone https://x-access-token:$env:DSH_SECRET_GH_TOKEN@github.com/owner/repo.git
```

When you invoke a script by path, the command names no variable — unlock with a marker:

```powershell
# secret-broker: DB_PASS, API_TOKEN
pwsh -File .\migrate.ps1
```

`# secret-broker: all` injects every key available to the session (avoid it unless you must).

### 3. How the model learns which keys exist

- **System prompt**: every session carries a short explanation plus the available key list (names and descriptions only);
- **The `secret_list` tool**: re-query at any time;
- **The `secret-broker` skill**: the full usage and troubleshooting table.

All three are registered by the host plugin at the global layer, independent of the agent preset, the user's memory file, and the skills directory.

## Security model

**Guarantees**

1. The value never enters the model context — no tool, prompt, or skill path returns it; `secret_list`'s output schema has no value field.
2. The value never enters the session log — `tools/post-execute` rewrites it before the result is committed.
3. Values are not swept out in bulk — only keys the command text names are injected, so `Get-ChildItem env:` comes back empty.
4. No plaintext at rest — DPAPI is bound to the current Windows account; copying the file, switching users, or switching machines yields nothing.
5. Values stay out of git and out of the npm package — `data/` is excluded by both `.gitignore` and `package.json#files`.
6. Browser side — every route goes through `ctx.connection.requestRejection` (host/origin fence plus browser authentication) and responds `no-store`; there is no model-side "reveal" path.
7. The title bar modal masks by default — that is the most screenshot-prone strip, so a value needs one explicit click to become plaintext; the `/state` route has no value field by construction, and "show" fetches `/reveal` per key.

**Non-guarantees** (do not misread these)

- **Not protection against same-machine, same-user processes**: the plugin's process memory holds decrypted values, and so does the environment of a running child process (that is the feature).
- **Not protection against a model acting deliberately**: a model that knows a key name can make any program send the value anywhere. Name filtering and redaction stop *accidental* leaks, not *intentional* ones.
- **Redaction matches whole values**: values shorter than `redactMinLength` (default 8) are not scanned, so a command that prints a **truncated substring** is not rewritten.
- **DPAPI is bound to the current Windows account**: after an account change, reinstall, or machine change the ciphertext is unreadable — the outcome is a read-only lock plus an error, not silent data loss.
- **Shell tools only**: `read` / `write` / MCP tools do not go through the injection path.

## Configuration

```yaml
- id: dsh-secret-broker
  name: 'dsh-secret-broker'
  config:
    dataDir: ''            # default: <package dir>/data
    encryption: dpapi      # dpapi | none (only effective when no file exists yet)
    keyPrefix: DSH_SECRET_
    toolName: secret_list
    allowReveal: true      # whether the UI may reveal stored values (also governs show/copy in the title bar modal)
    titleBarValues: masked # masked (default, plaintext only after "show") | plain (plaintext when the modal opens)
    redactResults: true    # master switch for result redaction
    redactMinLength: 8     # values shorter than this are not scanned
    maxEntries: 200
    registerSkill: true
    registerPromptSection: true
    dpapiTimeoutMs: 20000
```

Invalid values fall back to defaults and leave one warning line in the host log; they never make the plugin fail to load.

## Install

```powershell
# 1. Link into the profile
#    C:\Users\<you>\.dsh\profiles\desktop\package.json
#      dependencies: { "dsh-secret-broker": "link:<this directory>" }
#      dsh.profile.bundles: [ ..., "dsh-secret-broker" ]
#    Or use the plugin_manager tool: install_bundle target=link:<this directory>
# 2. Install dependencies
pnpm install --dir $env:DSH_PROFILE_DIR
# 3. Refresh the page (a new bundle needs the boot graph re-injected)
```

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| The UI reports "cannot decrypt the encrypted file" | DPAPI cannot unwrap it (different Windows account or machine) | Run under the same account, or move `data/secrets.dpapi` away and re-enter |
| The UI reports "data directory is not writable" | `data/` permissions | Fix permissions, or point `dataDir` at a writable location |
| `$env:DSH_SECRET_X` is empty | The command did not name that variable, or the key name is misspelled | Write `$env:DSH_SECRET_X` into the command; check with `secret_list` first |
| A script receives nothing | The command names nothing and carries no marker | Add `# secret-broker: X` |
| Output turns into `«redacted:X»` | The command printed the value | Stop printing the value |
| Writes report "another process is writing" | Another DSH process is writing | Retry shortly |
| A session-scoped secret does not apply | That secret belongs to a different session | Re-enter it under the right scope |
| A deleted secret still shows up in another file under `data/` | Before each write the previous document is kept as `secrets.dpapi.bak` (same DPAPI ciphertext), and the next write overwrites it | Delete `secrets.dpapi.bak` to clear it immediately; it is not readable as plaintext |

## Development

```
src/index.js      assembly: store / shellEnv / tool / prompt / skill / routes / redaction
src/store.js      entry model, scopes, atomic writes, locking, backups, DPAPI switch
src/crypto.js     DPAPI bridge (powershell.exe + ProtectedData; the payload travels through the child env, not argv)
src/shellenv.js   the ctx.shellEnv contributor: declaration sync + named/marker/scope filtering
src/redact.js     result redaction for tools/post-execute and tools/ptc-dispatch-log
src/route.js      /api/dsh-secret-broker/*, connection fence + no-store
src/tool.js       secret_list
src/prompt.js     system prompt section + the dynamic key-list variable
src/skill.js      the embedded secret-broker skill
lib/client.js     both UI surfaces (a hand-written __ModuleLoader__ factory, no build step):
                  the title bar icon at conversation.session.header.utilities
                  plus its modal, and the settings.section page
```

```powershell
node --run test     # parse check + all unit tests (DPAPI-dependent ones skip automatically when unavailable)
```

Use `node --run test` rather than `pnpm test`: this package has no runtime dependencies, and the client half takes React from the shell's platform module table, so no package manager should drop a `node_modules` here.

`.dev/` holds one-off local acceptance tools (gitignored, not published): `mint-cookie.mjs` mints a browser session cookie for a throwaway Chrome so `chrome_cdp` can open the real GUI for acceptance checks.

## License

MIT
