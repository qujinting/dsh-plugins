/**
 * dsh-bridge — one audited door between plugins and the Harness host.
 *
 * Harness is "everything is a plugin": every capability lives on a cordis
 * context, and a plugin that wants one has to know the exact service name, the
 * exact method, and the exact argument shape — facts that live in `lib/types`
 * and READMEs of individual packages, not in any published contract. Most
 * plugins therefore either re-derive those facts (and break on upgrade) or
 * never reach the capability at all.
 *
 * This package turns that ad-hoc reaching into one place:
 *
 * 1. A single service, `dshBridge`, provided on the host context. Callers
 *    `inject: ['dshBridge']`; they never name a host internals path.
 * 2. A capability table (`capabilities.js`) that decides what is reachable at
 *    all. Adding a capability is a code change here, not a new coupling in
 *    every consumer.
 * 3. Policy around every call (`policy.js`): a confirmation gate for the
 *    destructive ones, a deny/allow set for services, a method gate for the
 *    services a deployment deliberately re-opens, a timeout, and a circuit
 *    breaker, so one broken service cannot pin or spam the host.
 * 4. Configuration writes through the host's own editor, with the one rule the
 *    editor cannot express by itself: a field nobody touched and that still
 *    equals its inherited value is not copied into the user's patch, so bundle
 *    upgrades keep reaching it.
 * 5. An audit ring (and an opt-in JSONL file), so "who restarted this plugin at
 *    14:02" is answerable without reading the session log.
 *
 * Two deliberate limits:
 *
 * - Nothing here restarts the desktop **application**. That action belongs to
 *   the Electron main process (`DESKTOP_IPC` exposes no restart channel) and is
 *   unreachable from a plugin by design. `plugin.restart` reloads a *plugin*
 *   through `fiber.restart()`, which is the mechanism HMR and the config editor
 *   already use.
 * - Values crossing the boundary are snapshots (`serialize.js`), and arguments
 *   must be plain data: a consumer keeps no handle on host internals and cannot
 *   hand one back in. Field names that promise a secret — `apiKey`, `token`,
 *   `password` — and strings shaped like one are replaced rather than carried,
 *   because a bridge that can call anything will eventually call something that
 *   holds one.
 *
 * Everything is dependency-free: no `@deepseek-ai/*` import, because a
 * profile-installed plugin cannot resolve those without a build-time runtime
 * link, and this package has to survive a harness upgrade untouched.
 *
 * @module dsh-bridge
 */

import { appendFile } from 'node:fs'

import { createCapabilities } from './capabilities.js'
import { Breaker, coded, describeError, readOptions, withTimeout } from './policy.js'

/**
 * Error codes that mean "this call was refused", never "the host is failing".
 *
 * The breaker exists to stop an agent from retrying a broken service in a loop.
 * A misspelled method or a denied service is the caller's bug, and the host is
 * perfectly healthy, so it must not spend the capability's availability on it.
 */
const GATE_CODES = new Set([
	'bad-request',
	'breaker-open',
	'confirmation-required',
	'method-denied',
	'no-such-method',
	'no-such-plugin',
	'service-denied',
	'service-not-allowed',
])

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-bridge'

/**
 * The bridge needs no service to activate. The three it *uses* — `loader`,
 * `appExit`, and whatever a caller asks for — are read with `ctx.get` at call
 * time, so a composition without them keeps a working bridge whose affected
 * capabilities report `service-unavailable` instead of failing the whole tree.
 */
export const inject = []

/**
 * Provide `dshBridge` on the host context.
 * @param ctx - the plugin context.
 * @param config - the composition entry's configuration.
 */
export function apply(ctx, config) {
	const options = readOptions(config)
	const breaker = new Breaker({
		threshold: options.breakerThreshold,
		cooldownMs: options.breakerCooldownMs,
	})

	/** Bounded audit trail; the oldest row is dropped when the limit is reached. */
	const audit = []

	/**
	 * Record one call.
	 *
	 * The ring is for `audit()` during this activation; the file, when
	 * configured, is what survives the reload the audit trail most needs to
	 * explain. A failed append is swallowed: the bridge must not fail a call
	 * because the disk is full or the path rotated away.
	 * @param row - the finished result envelope.
	 */
	function record(row) {
		audit.push(row)
		if (audit.length > options.auditLimit) audit.splice(0, audit.length - options.auditLimit)
		if (options.auditFile !== undefined) {
			appendFile(options.auditFile, `${JSON.stringify(row)}\n`, 'utf8', () => {})
		}
	}

	/**
	 * Run `run` on the next tick instead of on the caller's stack.
	 *
	 * This is the rule that makes destructive capabilities safe: a plugin that
	 * reloads itself has to answer the caller first, or the caller is cut off
	 * with no result and no error. Deferring also keeps the reload out of the
	 * middle of whatever the caller was doing.
	 * @param run - the lifecycle action.
	 * @param label - audit label naming what was deferred.
	 * @returns the acceptance receipt the caller receives.
	 */
	function defer(run, label) {
		setTimeout(() => {
			try {
				run()
			} catch {
				// The fiber may already be gone; the host owns this failure.
			}
		}, 0)
		return { accepted: true, deferred: true, label }
	}

	const capabilities = createCapabilities({ ctx, options, defer, selfName: name })

	/**
	 * Run one capability and return its result envelope.
	 * @param capability - capability name.
	 * @param params - capability-specific parameters.
	 * @param meta - caller information used by the audit trail.
	 * @returns a result envelope; capability failures are reported here rather than thrown.
	 */
	async function invoke(capability, params = {}, meta = {}) {
		const startedAt = Date.now()
		const caller = typeof meta?.caller === 'string' && meta.caller.length > 0 ? meta.caller : 'unknown'
		const requested = typeof capability === 'string' ? capability : String(capability)

		const finish = row => {
			const envelope = { at: startedAt, caller, capability: requested, ms: Date.now() - startedAt, ...row }
			record(envelope)
			return envelope
		}

		const entry = capabilities.find(item => item.name === requested)
		if (entry === undefined) {
			return finish({ ok: false, error: { code: 'unknown-capability', message: `no capability "${requested}"` } })
		}

		try {
			breaker.assertClosed(requested)
			if (options.confirm.includes(requested) && params?.confirm !== true) {
				throw coded('confirmation-required', `capability "${requested}" requires { confirm: true }`)
			}
			const value = await withTimeout(
				Promise.resolve(entry.run(params ?? {}, caller)),
				options.timeoutMs,
				requested,
			)
			breaker.noteSuccess(requested)
			return finish({ ok: true, value })
		} catch (error) {
			// A refusal is not a fault. Counting policy rejections would let five
			// mistyped service names shut the capability for the whole cooldown,
			// and would keep re-arming the window while a caller probes — so only
			// failures that actually crossed into the host open the breaker.
			if (!GATE_CODES.has(error?.code)) breaker.noteFailure(requested)
			return finish({ ok: false, error: describeError(error) })
		}
	}

	const api = {
		/**
		 * Contract version; consumers compare it before trusting a capability name.
		 *
		 * 2 added the `serviceAllow` / `methodDeny` gates, made caller arguments
		 * plain-data only, and closed the default reachable set to inert services.
		 */
		version: 2,
		invoke,
		/** The capability table, for a consumer's own startup self-check. */
		list: () => capabilities.map(({ name: capability, risk, summary }) => ({ name: capability, risk, summary })),
		/** The resolved policy, so a consumer can see what this deployment allows. */
		policy: () => structuredClone({ ...options, serviceDeny: [...options.serviceDeny], serviceAllow: [...options.serviceAllow], confirm: [...options.confirm] }),
		/** The recent audit trail, newest last. */
		audit: () => audit.slice(),
		/** Convenience for `service.call`, so the common case needs no params object. */
		call: (serviceName, method, ...args) => invoke('service.call', { service: serviceName, method, args }),
	}

	ctx.provide('dshBridge', api)
	ctx.effect(() => () => audit.splice(0), 'dsh-bridge.audit()')
	ctx.logger?.info?.(`dsh-bridge: ${capabilities.length} capabilities on offer`)
}
