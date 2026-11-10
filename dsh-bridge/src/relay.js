/**
 * The detached relay: the process that survives the one it is restarting.
 *
 * It runs as its own program (spawned by `relaunch.js`) because the host cannot
 * restart itself — its parent owns the spawn, and in the Desktop app the parent
 * also owns the window. So the relay waits for the old pid to disappear, waits
 * out the single-instance lock, and starts the fresh instance.
 *
 * Three properties matter and each one is a scar:
 *
 * 1. **It reports before it acts.** Every phase is written to
 *    `<plan>.hb.json`, and the host refuses to go down without a heartbeat. A
 *    relay that cannot start therefore costs one restart, not the session.
 * 2. **It launches with a scrubbed environment.** `ELECTRON_RUN_AS_NODE` and
 *    `NODE_OPTIONS` are removed: inherited, they turn the Desktop executable
 *    into a plain Node program that opens no window and exits immediately.
 * 3. **It waits, then retries.** The old instance may hold the single-instance
 *    lock for a moment after it exits; a launch that loses that race is
 *    silent, so `start` is attempted a few times with a delay.
 *
 * @module dsh-bridge/relay
 */

import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'

import { forceKill, isAlive } from './process-kill.js'

/** Maximum size of the relay log before it is truncated. */
const LOG_LIMIT = 256 * 1024

/** How often the relay re-checks whether the old pid is gone. */
const POLL_MS = 120

/** Grace before the relay retries the host's kill: the receipt needs to flush. */
const KILL_GRACE_MS = 900

const planPath = process.argv[2]
if (typeof planPath !== 'string' || planPath.length === 0) {
	console.error('dsh-bridge relay: a plan file argument is required')
	process.exit(2)
}

let plan
try {
	plan = JSON.parse(readFileSync(planPath, 'utf8'))
} catch (error) {
	console.error(`dsh-bridge relay: unreadable plan ${planPath}: ${String(error?.message ?? error)}`)
	process.exit(2)
}

const statePath = `${planPath}.hb.json`

/**
 * Publish this relay's phase, durably and atomically enough for a poller.
 * @param phase - machine-readable phase name.
 * @param extra - plain data to carry with it.
 */
function beat(phase, extra = {}) {
	const row = { phase, at: new Date().toISOString(), pid: process.pid, ...extra }
	try {
		writeFileSync(statePath, JSON.stringify(row), 'utf8')
	} catch {
		// The host polls this file; failing to write it only means "no heartbeat".
	}
	record(phase, extra)
}

/**
 * Append one line to the relay log, truncating it when it grows too large.
 * @param phase - phase name.
 * @param extra - plain data.
 */
function record(phase, extra) {
	if (typeof plan.log !== 'string' || plan.log.length === 0) return
	try {
		appendFileSync(plan.log, `${new Date().toISOString()} [relay:${phase}] pid=${process.pid} ${JSON.stringify(extra)}\n`, 'utf8')
		if (statSync(plan.log).size > LOG_LIMIT) writeFileSync(plan.log, '', 'utf8')
	} catch {
		// Logging must never be the reason a relaunch fails.
	}
}

/**
 * Wait without tearing the event loop down between checks.
 * @param ms - milliseconds.
 */
function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Whether a pid still exists.
 *
 * `EPERM` counts as alive: the process is there, we simply may not signal it.
 * @param pid - pid to probe.
 * @returns `true` when the process exists.
 */
function alive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return error?.code === 'EPERM'
	}
}

/**
 * Poll until the pid disappears or the deadline passes.
 * @param pid - pid the new instance must wait out.
 * @param deadlineMs - upper bound.
 * @returns `true` when the pid is gone.
 */
async function waitGone(pid, deadlineMs) {
	const end = Date.now() + (Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : 0)
	while (Date.now() < end) {
		if (!alive(pid)) return true
		await sleep(POLL_MS)
	}
	return !alive(pid)
}

/**
 * Remove the variables that would change what the executable starts as.
 * @param scrub - names to delete.
 * @returns a fresh environment object.
 */
function cleanEnv(scrub) {
	const env = { ...process.env }
	for (const name of Array.isArray(scrub) ? scrub : []) delete env[name]
	return env
}

/**
 * Start the new instance once.
 * @returns the spawned child, resolved on `spawn`.
 */
function launch() {
	return new Promise((resolve, reject) => {
		let child
		try {
			child = spawn(plan.exe, Array.isArray(plan.args) ? plan.args : [], {
				cwd: plan.cwd,
				env: cleanEnv(plan.scrub),
				detached: true,
				stdio: 'ignore',
				// The window must be visible: this is the application, not a helper.
				windowsHide: false,
			})
		} catch (error) {
			reject(error)
			return
		}
		child.once('error', reject)
		child.once('spawn', () => {
			try {
				child.unref()
			} catch {
				// Detached already.
			}
			resolve(child)
		})
	})
}

// First proof of life, before anything that can block: the host refuses to go
// down without a heartbeat, so this line is what makes the restart safe.
beat('started', { waitedPid: plan.waitedPid })

/*
 * The host asks the window owner to go away, and normally that is enough. When
 * it is not — a launcher in between, a refused `taskkill`, a host that left a
 * little too early — the relay is the only process still standing on the right
 * side of the fence, so it retries the kill itself instead of waiting out the
 * deadline with a window that never closes. The grace period keeps the poster's
 * receipt able to flush before anything dies.
 *
 * Two guards, both load-bearing: this is a **desktop** concern only (on web and
 * stdio hosts the pid in the plan is the host itself, which exits on its own),
 * and a dry run must never kill anything — its whole point is to show the plan.
 */
if (plan.kind === 'desktop-app' && plan.dryRun !== true) {
	await sleep(KILL_GRACE_MS)
	if (isAlive(plan.waitedPid)) {
		const killed = forceKill(plan.waitedPid)
		beat('killed', { waitedPid: plan.waitedPid, ok: killed.ok, message: killed.message })
	}
}

const gone = await waitGone(plan.waitedPid, plan.deadlineMs)
beat(gone ? 'parent-exited' : 'parent-still-running', { waitedPid: plan.waitedPid })

// The old instance may still hold the single-instance lock; a launch that races
// it exits silently, which looks exactly like success until someone looks.
await sleep(Number.isFinite(plan.settleMs) ? plan.settleMs : 0)

if (plan.dryRun === true) {
	beat('relaunched', { dryRun: true })
	process.exit(0)
}

const attempts = Number.isSafeInteger(plan.retry) && plan.retry > 0 ? plan.retry : 1
let lastError
for (let attempt = 1; attempt <= attempts; attempt++) {
	try {
		const child = await launch()
		beat('relaunched', { attempt, childPid: child.pid })
		process.exit(0)
	} catch (error) {
		lastError = error
		beat('launch-failed', { attempt, error: String(error?.message ?? error) })
		if (attempt < attempts) await sleep(Number.isFinite(plan.retryDelayMs) ? plan.retryDelayMs : 1200)
	}
}

beat('failed', { error: String(lastError?.message ?? lastError) })
process.exit(1)
