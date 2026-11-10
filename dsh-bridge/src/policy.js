/**
 * Policy for dsh-bridge: option projection, error codes, timeouts, and the
 * per-capability circuit breaker.
 *
 * These pieces are separate from `capabilities.js` because they answer a
 * different question: capabilities say *what* the bridge can reach, policy says
 * *whether this call is allowed to reach it*. Keeping them apart means a new
 * capability cannot accidentally opt out of the guard.
 *
 * @module dsh-bridge/policy
 */

/**
 * Defaults are the behaviour the README promises. Every field is optional.
 *
 * The deny list is the load-bearing one. `service.call` runs whatever method a
 * caller names on whatever service it names, so the default posture is that the
 * reachable set is *inert*: reading, listing, querying. Anything that can end a
 * process, rewrite a plugin row, touch the filesystem, or hand back a stored
 * credential is closed, because those are exactly the capabilities that made a
 * generic call gateway dangerous in the first place.
 *
 * The three entries this list once had — `credentials`, `configEditor`,
 * `dshBridge` — closed the front door and left the side ones open: `loader` can
 * add, retarget, and remove plugin rows (and its `commit()` persists them to the
 * profile patch), `shell` and `subprocess` run programs, `fs` writes files.
 */
export const DEFAULTS = {
	timeoutMs: 15_000,
	auditLimit: 200,
	confirm: ['config.edit', 'plugin.restart', 'app.exit', 'app.restart'],
	serviceDeny: [
		// Secrets and configuration ownership.
		'credentials',
		'configEditor',
		'dshBridge',
		// Plugin lifecycle and persistence.
		'loader',
		'hmr',
		'pluginManager',
		// Process execution.
		'shell',
		'subprocess',
		'terminals',
		// Filesystem.
		'fs',
		'workspaceFiles',
		'workspaceChanges',
		'worktrees',
		'workspaceRegistry',
		// Confinement.
		'sandbox',
		'sandboxPolicy',
		// Stores that hold user data and keys.
		'settings',
		'storage',
		'storageDomain',
		'spillStore',
		'deepseekAccount',
		// Transport and remote control.
		'webServer',
		'remoteAccess',
		'liveshareShares',
	],
	// Non-empty means "allowlist mode": only these names are reachable, whatever
	// the deny list says. An operator who wants three services should not have to
	// reason about thirty.
	serviceAllow: [],
	// Method-level second gate, keyed by service name (exact or prefix, `*` for
	// every service). It exists so that re-enabling a denied service — for example
	// `loader` for one deployment — does not re-open its mutators with it.
	methodDeny: {
		'*': ['apply', 'bind', 'call', 'constructor', 'dispose', 'exec', 'exit', 'import', 'kill', 'restart', 'spawn', 'stop', 'terminate'],
		loader: ['commit', 'create', 'ensureId', 'remove', 'resolveGroup', 'stop', 'update'],
		hmr: ['invalidate', 'runExclusive', 'update'],
	},
	breakerThreshold: 5,
	breakerCooldownMs: 30_000,
	// Opt-in: when set, every call is also appended to this file as one JSON line,
	// because the in-memory ring dies with the activation that explains it.
	auditFile: undefined,

	// Post-install restart. The hook listens to `plugin-manager/operation`; when
	// a settled record reports `restart-required`, the bridge does what upstream
	// asks the agent to say — it restarts. That is on by default because it is
	// the whole point of the capability, and it is bounded by `restartBudget`
	// per `restartWindowMs` so a bundle that fails to load cannot turn every
	// boot into another restart.
	restartOnInstall: true,
	// Which plugin-manager reasons may restart unattended. `remove` is included:
	// uninstalling a bundle needs the same reload that installing one does.
	restartOnInstallReasons: ['install', 'remove', 'plugin', 'bundle'],
	// The relay must prove it is alive within this window, or the host stays up.
	relayHeartbeatMs: 4_000,
	// Upper bound on waiting for the old pid to disappear before launching anyway.
	relayDeadlineMs: 120_000,
	// Grace before the launch: the old instance may still hold the single-instance lock.
	relaySettleMs: 1_500,
	relayRetry: 3,
	// How long after the receipt the host goes down, so the caller sees its answer.
	restartDelayMs: 250,
	restartBudget: 3,
	restartWindowMs: 300_000,
	// Desktop only: the window owner is this process' parent, and no IPC channel
	// asks it to quit, so a restart means terminating it after the relay is up.
	desktopTerminate: true,
	// Writes the plan and reports what it would do; starts nothing, kills nothing.
	restartDryRun: false,
}

/**
 * Project the loader-validated config onto plain values with defaults.
 *
 * A partial or absent config is the normal case: rows often carry only the
 * fields they care about, so anything that fails its guard falls back instead of
 * throwing during activation.
 * @param config - the composition entry's configuration, as validated by the loader.
 * @returns resolved bridge options.
 */
export function readOptions(config) {
	const source = config !== null && typeof config === 'object' ? config : {}
	return {
		timeoutMs: positiveInt(source.timeoutMs) ?? DEFAULTS.timeoutMs,
		auditLimit: positiveInt(source.auditLimit) ?? DEFAULTS.auditLimit,
		confirm: stringList(source.confirm) ?? [...DEFAULTS.confirm],
		serviceDeny: stringList(source.serviceDeny) ?? [...DEFAULTS.serviceDeny],
		serviceAllow: stringList(source.serviceAllow) ?? [...DEFAULTS.serviceAllow],
		methodDeny: mergeMethodRules(source.methodDeny),
		auditFile: nonEmptyString(source.auditFile),
		breakerThreshold: positiveInt(source.breakerThreshold) ?? DEFAULTS.breakerThreshold,
		breakerCooldownMs: positiveInt(source.breakerCooldownMs) ?? DEFAULTS.breakerCooldownMs,
		restartOnInstall: booleanValue(source.restartOnInstall, DEFAULTS.restartOnInstall),
		restartOnInstallReasons: stringList(source.restartOnInstallReasons) ?? [...DEFAULTS.restartOnInstallReasons],
		relayHeartbeatMs: positiveInt(source.relayHeartbeatMs) ?? DEFAULTS.relayHeartbeatMs,
		relayDeadlineMs: positiveInt(source.relayDeadlineMs) ?? DEFAULTS.relayDeadlineMs,
		relaySettleMs: nonNegativeInt(source.relaySettleMs) ?? DEFAULTS.relaySettleMs,
		relayRetry: positiveInt(source.relayRetry) ?? DEFAULTS.relayRetry,
		restartDelayMs: nonNegativeInt(source.restartDelayMs) ?? DEFAULTS.restartDelayMs,
		restartBudget: positiveInt(source.restartBudget) ?? DEFAULTS.restartBudget,
		restartWindowMs: positiveInt(source.restartWindowMs) ?? DEFAULTS.restartWindowMs,
		desktopTerminate: booleanValue(source.desktopTerminate, DEFAULTS.desktopTerminate),
		restartDryRun: booleanValue(source.restartDryRun, DEFAULTS.restartDryRun),
	}
}

/**
 * A boolean config field, falling back when the value is not a boolean.
 * @param value - raw config field.
 * @param fallback - default to use.
 * @returns the boolean.
 */
function booleanValue(value, fallback) {
	return typeof value === 'boolean' ? value : fallback
}

/**
 * An integer greater than or equal to zero.
 * @param value - raw config field.
 * @returns the integer, or `undefined` when absent or unusable.
 */
function nonNegativeInt(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Test one service name against a pattern list.
 *
 * A pattern matches itself and everything below it: `loader` also covers
 * `loader.entries`, which is how cordis names nested provisions.
 * @param patterns - service names or prefixes.
 * @param name - service name from the request.
 * @returns `true` when the name is covered.
 */
export function deniedBy(patterns, name) {
	return patterns.some(pattern => name === pattern || name.startsWith(`${pattern}.`))
}

/**
 * Collect the method names a service is not allowed to expose.
 *
 * `*` applies to every service; a key equal to the service name or a prefix of
 * it adds that service's own rules on top.
 * @param rules - `methodDeny` from the resolved options.
 * @param name - service name from the request.
 * @returns the union of matching method names.
 */
export function methodRulesFor(rules, name) {
	const banned = new Set(rules['*'] ?? [])
	for (const [pattern, methods] of Object.entries(rules)) {
		if (pattern === '*') continue
		if (name === pattern || name.startsWith(`${pattern}.`)) {
			for (const method of methods) banned.add(method)
		}
	}
	return banned
}

/**
 * Build an Error carrying a stable machine-readable code.
 * @param code - the code consumers branch on, such as `confirmation-required`.
 * @param message - human-readable detail.
 * @returns the tagged error.
 */
export function coded(code, message) {
	const error = new Error(message)
	error.code = code
	return error
}

/**
 * Reduce a thrown value to the shape the result envelope carries.
 *
 * The bridge never forwards a raw error object: its stack belongs to the host
 * and its `code` may be an internal cordis code that means nothing to a caller.
 * @param error - whatever a capability threw.
 * @returns code and message only.
 */
export function describeError(error) {
	if (error === null || typeof error !== 'object') return { code: 'failed', message: String(error) }
	return {
		code: typeof error.code === 'string' ? error.code : 'failed',
		message: typeof error.message === 'string' ? error.message : String(error),
	}
}

/**
 * Reject a promise that settles later than `ms`.
 *
 * A capability that calls into another plugin has no idea whether that plugin
 * ever settles. The bridge must, or one hung service call would pin the caller
 * forever with no diagnostic.
 * @param promise - the work to bound.
 * @param ms - the deadline in milliseconds; non-positive disables the bound.
 * @param label - capability name used in the timeout message.
 * @returns the promise's value, or a `timeout` error.
 */
export function withTimeout(promise, ms, label) {
	if (!Number.isFinite(ms) || ms <= 0) return promise
	return new Promise((resolve, reject) => {
		// Deliberately not unref'd: a deadline that cannot fire because nothing
		// else holds the loop open would turn "bounded" into "hangs forever".
		const timer = setTimeout(() => reject(coded('timeout', `capability "${label}" exceeded ${ms}ms`)), ms)
		promise.then(
			value => {
				clearTimeout(timer)
				resolve(value)
			},
			error => {
				clearTimeout(timer)
				reject(error)
			},
		)
	})
}

/**
 * Per-capability circuit breaker.
 *
 * The point is not to punish a caller but to protect the host: an agent that
 * retries a broken capability in a loop would otherwise spend every step
 * re-entering a service that is already failing. After `threshold` consecutive
 * failures the capability stays shut for `cooldownMs`, and the next attempt
 * after the cooldown probes it once more.
 */
export class Breaker {
	#threshold
	#cooldownMs
	#states = new Map()

	/**
	 * @param options - threshold and cooldown, already defaulted.
	 */
	constructor({ threshold, cooldownMs }) {
		this.#threshold = threshold
		this.#cooldownMs = cooldownMs
	}

	/**
	 * Throw when the capability is currently short-circuited.
	 * @param capability - capability name.
	 */
	assertClosed(capability) {
		const state = this.#states.get(capability)
		if (state === undefined || state.failures < this.#threshold) return
		if (Date.now() - state.openedAt < this.#cooldownMs) {
			throw coded('breaker-open', `capability "${capability}" is short-circuited for ${this.#cooldownMs}ms`)
		}
		this.#states.delete(capability)
	}

	/**
	 * Record one failure and open the breaker once the threshold is reached.
	 * @param capability - capability name.
	 */
	noteFailure(capability) {
		const state = this.#states.get(capability) ?? { failures: 0, openedAt: 0 }
		state.failures += 1
		state.openedAt = Date.now()
		this.#states.set(capability, state)
	}

	/**
	 * Clear the failure count after a success.
	 * @param capability - capability name.
	 */
	noteSuccess(capability) {
		this.#states.delete(capability)
	}
}

/**
 * An integer strictly greater than zero.
 * @param value - raw config field.
 * @returns the integer, or `undefined` when absent or unusable.
 */
function positiveInt(value) {
	return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * An array of non-empty strings.
 * @param value - raw config field.
 * @returns the array, or `undefined` when it is not one.
 */
function stringList(value) {
	if (!Array.isArray(value)) return undefined
	if (!value.every(item => typeof item === 'string' && item.length > 0)) return undefined
	return [...value]
}

/**
 * A non-empty string, or `undefined`.
 * @param value - raw config field.
 * @returns the string, or `undefined` when absent or unusable.
 */
function nonEmptyString(value) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Validate the method-deny table into a copy with array values.
 *
 * A malformed table falls back to the defaults rather than throwing during
 * activation: a plugin that cannot start because of one typo is worse than a
 * plugin that starts with its documented policy.
 * @param value - raw config field.
 * @returns the normalized table, or `undefined` when unusable.
 */
function methodRules(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
	const rules = {}
	for (const [pattern, methods] of Object.entries(value)) {
		if (pattern.length === 0) return undefined
		const list = stringList(methods)
		if (list === undefined) return undefined
		rules[pattern] = list
	}
	return rules
}

/**
 * Layer the configured method rules over the defaults.
 *
 * A deployment that adds `{ db: ['drop'] }` very much still wants the `*` rules,
 * and would not guess that writing one service key silently dropped them. So the
 * defaults stay, a configured key replaces (not appends to) the default entry of
 * the same name, and only an explicit `'*'` key can replace the global rules.
 * @param value - raw config field.
 * @returns the merged table.
 */
function mergeMethodRules(value) {
	const rules = cloneRules(DEFAULTS.methodDeny)
	const configured = methodRules(value)
	if (configured === undefined) return rules
	for (const [pattern, methods] of Object.entries(configured)) rules[pattern] = methods
	return rules
}

/**
 * Deep-copy the method-deny table so a mutating caller cannot change the next instance.
 * @param rules - the default table.
 * @returns a detached copy.
 */
function cloneRules(rules) {
	const copy = {}
	for (const [pattern, methods] of Object.entries(rules)) copy[pattern] = [...methods]
	return copy
}
