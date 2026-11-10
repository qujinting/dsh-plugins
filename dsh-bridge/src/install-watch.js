/**
 * The post-install restart hook.
 *
 * A bundle install is applied by `plugin-manager`. When the result is
 * `restart-required` — no HMR in this profile, a moved package, a host-side
 * module, an unmanaged plugin — the host cannot load the new entry inside the
 * running process. Upstream's answer at that point is a sentence for the agent
 * to repeat: *"Tell the user to restart DSH to apply this change."* On the
 * Desktop app that means: quit, find the icon again, reopen.
 *
 * This module replaces that sentence with the action, without patching anything
 * the host owns. `plugin-manager` publishes every change twice — as
 * `plugin-manager/changed` (a bare reason) and as `plugin-manager/operation`
 * (the settled record, including `application`, `restartReason`, `target`) —
 * and cordis keeps one event bus for the whole context tree, so a plugin can
 * listen. A settled `restart-required` record is then exactly the signal that
 * the host is about to ask a human for work it can do itself.
 *
 * Three limits, each deliberate:
 *
 * - **`changed` must be true.** A record that reports a required restart but
 *   touched nothing on disk has nothing to apply; restarting for it would be a
 *   loop with extra steps.
 * - **One restart per settle, and a wall-clock budget.** The ledger in
 *   `relaunch.js` bounds the loop that a failing bundle would otherwise cause
 *   across boots.
 * - **Nothing is thrown into the host's dispatch.** A listener registered on
 *   `plugin-manager/operation` runs inside the host's own `parallel()` call, so
 *   a rejection there would surface as a plugin-manager failure. Failures are
 *   logged and the bridge stays quiet.
 *
 * @module dsh-bridge/install-watch
 */

/** The host event carrying one settled plugin-manager operation. */
export const INSTALL_OPERATION_EVENT = 'plugin-manager/operation'

/**
 * Decide whether one operation record should trigger a restart.
 *
 * Pure on purpose: every reason a restart is *not* armed is a named outcome, so
 * the decision can be tested without a host, and so a log line can say which
 * rule refused.
 * @param record - the operation record the host published.
 * @param options - resolved bridge options.
 * @param seen - `{ seen: Set<string>, armed: boolean }` state for this activation.
 * @returns `{ take: true, … }` or `{ take: false, why }`.
 */
export function decideRestart(record, options, seen) {
	if (!options.restartOnInstall) return { take: false, why: 'disabled' }
	if (record === null || typeof record !== 'object') return { take: false, why: 'not-an-operation' }
	if (record.phase !== 'settled') return { take: false, why: 'not-settled' }
	if (record.application !== 'restart-required') return { take: false, why: 'no-restart-required' }
	if (record.changed !== true) return { take: false, why: 'nothing-changed' }

	const reason = typeof record.reason === 'string' ? record.reason : 'unknown'
	if (!options.restartOnInstallReasons.includes(reason)) return { take: false, why: 'reason-filtered' }

	const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : undefined
	if (id !== undefined && seen.seen.has(id)) return { take: false, why: 'duplicate' }
	if (seen.armed) return { take: false, why: 'already-armed' }

	return {
		take: true,
		id,
		reason,
		target: typeof record.target === 'string' ? record.target : null,
		restartReason: typeof record.restartReason === 'string' ? record.restartReason : null,
		stage: typeof record.stage === 'string' ? record.stage : null,
	}
}

/**
 * Subscribe to the host's operation feed and restart when an install needs it.
 * @param input - host context, resolved options, the restarter, and a log sink.
 * @returns a disposer that unsubscribes.
 */
export function watchInstallRestart(input) {
	const { ctx, options, restarter, log = () => {} } = input
	if (!options.restartOnInstall) return () => {}
	if (typeof ctx?.on !== 'function') return () => {}

	const seen = { seen: new Set(), armed: false }

	const listener = record => {
		const decision = decideRestart(record, options, seen)
		if (!decision.take) return

		seen.armed = true
		if (decision.id !== undefined) seen.seen.add(decision.id)

		// The listener runs inside the host's dispatch: never let it reject.
		Promise.resolve()
			.then(() =>
				restarter.begin({
					trigger: `install:${decision.reason}${decision.target === null ? '' : `:${decision.target}`}`,
					detail: decision,
				}),
			)
			.then(receipt => {
				if (receipt?.dryRun === true) return
				log(
					`dsh-bridge: ${decision.reason} of ${decision.target ?? 'a bundle'} needs a restart (${decision.restartReason ?? 'unknown'}); relay armed, host goes down in ${receipt?.shutdownInMs ?? '?'}ms`,
				)
			})
			.catch(error => {
				seen.armed = false
				log(`dsh-bridge: post-install restart not armed: ${String(error?.message ?? error)}`)
			})
	}

	let dispose
	try {
		dispose = ctx.on(INSTALL_OPERATION_EVENT, listener)
	} catch (error) {
		log(`dsh-bridge: cannot watch ${INSTALL_OPERATION_EVENT}: ${String(error?.message ?? error)}`)
		return () => {}
	}

	return () => {
		try {
			if (typeof dispose === 'function') dispose()
		} catch {
			// The fiber may already be gone.
		}
	}
}
