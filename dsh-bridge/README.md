# dsh-bridge

English | [简体中文](README.zh-CN.md)

One audited entry point for the capabilities of the Harness host that are reachable but undocumented — with confirmation, timeouts, a circuit breaker, and an audit trail, so other plugins can call them.

Harness is "everything is a plugin": capabilities hang off a cordis context, but which service is called what, and what its methods take, is scattered across each package's `lib/types` and README with no published contract. The practical result is that a plugin author either digs through source and guesses (and breaks on upgrade), or bypasses the capability and reimplements it.

This package takes the reaching back: **the fragile part is allowed to exist in exactly one place**, and consumers depend only on stable capability names.

```js
export const inject = ['dshBridge']

export function apply(ctx) {
  const bridge = ctx.get('dshBridge')

  const result = await bridge.call('shell', 'run', { command: 'git status' })
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)

  await bridge.invoke('plugin.restart', { plugin: 'my-plugin', confirm: true }, { caller: 'my-plugin' })
}
```

## Capabilities

| Capability | Risk | What it does |
|---|---|---|
| `service.list` | low | List registered service names, whether each resolves right now, and whether it is on the deny list |
| `service.describe` | low | Show one service's own keys and the methods on its prototype chain |
| `service.call` | medium | Call one method on one service; the result is snapshotted |
| `plugin.list` | low | List loader entries: id, package name, activation state |
| `config.edit` | high | Persist one plugin's configuration into the active profile patch and apply it |
| `plugin.restart` | high | Reload a plugin by id or package name; with no argument, reload this one |
| `app.exit` | high | Ask the launcher to shut the host down gracefully |

Every call returns an envelope, and **a capability failure is not an exception** — only a malformed request is:

```js
{ ok: true,  capability: 'service.call', caller: 'my-plugin', at: 1794203342454, ms: 3, value: { /* … */ } }
{ ok: false, capability: 'service.call', caller: 'my-plugin', at: 1794203342454, ms: 1, error: { code: 'service-denied', message: '…' } }
```

The codes are fixed, so callers can branch on them: `unknown-capability`, `confirmation-required`, `breaker-open`, `timeout`, `service-denied`, `service-unavailable`, `no-such-method`, `no-such-plugin`, `bad-request`, `failed`.

## Three hard rules

**1. Destructive actions need an explicit confirmation.** `config.edit`, `plugin.restart`, and `app.exit` sit on the `confirm` list; the caller must pass `{ confirm: true }` or it gets `confirmation-required` and the host is untouched. This is the guard against the "agent retries in a loop and restarts itself three times" class of accident.

**2. Answer first, move the lifecycle second.** Reload and exit are deferred to the next tick. The reason is concrete: a plugin that restarts itself synchronously inside its own call stack cuts the caller off mid-flight — no result, no error, a log that stops halfway. So these capabilities return `{ accepted: true, deferred: true }` instead of a result.

**3. Only snapshots cross the boundary.** `service.call` results go through `serialize.js`: functions become names, cycles stop at depth 3, collections over 32 items carry a `truncated` marker, and **any value under a field named `apiKey / secret / token / password / credential / authorization` is replaced with `«redacted»`**. A caller never receives a live service object, so it cannot hold a handle on host internals — which is the whole point of this plugin.

## Configuration writes: two rules

`config.edit` has two modes, and picking the wrong one leaves a mess behind.

**`patch` (recommended)** — give only the fields you want changed, and the bridge merges:

```js
await bridge.invoke('config.edit', { plugin: 'my-plugin', patch: { retries: 5 }, confirm: true })
```

The merge rule is the point. `configEditor` writes a **complete** config override, so the naive `{ ...current, ...patch }` would copy every field you never touched into the user's patch layer, where bundle upgrades can no longer reach them. The bridge does one more step: **a field the patch did not mention and whose current value still equals its inherited value is dropped**, handing it back to the bundle layer. An explicit setting that equals the default therefore leaves no trace — it behaves identically anyway. `undefined` in a patch means "remove this key".

**`config`** — a complete override, and you own restating every field that should stay.

**`dryRun` first.** Passing `{ dryRun: true }` returns what would be written plus `removesOverride`, without touching a byte. When the merged result happens to equal the inherited config, `configEditor` deletes the whole override row — that is not an accident, it is its built-in "cancel the override" semantics.

Two hard constraints: **the bridge cannot rewrite its own row** (the reload it triggers would cut the current call in half, leaving the caller with neither result nor error), and **only entries under the root include with a unique id are editable** — anything else returns `no-such-plugin`. If a home patch or a command-line overlay outranks the write, `configEditor` rejects the whole thing and leaves the file unchanged; the bridge reports that error verbatim.

## Configuration

Written into your own profile `cordis.patch.yml`, overriding the bundle layer:

```yaml
- id: dsh-bridge
  config:
    timeoutMs: 15000            # per-call deadline; exceeding it returns `timeout`
    auditLimit: 200             # audit ring size
    confirm: [config.edit, plugin.restart, app.exit]
    serviceDeny: [credentials, configEditor, dshBridge]   # hard deny list, matched before anything runs
    breakerThreshold: 5         # consecutive failures before short-circuiting
    breakerCooldownMs: 30000    # how long the breaker stays open
```

`credentials` is on the deny list by default, and not out of fussiness: that service hands back plaintext secrets, and once one has flowed through `service.call` into some plugin's result, there is no taking it back.

`configEditor` is there for a different reason — it **goes around the gate**. `config.edit` has a confirmation, a dry run, and a merge that does not pin defaults; `service.call('configEditor', 'edit', …)` has none of that and still writes to the user's profile patch. One path is enough.

## Install

With Harness's own Plugin Manager (in Creator mode):

```js
plugin_manager({ action: 'install_bundle', target: 'D:/project/qujinting/dsh-plugins/dsh-bridge' })
```

`application: applied` is what means it took effect. Afterwards confirm via `cordis_inspect_query` that `dshBridge` is actually provided — not by reading logs or guessing.

Mounting by hand works too: copy the `insert` row from `cordis.patch.yml` into your profile's patch layer.

## Honest limits

**It cannot restart the desktop application.** That is a design constraint, not unfinished work. Application restart lives in the Electron main process (`DESKTOP_IPC` in `resources/app/lib/main.js` has no restart channel at all; `windowsMenu` only pops a menu), and no plugin — host or client — can reach it. `plugin.restart` reloads a **plugin** through `fiber.restart()`, the same mechanism HMR and the config editor already use.

**`service.call` is the strongest form of coupling available.** It frees callers from knowing service names, but it also turns "what was called" into runtime behaviour that no compiler checks. Use it after `service.list` / `service.describe` has told you what is there, and wrap it in your own thin functions — one wrapper per method, as in the example above, rather than scattering `bridge.call` through business logic.

**`fiber.restart()` rebuilds plugin state.** Anything in memory is gone and `apply` runs again. If the target holds an unflushed queue or cache, a reload loses data. Think before calling.

## Evidence

None of this is guesswork; every claim can be checked in a local installation:

| Claim | Location |
|---|---|
| Plugin shape: `export function apply(ctx, config)` + `export const inject` | `resources/app/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md` |
| `fiber.restart()` disposes and reloads with the current config | `.../cordis/lib/index.js:738` |
| `ctx.provide(name, value)` registers a service that dies with the fiber | `.../cordis/lib/index.js:1384` |
| The `loader` service enumerates entries | `.../cordis-plugin-loader/lib/index.js:739` |
| `appExit` is provided by the launcher and read with `ctx.get` | `.../dsh-cmdline/lib/index.js:30` |
| `configEditor.configuration()` yields editable entries + inherited values + current override | `.../dsh-config-editor/lib/index.js:41` |
| `configEditor.edit(entry, change)` deletes the row when it equals the inherited config | `.../dsh-config-editor/lib/index.js:98` |
| There is no restart IPC on the desktop side | `resources/app/lib/main.js:1445-1477` |
| Extension-point selection and upgrade stability | `.../skills/cordis-plugin-development/references/practices.md` |

## Development

```bash
npm run check   # syntax check for the four modules
npm test        # 41 cases against a fake ctx; no DSH install required
```

The fake context in the tests implements only `get / provide / effect / reflect.props / fiber.restart / logger` — which is itself a promise: if the plugin ever needs more of the framework than that, it is coupling harder than it claims.

Zero dependencies: nothing is imported from `@deepseek-ai/*`, because a profile-installed plugin cannot resolve those, and this package has to survive a harness upgrade untouched.

## Not built yet

- `config.read` — read one plugin's current and inherited config. Technically trivial, but it would send whatever secrets the config holds across the boundary, so the redaction story has to come first.
- `event.emit` / waterfall injection — more dangerous than `service.call`, because it can change someone else's control flow. If it lands, it should be its own capability with its own allow list.

## License

MIT
