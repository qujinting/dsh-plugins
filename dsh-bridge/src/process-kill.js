/**
 * Ending one process on purpose.
 *
 * Shared by the host half (which asks the window owner to go away) and the relay
 * (which retries when that ask did not take). Two rules, both learned here:
 *
 *   · **Never a tree kill.** The relay is a descendant of the process being
 *     terminated, so `taskkill /T` would take the only survivor with it.
 *   · **Report the outcome.** A silently failing `taskkill` looks exactly like a
 *     restart that never happened; the caller needs the reason in the log.
 *
 * @module dsh-bridge/process-kill
 */

import { spawnSync } from 'node:child_process'

/**
 * Whether a pid still exists.
 * @param pid - process id.
 * @returns `true` when the process is still there (an access denial counts).
 */
export function isAlive(pid) {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return error?.code === 'EPERM'
	}
}

/**
 * Terminate one process, leaving its children alone.
 * @param pid - process id.
 * @param options - platform override for tests.
 * @returns `{ ok, status?, message?, reason? }`.
 */
export function forceKill(pid, options = {}) {
	const platform = options.platform ?? process.platform
	if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: false, reason: 'invalid-pid' }

	if (platform === 'win32') {
		const result = spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, encoding: 'utf8' })
		if (result.error !== undefined && result.error !== null) {
			return { ok: false, reason: 'spawn-failed', message: String(result.error?.message ?? result.error) }
		}
		const message = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
		return { ok: result.status === 0, status: result.status, message: message.length > 0 ? message : undefined }
	}

	try {
		process.kill(pid, 'SIGTERM')
		return { ok: true }
	} catch (error) {
		return { ok: false, reason: 'kill-failed', message: String(error?.message ?? error) }
	}
}
