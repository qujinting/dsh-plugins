/**
 * Relaunching the host, and the post-install restart that needs it.
 *
 * The Harness host is a **child** of whatever started it: `dsh-desktop-host`
 * runs as an Electron child process with an IPC channel, and `dsh web` runs as
 * the launcher's child. A plugin therefore cannot call `app.relaunch()` — it is
 * not in the process that owns the window — and it cannot respawn itself,
 * because its parent owns the spawn, not the plugin. What it *can* do is hand
 * the relaunch to a process that outlives it:
 *
 *   1. write a plan (what to start, where, which pid must go away first);
 *   2. spawn `relay.js` detached, so it survives this process;
 *   3. wait for the relay's first heartbeat — proof it is really running;
 *   4. only then take this process down (`appExit`, or the parent that owns the
 *      window on Desktop);
 *   5. the relay waits for the old pid to disappear, waits out the
 *      single-instance lock, and starts the new instance with the launcher
 *      environment scrubbed.
 *
 * Two rules are inherited from hard experience and are not negotiable:
 *
 * - **A missing heartbeat cancels the restart.** The worst outcome is "nothing
 *   happened this time", never "the application disappeared".
 * - **The relaunch environment must be scrubbed.** The Desktop host runs with
 *   `ELECTRON_RUN_AS_NODE=1`; a child that inherits it starts the same
 *   executable as a plain Node program — no window, no main process, exits at
 *   once, while every log line says the relaunch succeeded.
 *
 * @module dsh-bridge/relaunch
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { coded } from './policy.js'
import { forceKill, isAlive } from './process-kill.js'

/** The detached program this module spawns. */
export const RELAY_SOURCE = fileURLToPath(new URL('./relay.js', import.meta.url))

/** Environment carried from the host into the relaunched instance: never these. */
const DESKTOP_SCRUB = ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']

/** How long a finished plan file is kept before the next activation prunes it. */
const PLAN_RETENTION_MS = 24 * 60 * 60 * 1000

/** How long the host waits for the window owner to disappear before it leaves. */
export const TERMINATE_WAIT_MS = 3000

/**
 * The bridge's own state directory, next to the profile that installed it.
 * @param env - environment to read `DSH_HOME` from.
 * @returns absolute directory path.
 */
export function bridgeHome(env = process.env) {
	const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh')
	return join(home, 'dsh-bridge')
}

/**
 * Describe the process that would have to be started again.
 *
 * Recognising the Desktop host matters: relaunching `process.argv` there would
 * restart the *host child* alone — an application with no window — so the only
 * correct target is the executable that owns the window, with no arguments.
 * @param env - environment of the running host.
 * @returns the relaunch target for this host.
 */
export function describeHost(env = process.env) {
	const electronNode = env.ELECTRON_RUN_AS_NODE === '1'
	const forked = typeof process.send === 'function'

	if (electronNode && forked) {
		const exe = process.execPath
		return {
			kind: 'desktop-app',
			exe,
			args: [],
			cwd: dirname(exe),
			// The parent is Electron's main process: the window, the tray, the
			// single-instance lock and the relaunch all live there.
			waitedPid: process.ppid,
			graceful: false,
			scrub: [...DESKTOP_SCRUB],
		}
	}

	return {
		kind: 'process',
		exe: process.execPath,
		args: process.argv.slice(1),
		cwd: process.cwd(),
		waitedPid: process.pid,
		graceful: true,
		scrub: ['ELECTRON_RUN_AS_NODE'],
	}
}

/**
 * Build the plan file the relay reads.
 * @param input - host facts, resolved options, and which change triggered it.
 * @returns a JSON-serializable plan.
 */
export function planFor(input) {
	const { host, options, trigger } = input
	return {
		version: 1,
		trigger,
		createdAt: new Date().toISOString(),
		kind: host.kind,
		exe: host.exe,
		args: [...host.args],
		cwd: host.cwd,
		waitedPid: host.waitedPid,
		scrub: [...host.scrub],
		deadlineMs: options.relayDeadlineMs,
		settleMs: options.relaySettleMs,
		retry: options.relayRetry,
		retryDelayMs: 1200,
		dryRun: options.restartDryRun,
		log: join(bridgeHome(), 'relay.log'),
	}
}

/**
 * Read the restart ledger.
 *
 * The ledger exists for one failure mode: a restart that loops. A plugin that
 * cannot load, a bundle whose entry keeps failing, an install that re-reports
 * itself on every boot — all of them turn "restart after install" into "restart
 * forever". The budget bounds that in wall-clock time, so a loop stops even
 * when the state that causes it survives.
 * @param options - resolved bridge options.
 * @param now - clock injection for tests.
 * @returns the ledger and the budget left in the current window.
 */
export function readLedger(options, now = Date.now()) {
	const path = join(bridgeHome(), 'restart-ledger.json')
	let ledger
	try {
		ledger = JSON.parse(readFileSync(path, 'utf8'))
	} catch {
		ledger = undefined
	}

	const fresh = ledger === undefined || typeof ledger !== 'object' || !Number.isFinite(ledger.windowStart)
	if (fresh || now - ledger.windowStart > options.restartWindowMs) {
		return { path, windowStart: now, used: 0, left: options.restartBudget, entries: [] }
	}

	const used = Number.isSafeInteger(ledger.used) ? ledger.used : 0
	const entries = Array.isArray(ledger.entries) ? ledger.entries.slice(-20) : []
	return { path, windowStart: ledger.windowStart, used, left: Math.max(0, options.restartBudget - used), entries }
}

/**
 * Append one entry to the ledger, sliding the window when it has expired.
 * @param ledger - the current ledger.
 * @param entry - what happened, as plain data.
 * @param options - resolved bridge options.
 * @param now - clock injection for tests.
 */
export function writeLedger(ledger, entry, options, now = Date.now()) {
	const expired = now - ledger.windowStart > options.restartWindowMs
	const next = {
		windowStart: expired ? now : ledger.windowStart,
		used: (expired ? 0 : ledger.used) + (entry.counted === false ? 0 : 1),
		entries: [...(expired ? [] : ledger.entries), { at: new Date(now).toISOString(), ...entry }].slice(-20),
	}
	try {
		mkdirSync(dirname(ledger.path), { recursive: true })
		writeFileSync(ledger.path, JSON.stringify(next, null, '\t'), 'utf8')
	} catch {
		// A ledger that cannot be written must not block the restart itself: the
		// budget is a guard rail, not a precondition.
	}
	return next
}

/**
 * Remove plan files left by earlier activations.
 * @param now - clock injection for tests.
 */
export function prunePlans(now = Date.now()) {
	const dir = join(bridgeHome(), 'relaunch')
	try {
		for (const file of readdirSync(dir)) {
			const path = join(dir, file)
			const age = now - statSync(path).mtimeMs
			if (age > PLAN_RETENTION_MS) rmSync(path, { force: true })
		}
	} catch {
		// Nothing to prune on a fresh install.
	}
}

/**
 * Wait for the relay's heartbeat file.
 *
 * A heartbeat is the whole safety argument: it is written by the relay process
 * after it has started and read its plan, so its presence proves a live process
 * that will act when this one dies. Absence must cancel, not proceed.
 * @param planPath - the plan file the relay was handed.
 * @param ms - deadline.
 * @returns the first heartbeat the relay published.
 */
export async function waitForHeartbeat(planPath, ms) {
	const statePath = `${planPath}.hb.json`
	const end = Date.now() + ms
	while (Date.now() < end) {
		try {
			const beat = JSON.parse(readFileSync(statePath, 'utf8'))
			if (typeof beat?.phase === 'string') return beat
		} catch {
			// Not yet written.
		}
		await new Promise(resolve => setTimeout(resolve, 100))
	}
	return undefined
}

/**
 * Terminate the process that owns the window.
 *
 * Deliberately **not** a tree kill: the relay is spawned by this host as a
 * detached child, so it is a descendant of the process being terminated, and
 * `taskkill /T` would take the relay down with it — leaving a closed window and
 * nobody to open a new one. Renderers live in Electron's own job object, which
 * the OS closes with the main process.
 * @param pid - process to terminate.
 */
export function terminateProcess(pid) {
	return forceKill(pid)
}

/**
 * Build the restart controller a capability and the install watcher share.
 * @param input - host context, resolved options, a log sink, and test seams.
 * @returns `begin()` and `state()`.
 */
export function createRestarter(input) {
	const {
		ctx,
		options,
		log = () => {},
		spawnImpl = spawn,
		terminateImpl = terminateProcess,
		exitImpl = code => process.exit(code),
		describeHostImpl = describeHost,
		terminateWaitMs = TERMINATE_WAIT_MS,
		aliveImpl = isAlive,
	} = input

	/** One restart at a time: two relays fighting over one window is not a race worth having. */
	let inflight

	/**
	 * Write a shutdown decision where it can still be read after this process is
	 * gone. The host's own log dies with it, and `relay.log` is the file someone
	 * opens after a restart that "did nothing" — the kill outcome belongs there.
	 * @param message - one line, without a prefix.
	 */
	function logShutdown(message) {
		log(`dsh-bridge: ${message}`)
		try {
			appendFileSync(join(bridgeHome(), 'relay.log'), `${new Date().toISOString()} [host:shutdown] ${message}\n`, 'utf8')
		} catch {
			// Diagnostics only; never worth failing a shutdown over.
		}
	}

	/**
	 * Arm the relay, then take this process down on a later tick.
	 *
	 * The caller always receives its receipt first (`deferred: true`): a plugin
	 * that restarts the host inside its own call stack cuts the caller off with
	 * neither a result nor an error.
	 * @param request - `{ trigger }`, where trigger names the change that asked.
	 * @returns the acceptance receipt.
	 */
	async function begin(request = {}) {
		if (inflight !== undefined) return inflight
		inflight = arm(request)
		try {
			return await inflight
		} finally {
			inflight = undefined
		}
	}

	async function arm(request) {
		const trigger = typeof request.trigger === 'string' && request.trigger.length > 0 ? request.trigger : 'manual'
		const host = describeHostImpl()
		const ledger = readLedger(options)
		if (ledger.left <= 0) {
			throw coded(
				'restart-budget',
				`${options.restartBudget} restarts already used within ${options.restartWindowMs}ms; not arming another`,
			)
		}

		const plan = planFor({ host, options, trigger })
		const dir = join(bridgeHome(), 'relaunch')
		mkdirSync(dir, { recursive: true })
		const planPath = join(dir, `${Date.now()}-${Math.random().toString(16).slice(2, 10)}.plan.json`)
		writeFileSync(planPath, JSON.stringify(plan, null, '\t'), { encoding: 'utf8', mode: 0o600 })

		if (plan.dryRun) {
			writeLedger(ledger, { phase: 'dry-run', trigger, kind: host.kind, plan: basename(planPath), counted: false }, options)
			return {
				accepted: true,
				deferred: false,
				dryRun: true,
				mode: host.kind,
				trigger,
				plan: basename(planPath),
			}
		}

		const child = spawnImpl(process.execPath, [RELAY_SOURCE, planPath], {
			detached: true,
			stdio: 'ignore',
			windowsHide: true,
			cwd: dirname(planPath),
			env: { ...process.env },
		})
		try {
			child?.unref?.()
		} catch {
			// An unref failure only means the relay keeps this process alive.
		}

		const beat = await waitForHeartbeat(planPath, options.relayHeartbeatMs)
		if (beat === undefined) {
			try {
				child?.kill?.()
			} catch {
				// Detached already; killing is best-effort.
			}
			writeLedger(ledger, { phase: 'relay-silent', trigger, kind: host.kind, plan: basename(planPath), counted: false }, options)
			throw coded(
				'relay-unavailable',
				`the relaunch relay did not report within ${options.relayHeartbeatMs}ms; this host was left running`,
			)
		}

		writeLedger(ledger, { phase: 'armed', trigger, kind: host.kind, plan: basename(planPath) }, options)
		log(`dsh-bridge: relaunch armed (${host.kind}) by ${trigger}, relay ${String(child?.pid ?? beat.pid)} alive`)

		setTimeout(() => {
			try {
				shutdown(host)
			} catch (error) {
				log(`dsh-bridge: shutdown after arming failed: ${String(error?.message ?? error)}`)
			}
		}, options.restartDelayMs)

		return {
			accepted: true,
			deferred: true,
			mode: host.kind,
			trigger,
			plan: basename(planPath),
			relayPid: typeof child?.pid === 'number' ? child.pid : beat.pid,
			relayPhase: beat.phase,
			shutdownInMs: options.restartDelayMs,
		}
	}

	/**
	 * Take this process down so the relay can start a fresh one.
	 *
	 * Order matters, and the desktop case comes first for a reason found the hard
	 * way: a graceful `appExit` stops only the child that serves the UI's API.
	 * The window, the tray and the single-instance lock belong to the Electron
	 * main process, which then respawns that child — so the user sees a spinner
	 * and no window ever closes. On the desktop, therefore, `appExit` is
	 * deliberately ignored and the parent tree is terminated instead.
	 * @param host - the relaunch target description.
	 */
	function shutdown(host) {
		if (host.kind === 'desktop-app') {
			if (!options.desktopTerminate) {
				log('dsh-bridge: relay is waiting, but desktopTerminate is off; this app stays up')
				return
			}

			const result = terminateImpl(host.waitedPid) ?? {}
			logShutdown(`terminate ${host.waitedPid} → ok=${result.ok === true}${result.message === undefined ? '' : ` (${result.message})`}`)

			// Wait for the window owner to actually disappear before leaving: exiting
			// first hands the main process a window in which to respawn this host,
			// which is how a restart turns into "the service came back, the window
			// still spins". The relay retries the kill if this wait times out.
			const deadline = Date.now() + terminateWaitMs
			const settle = () => {
				const gone = !aliveImpl(host.waitedPid)
				if (gone || Date.now() >= deadline) {
					if (!gone) logShutdown(`${host.waitedPid} is still alive; leaving anyway, the relay retries`)
					try {
						exitImpl(0)
					} catch {
						// The parent's termination may already have taken this process.
					}
					return
				}
				setTimeout(settle, 100)
			}
			setTimeout(settle, 100)
			return
		}

		const exit = ctx.get?.('appExit')
		if (typeof exit === 'function') {
			exit(0)
			return
		}

		exitImpl(0)
	}

	/**
	 * Report what a restart would do here, and what it already did.
	 * @returns host facts, budget, and the recent ledger window.
	 */
	function state() {
		const host = describeHostImpl()
		const ledger = readLedger(options)
		const exit = ctx.get?.('appExit')
		return {
			host: {
				kind: host.kind,
				exe: host.exe,
				args: host.args,
				waitedPid: host.waitedPid,
				// A host without a graceful exit must be terminated to be restarted.
				shutdown:
					host.kind === 'desktop-app'
						? options.desktopTerminate
							? 'terminate-parent'
							: 'unavailable'
						: typeof exit === 'function'
							? 'graceful'
							: 'self-exit',
			},
			budget: { used: ledger.used, left: ledger.left, windowStart: new Date(ledger.windowStart).toISOString(), windowMs: options.restartWindowMs },
			recent: ledger.entries.slice(-8),
			relaunchLog: tailLines(join(bridgeHome(), 'relay.log'), 12),
		}
	}

	return { begin, state }
}

/**
 * Read the tail of a log file without loading it.
 * @param path - log path.
 * @param lines - how many trailing lines to keep.
 * @returns the trailing lines, or an empty array.
 */
function tailLines(path, lines) {
	try {
		const text = readFileSync(path, 'utf8')
		return text.trimEnd().split('\n').slice(-lines)
	} catch {
		return []
	}
}

/**
 * Whether a plan file exists for a finished relay (used by tests and diagnostics).
 * @param planPath - plan path to inspect.
 * @returns `true` when the relay published any phase.
 */
export function relayed(planPath) {
	return existsSync(`${planPath}.hb.json`)
}
