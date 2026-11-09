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

/** Defaults are the behaviour the README promises. Every field is optional. */
export const DEFAULTS = {
	timeoutMs: 15_000,
	auditLimit: 200,
	confirm: ['config.edit', 'plugin.restart', 'app.exit'],
	// `configEditor` is denied for `service.call` on purpose: reaching it that way
	// would bypass the confirmation gate and write to the user's profile patch.
	serviceDeny: ['credentials', 'configEditor', 'dshBridge'],
	breakerThreshold: 5,
	breakerCooldownMs: 30_000,
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
		breakerThreshold: positiveInt(source.breakerThreshold) ?? DEFAULTS.breakerThreshold,
		breakerCooldownMs: positiveInt(source.breakerCooldownMs) ?? DEFAULTS.breakerCooldownMs,
	}
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
