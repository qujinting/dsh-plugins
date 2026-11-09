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
 *    destructive ones, a timeout, and a circuit breaker, so one broken service
 *    cannot pin or spam the host.
 * 4. Configuration writes through the host's own editor, with the one rule the
 *    editor cannot express by itself: a field nobody touched and that still
 *    equals its inherited value is not copied into the user's patch, so bundle
 *    upgrades keep reaching it.
 * 5. An audit ring, so "who restarted this plugin at 14:02" is answerable
 *    without reading the session log.
 *
 * Two deliberate limits:
 *
 * - Nothing here restarts the desktop **application**. That action belongs to
 *   the Electron main process (`DESKTOP_IPC` exposes no restart channel) and is
 *   unreachable from a plugin by design. `plugin.restart` reloads a *plugin*
 *   through `fiber.restart()`, which is the mechanism HMR and the config editor
 *   already use.
 * - Values crossing the boundary are snapshots (`serialize.js`), never live
 *   service objects, so a consumer cannot keep a handle on host internals.
 *   Field names that promise a secret — `apiKey`, `token`, `password` — are
 *   replaced rather than carried, because a bridge that can call anything will
 *   eventually call something that holds one.
 *
 * Everything is dependency-free: no `@deepseek-ai/*` import, because a
 * profile-installed plugin cannot resolve those without a build-time runtime
 * link, and this package has to survive a harness upgrade untouched.
 *
 * @module dsh-bridge
 */

import { createCapabilities } from './capabilities.js'
import { Breaker, coded, describeError, readOptions, withTimeout } from './policy.js'

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
	 * @param row - the finished result envelope.
	 */
	function record(row) {
		audit.push(row)
		if (audit.length > options.auditLimit) audit.splice(0, audit.length - options.auditLimit)
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
			breaker.noteFailure(requested)
			return finish({ ok: false, error: describeError(error) })
		}
	}

	const api = {
		/** Contract version; consumers compare it before trusting a capability name. */
		version: 1,
		invoke,
		/** The capability table, for a consumer's own startup self-check. */
		list: () => capabilities.map(({ name: capability, risk, summary }) => ({ name: capability, risk, summary })),
		/** The recent audit trail, newest last. */
		audit: () => audit.slice(),
		/** Convenience for `service.call`, so the common case needs no params object. */
		call: (serviceName, method, ...args) => invoke('service.call', { service: serviceName, method, args }),
	}

	ctx.provide('dshBridge', api)
	ctx.effect(() => () => audit.splice(0), 'dsh-bridge.audit()')
	ctx.logger?.info?.(`dsh-bridge: ${capabilities.length} capabilities on offer`)
}
