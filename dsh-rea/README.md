# dsh-rea

REA's reverse-engineering capability as **one plugin instead of one mode**.

[中文](README.zh-CN.md)

## The problem this solves

REA ships an MCP server with 229 tools. Wired through the generic MCP bridge
(`@deepseek-ai/dsh-mcp-client`), that is 229 tool schemas in **every request of
every session** — the exact shape that makes a fast model feel slow. The usual
answer is an agent preset that mounts the bridge only for sessions that need it:
a second mode you must remember to switch into, and remember to switch out of.

This plugin keeps the capability in every session and the cost out of it: it owns
the REA server process itself, exposes **two** tools, and starts the server only
when something calls it.

| | preset + `dsh-mcp-client` | this plugin |
|---|---|---|
| Tool schemas per request | 229 | 2 |
| Switching modes | required | none |
| Server process | one per reverse-engineering session, started at session start | started on first call, stopped after idle |
| Catalog source | the server | the server (discovered at run time, so a REA upgrade changes nothing here) |

## Tools

| Tool | Purpose |
|---|---|
| `rea_tools` | Search the live catalog. `query` matches names/titles/descriptions; `exact` returns one tool with its complete input schema; `schemas` inlines schemas for every match. |
| `rea_call` | Run one tool: `{ tool, arguments }`. An unknown name is rejected instead of guessed, so a hallucinated tool fails loudly. |

A short system-prompt section states the two-call shape, because a capability the
model cannot see needs a sentence telling it where the door is.

## Configuration

Every field is optional; the defaults are what the descriptions promise.

```yaml
- id: dsh-rea
  name: 'dsh-rea'
  config:
    command: npx                    # or: node
    args: ['-y', 'rea-agents@6.8.0', 'mcp']   # or: ['<abs>/rea-agents/scripts/rea.mjs', 'mcp']
    toolsToolName: rea_tools
    callToolName: rea_call
    startupTimeoutMs: 180000        # spawn + initialize + tools/list
    callTimeoutMs: 1800000          # one tools/call; 30 minutes by default, see "Timeouts"
    idleTimeoutMs: 600000           # stop the server after this much silence; 0 = never
    registerPromptSection: true
    warmup: false                   # true starts the server at plugin activation
```

On Windows a package runner (`npx`, `pnpm`, `bunx`, …) is spawned through
`cmd.exe /d /c`, because it is a `.cmd` shim that Node will not spawn directly.

## Install

```
plugin_manager action=install_bundle target=<absolute path to this directory>
```

Configure where REA comes from first (next section), then call `rea_tools` with a
keyword. The first call pays the process start (measured here: 2.4 s to
`initialize`, 51 ms for `tools/list` over 229 tools); later calls go to the same
process, and it exits on its own after `idleTimeoutMs`.

## Settings: where REA comes from

A bundle reaches machines that never ran `npx rea-agents`, so the source is a
setting rather than an assumption. **Settings → Reverse engineering REA** is an
entry in `settings.section` (order 65).

What stays visible is one line: **ready / not configured**, the source, the
version, and three buttons (Test connection, Change, Details). Everything else
folds until asked for:

| Fold | Contents |
|---|---|
| Details | the full launch line, the data directory, and the three candidates with availability |
| Point at a local rea.mjs | absolute path + save / clear (saving stops the running process so the next call relaunches) |
| Install from npm | version + install / cancel + live log (`npm install rea-agents@<version>` into the data directory) |

The page opens the fold it needs: **no REA at all opens "Install from npm"**, and a
configured path that stopped resolving opens "Point at a local rea.mjs". The
connection test reports as one badge under the status line (tool count / elapsed).

The priority is fixed:

| Priority | Source | When |
|---|---|---|
| 1 | Configured `rea.mjs` | a path was saved and the file still exists |
| 2 | Vendor install | `<dataDir>/node_modules/rea-agents/scripts/rea.mjs` exists |
| 3 | Configured `command`/`args` | no path, no vendor install |
| 4 | Default `npx -y rea-agents@6.8.0 mcp` | none of the above |

The data directory resolves as config `dataDir` → `$DSH_PROFILE_DIR/data/dsh-rea`
→ `~/.dsh/data/dsh-rea`. Never the package directory: for a linked install that
is the user's source tree, and for a published install it is replaced on upgrade.

The page talks to the host over `/api/dsh-rea` (`GET /status`, `POST /set-path`,
`POST /clear-path`, `POST /install`, `POST /cancel-install`, `POST /probe`). The
route passes `ctx.connection`'s Host/Origin fence and browser authentication, and
degrades to loopback-only without that service.

## Migrating from `@local/dsh-rea-preset`

The old `rea` mode (agent preset + `dsh-mcp-client`) has been removed from this
profile: it put 229 `mcp__rea__*` tools into every request of that session and
kept a REA process alive for as long as the session was open. This plugin owns the
capability now, in every mode, and starts a process only when something calls it.

Reinstalling that bundle brings the old behaviour back — the names do not collide
(`mcp__rea__*` versus `rea_tools`/`rea_call`) — but running both means two copies
of the schemas and two processes.

## Timeouts and process reclamation

Two different "ten minutes":

| Mechanism | Default | What happens |
|---|---|---|
| `callTimeoutMs` | 30 minutes | this one call is abandoned (the client stops waiting); **the server keeps working**, its result is simply dropped |
| `idleTimeoutMs` | 10 minutes | counted from the end of the last call; the process stops only when nothing is in flight |

Two rules for long jobs:

- For work you expect to exceed 30 minutes (full decompile of a large binary, cold provider startup, runtime tracing), pass `timeoutMs` to `rea_call` (ceiling 2 hours) instead of retrying.
- The idle watchdog only reschedules while a call is in flight, so a running decompile is never reclaimed as "idle". The settings page's **Test connection** refuses while a call is running; saving or clearing a path still stops the process immediately, because that is what the user asked for.

## Process safety: does REA outlive the Harness?

No. Three layers, strongest first:

| Situation | Who acts | Measured |
|---|---|---|
| plugin unload / HMR / normal shutdown | the Cordis `ctx.effect` disposer → `client.dispose()` → `taskkill /pid <pid> /T /F` | immediate |
| Electron exits without running disposers | synchronous `taskkill /T` inside `process.on('exit')` | during exit |
| the process is killed or crashes | the stdio pipe the parent holds closes → REA reads stdin EOF and exits by itself | 240 ms (`node rea.mjs mcp`) / 722 ms (`cmd → npx → node`) |

The Harness exposes **no** subscribable "host is exiting" event (there is no `app/quit` in the
`Event` catalogue), so the third layer does not depend on a hook: it depends on stdio
semantics. The plugin always spawns with `stdio: ['pipe','pipe','pipe']` — **switching to
`inherit` or `ignore` removes that safety net**, so do not change it when reworking the launch.

Measured twice, both exit 0 with no leftover process:

```
initialize ok: {"name":"rea","version":"6.8.0"}
closing stdin
child exited: code=0 signal=null after 240ms    # vendor path: node direct
child exited: code=0 signal=null after 722ms    # default path: cmd /d /c npx -y rea-agents@6.8.0 mcp
```

Check for leftovers yourself:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" |
  Where-Object { $_.CommandLine -match 'rea-agents|rea\.mjs' } |
  ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToString('HH:mm:ss'))" }
```

Any output means a process escaped the three layers above — usually because another running
Harness instance owns it; `taskkill /pid <pid> /T /F` clears it.

## Scope and limits

- **Text only.** `tools/call` results are forwarded as text; image blocks are
  counted and reported, not attached. REA's RE work is textual by nature, and
  image plumbing would need the attachment service, which a profile-installed
  bundle cannot reach.
- **No resources or prompt templates.** REA's 229 tools and its server
  instructions are the surface this plugin bridges; MCP resources and prompt
  templates are left to `dsh-mcp-client`.
- **One shared process.** Concurrent tool calls multiplex over one JSON-RPC pipe;
  a long decompile does not block the catalog, but it does hold the pipe.
- **No SDK.** The transport is ~250 lines of newline-delimited JSON-RPC over
  `child_process`, because a profile-installed bundle cannot resolve
  `@deepseek-ai/*` or add dependencies without a network install.

## Verify

```
node --check src/*.js
node test/smoke.mjs                                  # gateway logic, no server
REA_LIVE=1 node test/smoke.mjs                       # protocol against the real server
REA_LIVE=1 REA_COMMAND=node REA_ARGS="<abs>/rea-agents/scripts/rea.mjs mcp" node test/smoke.mjs
```

Measured on dsh 0.2.2-rc.1 / rea-agents 6.8.0, Windows, Node 24.22.2:
`initialize` 2 421 ms, `tools/list` 51 ms, 229 tools in one page.

## License

MIT
