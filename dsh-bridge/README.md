# dsh-bridge

English | [简体中文](README.zh-CN.md)

One audited entry point for the capabilities of the Harness host that are reachable but undocumented — with confirmation, timeouts, a circuit breaker, and an audit trail, so other plugins can call them.

Harness is "everything is a plugin": capabilities hang off a cordis context, but which service is called what, and what its methods take, is scattered across each package's `lib/types` and README with no published contract. The practical result is that a plugin author either digs through source and guesses (and breaks on upgrade), or bypasses the capability and reimplements it.

This package takes the reaching back: **the fragile part is allowed to exist in exactly one place**, and consumers depend only on stable capability names.

```js
export const inject = ['dshBridge']

export function apply(ctx) {
  const bridge = ctx.get('dshBridge')

  // What this deployment actually allows, before assuming anything.
  const reachable = (await bridge.invoke('service.list')).value.filter(row => row.allowed)

  // SERVICE / METHOD are placeholders: the default policy only opens inert
  // services, so read service.list for the real names in your profile.
  const result = await bridge.call('SERVICE', 'METHOD', { /* plain data only */ })
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)

  await bridge.invoke('plugin.restart', { plugin: 'my-plugin', confirm: true }, { caller: 'my-plugin' })
}
```

## Capabilities

| Capability | Risk | What it does |
|---|---|---|
| `service.list` | low | List registered service names, whether each resolves, and whether the bridge will reach it (`denied` / `allowed`) |
| `service.describe` | low | Show one service's own keys and the methods on its prototype chain |
| `service.call` | medium | Call one method on one service; the result is snapshotted, and arguments must be plain data |
| `plugin.list` | low | List loader entries: id, package name, activation state |
| `config.edit` | high | Persist one plugin's configuration into the active profile patch and apply it |
| `plugin.restart` | high | Reload a plugin by id or package name; with no argument, reload this one |
| `app.exit` | high | Ask the launcher to shut the host down gracefully |
| `app.restart` | high | Relaunch the whole host: arm a detached relay, wait for its heartbeat, answer the caller, then take this process down |
| `app.restartState` | low | Report how this host can be relaunched, how much restart budget is left, and what the last relays did |

Every call returns an envelope, and **a capability failure is not an exception** — only a malformed request is:

```js
{ ok: true,  capability: 'service.call', caller: 'my-plugin', at: 1794203342454, ms: 3, value: { /* … */ } }
{ ok: false, capability: 'service.call', caller: 'my-plugin', at: 1794203342454, ms: 1, error: { code: 'service-denied', message: '…' } }
```

The codes are fixed, so callers can branch on them: `unknown-capability`, `confirmation-required`, `breaker-open`, `timeout`, `service-denied`, `service-not-allowed`, `method-denied`, `service-unavailable`, `no-such-method`, `no-such-plugin`, `bad-request`, `failed`.

## Four hard rules

**1. Destructive actions need an explicit confirmation.** `config.edit`, `plugin.restart`, `app.exit`, and `app.restart` sit on the `confirm` list; the caller must pass `{ confirm: true }` or it gets `confirmation-required` and the host is untouched. This is the guard against the "agent retries in a loop and restarts itself three times" class of accident.

**2. Answer first, move the lifecycle second.** Reload and exit are deferred to the next tick. The reason is concrete: a plugin that restarts itself synchronously inside its own call stack cuts the caller off mid-flight — no result, no error, a log that stops halfway. So these capabilities return `{ accepted: true, deferred: true }` instead of a result.

**3. The reachable set is inert by default.** `serviceDeny` closes process execution (`shell`, `subprocess`, `terminals`), the filesystem (`fs`, `workspace*`), plugin lifecycle and persistence (`loader`, `hmr`, `pluginManager`), and credential-bearing stores (`credentials`, `settings`, `storage`, `deepseekAccount`) — plus `configEditor` and the bridge itself. `serviceAllow`, when non-empty, inverts the question: only the names listed are reachable at all. And `methodDeny` is a second gate keyed by service (`*` for everything), so *un-denying* a service for one deployment does not automatically hand back `loader.update` / `loader.import` / `loader.remove`. A refusal is never counted by the circuit breaker: a mistyped service name is not evidence that the host is failing.

**4. Data crosses both ways.** Results go through `serialize.js`: functions become names, cycles stop at depth 3 (with the field names still reported), collections over 32 items carry a `truncated` marker, **any value under a field named `apiKey / secret / token / password / credential / authorization` is replaced with `«redacted»`, and so is any string that looks like a credential** (`sk-…`, `ghp_…`, `xox…-`, `AKIA…`, a JWT). Arguments get the mirror rule: `service.call` accepts plain cloneable data only. A function argument is how a caller smuggles a callback past every method-level check — `loader.import(name, getOuterStack)` takes one — and a live object argument is how it keeps a handle on host state after the call returns.

## Consuming the bridge from another plugin

The bridge is **optional infrastructure**: some machines have it in their profile bundles, some do not, and a consumer must work in both worlds. The failure modes are not symmetric — a missing service is silent, and the two obvious "checks" are both wrong.

**Do not declare it as a required injection.** `inject: ['dshBridge']` is a *required* dependency in cordis: without the service the fiber stays pending, `apply` never runs, and nothing is logged. The plugin looks installed and does nothing.

**Read it with `ctx.get`, once, and branch on `undefined`.** `ctx.get('dshBridge')` returns `undefined` for a missing service and never throws. Property access does throw (`cannot get property "dshBridge" without inject`), so `ctx.dshBridge` is not a probe.

**Keep the fallback free of the bridge.** The bridge governs *how* you reach a service; it does not grant the reach. Without it, `ctx.get(service)` still resolves — that is the fallback.

```js
const MINIMUM_VERSION = 2

/**
 * One call path: prefer the bridge, degrade to the raw service.
 * @param ctx - the consumer's plugin context.
 */
function createCaller(ctx) {
  const bridge = ctx.get('dshBridge') // undefined when the bridge is not installed
  const usable = bridge !== undefined
    && Number.isInteger(bridge.version)
    && bridge.version >= MINIMUM_VERSION
  const mode = usable ? 'bridge' : bridge === undefined ? 'native (not installed)' : 'native (too old)'

  async function callService(service, method, args = []) {
    if (usable) {
      const envelope = await bridge.invoke('service.call', { service, method, args })
      if (!envelope.ok) return { ok: false, via: 'bridge', error: envelope.error }
      return { ok: true, via: 'bridge', snapshot: true, value: envelope.value.value }
    }
    const target = ctx.get(service)
    if (target === undefined) {
      return { ok: false, via: 'native', error: { code: 'service-unavailable', message: `service "${service}" is not provided` } }
    }
    try {
      return { ok: true, via: 'native', snapshot: false, value: await target[method](...args) }
    } catch (error) {
      return { ok: false, via: 'native', error: { code: 'failed', message: String(error?.message ?? error) } }
    }
  }

  return { mode, usable, bridge, callService }
}

export function apply(ctx) {
  const { mode, callService } = createCaller(ctx)
  if (mode !== 'bridge') ctx.logger?.warn?.(`dsh-bridge unavailable: ${mode}`)
  // ... callService('SERVICE', 'METHOD', [args]) everywhere below
}
```

Three details that are not cosmetic:

- **`invoke`, not `call`.** `bridge.call(service, method, ...args)` is a convenience wrapper; `invoke` is what lets you read the envelope and branch on `error.code`.
- **`value` is unwrapped deliberately.** A `service.call` envelope carries `value: { service, method, value }`; the snapshot is the inner `value`. `snapshot: true` says the result went through redaction and truncation, so the two paths are *not* byte-identical — do not pretend they are.
- **The version gate is the contract check.** `version >= 2` is what guarantees `policy()`, the `allowed` field, and the deny/method gates. On an older bridge the adapter quietly takes the native path. `version >= 3` additionally means `app.restart` / `app.restartState` exist — gate a "restart now" action on the number, not on the plugin merely being present.

### Probing what this deployment allows

`service.call` still refuses per call, so a pre-flight is optional. When you need it (for a settings UI, or to pick a degraded mode), use the table and the policy, never a reimplementation of the gate logic:

```js
if (usable) {
  const capabilities = bridge.list()          // [{ name, risk, summary }]
  const policy = bridge.policy()              // resolved deny / allow / method rules
  const reachable = (name) => policy.serviceAllow.length > 0
    ? policy.serviceAllow.includes(name) && !policy.serviceDeny.includes(name)
    : !policy.serviceDeny.some((p) => name === p || name.startsWith(`${p}.`))
}
```

That is a coarse filter only. Do **not** reproduce the `methodDeny` merge semantics (`'*'` plus per-service keys); let the call answer, and branch on `method-denied`.

### Error codes → what to do

| code | meaning | action |
|---|---|---|
| `service-denied`, `service-not-allowed`, `method-denied` | refused by deployment policy before anything ran | degrade; retrying changes nothing |
| `bad-request` | arguments were functions, class instances, over-long, or circular | fix the caller |
| `confirmation-required` | capability needs `{ confirm: true }` | add the confirmation, or use the raw service |
| `no-such-method`, `no-such-plugin` | wrong name | `service.list` / `service.describe` first |
| `service-unavailable` | the host really lacks that service | degrade |
| `timeout`, `breaker-open`, `failed` | host-side fault, counts toward the breaker | back off; do not loop |

The native path never produces the first two rows — a missing bridge means no policy layer, which is exactly why the consumer must own the degraded behaviour.

### Waiting for a bridge that may arrive later

`ctx.inject(['dshBridge'], (ctx) => { … })` starts a nested fiber whose callback runs once the service is available. It is still *required* semantics: if the service never appears, the callback never runs. Use it for an additive feature ("use the audited path when present"), never for the plugin's main path.

### Anti-patterns

- `ctx.dshBridge` without an `inject` declaration → `cannot get property … without inject`.
- Assuming `policy()` / `allowed` / new codes exist → gate on `version`.
- Reaching the bridge through itself (`service.call { service: 'dshBridge' }`) → `service-denied`; the bridge is on its own deny list.
- Treating the bridge as a security boundary (see Honest limits).
- Adding `dsh-bridge` to the consumer's `dependencies` to "make sure it is there": profiles are per machine, and a bundle entry is not a dependency you control.

### Acceptance

Run the consumer in **two** profiles before calling it done:

1. Without `dsh-bridge` in `dsh.profile.bundles`: the plugin still activates, `mode` reports `native (not installed)`, and the fallback returns the same `{ ok, via, value }` shape.
2. With it: `mode` is `bridge`, a denied service returns `service-denied`, and a credential-shaped value comes back as `«redacted»`.

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
    auditFile: ~                # optional: append every call to this JSONL file
    confirm: [config.edit, plugin.restart, app.exit, app.restart]
    serviceDeny: [credentials, configEditor, dshBridge, loader, shell, fs, …]  # hard deny list, matched before anything runs
    serviceAllow: []            # non-empty = allowlist mode; deny still wins
    methodDeny:                 # second gate, keyed by service name or prefix
      '*': [apply, bind, call, constructor, dispose, exec, exit, import, kill, restart, spawn, stop, terminate]
      loader: [commit, create, ensureId, remove, resolveGroup, stop, update]
    breakerThreshold: 5         # consecutive host failures before short-circuiting
    breakerCooldownMs: 30000    # how long the breaker stays open
```

The full default deny list is in `src/policy.js`; the bundle layer ships the same values in `cordis.patch.yml`. Copy the whole row into your profile and edit the one entry you need — replacing the list wholesale silently re-opens everything you left out.

`credentials` is on the deny list by default, and not out of fussiness: that service hands back plaintext secrets, and once one has flowed through `service.call` into some plugin's result, there is no taking it back.

`configEditor` is there for a different reason — it **goes around the gate**. `config.edit` has a confirmation, a dry run, and a merge that does not pin defaults; `service.call('configEditor', 'edit', …)` has none of that and still writes to the user's profile patch. One path is enough.

`loader` is there because it is the same gate from the other side: `loader.update` / `create` / `remove` write through the loader's `commit()` into the profile patch, and `loader.import` loads an arbitrary module into the host process. Closing `configEditor` but leaving `loader` open would have moved the hole, not removed it.

`methodDeny` is what keeps a deliberate exception from becoming a new hole. Setting `serviceDeny: [credentials, configEditor, dshBridge]` (as an earlier version of this plugin shipped) re-opens `loader`, and the per-service rule set still refuses its mutators. An `'*'` entry in your own `methodDeny` replaces the global defaults; adding one service key does not — the defaults stay and the key replaces only that service's list.

## The restart capability (`app.restart`)

**The bridge provides the mechanism; it never decides that a restart is due.** That decision belongs to the caller,
which is the only party that knows whether its own work is finished and worth interrupting the session for. `dsh-purge`
is the first caller: patches written, `ensureRestartReady()` passed, then `ctx.get('dshBridge').restart('purge-panel')`.
The bridge then:

1. writes a plan (what to start, its cwd, which pid must go away first, which variables to scrub) under
   `$DSH_HOME/dsh-bridge/relaunch/`;
2. spawns `src/relay.js` with `process.execPath`, `detached: true` + `unref()` — it outlives this process;
3. waits for the relay's heartbeat (`<plan>.hb.json`): **no heartbeat cancels everything**, the host stays up;
4. answers the caller, then takes this process down after `restartDelayMs`:
   - Desktop: the host is an Electron **child**, and `DESKTOP_IPC` has no restart channel, so going down means
     terminating the parent that owns the window (`taskkill /PID <ppid> /F` on Windows, `SIGTERM` elsewhere). `appExit`
     is deliberately **not** used here: a graceful exit stops only the child, the main process respawns it, and the open
     window is left spinning on a dead origin — the exact failure this path exists to avoid.
   - web / stdio hosts: `appExit`, so the shutdown is graceful;
5. the relay waits for the old pid to disappear, waits out `relaySettleMs` (the single-instance lock), then starts the
   new instance with `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` **removed**.

Step 5 is not optional: the Desktop host runs in Electron's Node mode with `ELECTRON_RUN_AS_NODE=1` in its environment.
A child that inherits it starts the same executable as a plain Node program — no window, exits at once — while the log
says the relaunch succeeded.

Three limits: `restartBudget` / `restartWindowMs` (3 per 5 minutes by default) stop a caller's retry loop from
restarting the host over and over; `restartDryRun: true` writes the plan and the ledger entry without starting or
killing anything; and `app.restart` sits on the `confirm` list, so a caller must ask for it explicitly.
`app.restartState` reports the shutdown path, the remaining budget, and the relay log tail. Runtime files live in
`$DSH_HOME/dsh-bridge/` (`relay.log`, `restart-ledger.json`, `relaunch/*.plan.json`).

**If a restart does nothing, read `relay.log` first.** The host writes one line before it leaves —
`[host:shutdown] terminate <pid> → ok=…` — and the relay retries the kill 900 ms later if the target is
still alive, logging `[relay:killed] … ok=…`. A bracketed message after `ok=false` is Windows' own
reason (most often `Access is denied`); only `parent-exited` means the old app really began to go away.

Two codes belong to this chain rather than to `service.call`, and both mean "the host is fine":

- `restart-budget` — `restartBudget` restarts were already used inside `restartWindowMs`; wait the window out.
- `relay-unavailable` — the relay never beat, so **nothing was killed**; retry when the environment allows.

`bridge.restart(reason)` is the one-line form: it sends `{ confirm: true }` for you and returns the same receipt.

## Install

With Harness's own Plugin Manager (in Creator mode):

```js
plugin_manager({ action: 'install_bundle', target: 'D:/project/qujinting/dsh-plugins/dsh-bridge' })
```

`application: applied` is what means it took effect. Afterwards confirm via `cordis_inspect_query` that `dshBridge` is actually provided — not by reading logs or guessing.

Mounting by hand works too: copy the `insert` row from `cordis.patch.yml` into your profile's patch layer.

## Honest limits

**A Desktop restart kills the process that owns the window; it is not a graceful quit.** Application restart lives in the Electron main process (`DESKTOP_IPC` in `resources/app/lib/main.js` has no restart channel at all; `windowsMenu` only pops a menu, and `restartAppHostMenu` is mounted in `development` builds only), so no plugin — host or client — can reach it. `app.restart` therefore arms a detached relay first, proves it is alive by heartbeat, and only then terminates the parent that owns the window — deliberately ignoring `appExit`, which would stop only the host child and leave the window reconnecting to a process that is gone; the relay starts the new instance. The cost is real: the main process takes no exit path, so in-flight requests and unsaved renderer state are lost. Web and stdio hosts are not affected — `appExit` shuts those down gracefully. `plugin.restart` reloads a **plugin** through `fiber.restart()`, the same mechanism HMR and the config editor already use.

**`service.call` is the strongest form of coupling available.** It frees callers from knowing service names, but it also turns "what was called" into runtime behaviour that no compiler checks. Use it after `service.list` / `service.describe` has told you what is there, and wrap it in your own thin functions — one wrapper per method, as in the example above, rather than scattering `bridge.call` through business logic.

**The bridge is a governor, not a sandbox.** Any plugin in the same tree can already read `ctx.get('shell')` directly: cordis resolves a service by name without an `inject` declaration. `dshBridge` does not grant a capability that was not there; it makes the reach *discoverable* (one table, one policy) and *observable* (confirmation, timeout, breaker, audit). Treat it as the single reviewed door for the plugins you author — not as a boundary that contains a hostile plugin, which it cannot be from inside the same process.

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
| `loader` mutators persist through `commit()` into the profile patch | `.../dsh-app-boot/lib/index.js:806`, `.../cordis-plugin-loader/lib/index.js:293` |
| There is no restart IPC on the desktop side | `resources/app/lib/main.js:1445-1477` |
| The Desktop host is an Electron child and accepts only `shutdown` / `ready` / `fatal` over IPC | `.../dsh-desktop-host/lib/index.js:489`, `resources/app/lib/main.js:10007` |
| `ELECTRON_RUN_AS_NODE=1` is handed to every child of the Desktop host | `resources/app/lib/main.js:9748` |
| Extension-point selection and upgrade stability | `.../skills/cordis-plugin-development/references/practices.md` |

## Development

```bash
npm run check   # syntax check for the eight modules
npm test        # 81 cases: unit, adversarial, real-cordis integration, relay dry run, shutdown, kill
```

`test/hardening.test.mjs` is the regression suite for the boundary itself: default deny list, allowlist mode, method gate, argument validation, value redaction, audit file. `test/real-cordis.test.mjs` boots an actual `Context` from the installation (`DSH_APP_ROOT`, default `D:/apps/DSH/resources/app/dsh`) and drives the same capabilities through it; it skips when the installation is absent. `test/shutdown.test.mjs` pins which process a restart takes down — the window owner on the Desktop, `appExit` everywhere else — and `test/process-kill.test.mjs` kills a real child instead of mocking `taskkill`.

The remaining tests run on a hand-built fake context implementing only `get / provide / effect / reflect.props / fiber.restart / logger` — which is itself a promise: if the plugin ever needs more of the framework than that, it is coupling harder than it claims.

Zero dependencies: nothing is imported from `@deepseek-ai/*`, because a profile-installed plugin cannot resolve those, and this package has to survive a harness upgrade untouched.

## Not built yet

- `config.read` — read one plugin's current and inherited config. Technically trivial, but it would send whatever secrets the config holds across the boundary, so the redaction story has to come first.
- `event.emit` / waterfall injection — more dangerous than `service.call`, because it can change someone else's control flow. If it lands, it should be its own capability with its own allow list.

## License

MIT
