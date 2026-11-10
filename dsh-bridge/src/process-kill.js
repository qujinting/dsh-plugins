/**
 * Ending one process on purpose.
 *
 * Shared by the host half (which asks the window owner to go away) and the relay
 * (which retries when that ask did not take). Three rules, all learned here:
 *
 *   · **Never a tree kill.** The relay is a descendant of the process being
 *     terminated, so `taskkill /T` would take the only survivor with it.
 *   · **Report the outcome.** A silently failing `taskkill` looks exactly like a
 *     restart that never happened; the caller needs the reason in the log.
 *   · **Decode the answer, don't assume UTF-8.** `taskkill` writes in the
 *     console's OEM code page — GBK on a zh-CN Windows — so reading it as UTF-8
 *     put `锟缴癸拷…` into the relay log instead of `成功: 已终止 PID 为 …`.
 *
 * @module dsh-bridge/process-kill
 */

import { spawnSync } from 'node:child_process'

/** Lazily built decoders: a runtime without ICU for `gbk` must not break the module. */
let cachedDecoders

/**
 * Decoders for the two encodings a Windows console can hand back.
 * @returns `{ utf8, gbk }`, either possibly `undefined`.
 */
function decoders() {
	if (cachedDecoders !== undefined) return cachedDecoders
	const make = (label, options) => {
		try {
			return new TextDecoder(label, options)
		} catch {
			return undefined
		}
	}
	cachedDecoders = { utf8: make('utf-8', { fatal: true }), gbk: make('gbk') }
	return cachedDecoders
}

/**
 * Decode one chunk of console output.
 *
 * UTF-8 first with `fatal: true`, because a correctly encoded message has to win
 * outright — a GBK decoder would happily turn valid UTF-8 into noise. Only when
 * the bytes are not valid UTF-8 do we fall back to the OEM code page, which is
 * what `taskkill` actually writes on a localized Windows.
 * @param chunk - stdout or stderr from the child, as bytes.
 * @returns the decoded text, trimmed; empty when there is nothing to decode.
 */
export function decodeConsole(chunk) {
	if (chunk === null || chunk === undefined) return ''
	const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk), 'utf8')
	if (bytes.length === 0) return ''

	const { utf8, gbk } = decoders()
	if (utf8 !== undefined) {
		try {
			return utf8.decode(bytes).trim()
		} catch {
			// Not UTF-8: a localized console message, most likely.
		}
	}
	if (gbk !== undefined) {
		try {
			return gbk.decode(bytes).trim()
		} catch {
			// Fall through to a lossless-enough last resort.
		}
	}
	return Buffer.from(bytes).toString('latin1').trim()
}

/**
 * Decode stdout and stderr into one message.
 * @param chunks - any mix of buffers, `null`, or `undefined`.
 * @returns the non-empty parts joined by a space.
 */
export function decodeConsoleOutput(...chunks) {
	return chunks
		.map(chunk => decodeConsole(chunk))
		.filter(text => text.length > 0)
		.join(' ')
}

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
		// No `encoding`: the bytes are decoded below, because guessing UTF-8 here is
		// exactly what produced mojibake in the first place.
		const result = spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true })
		if (result.error !== undefined && result.error !== null) {
			return { ok: false, reason: 'spawn-failed', message: String(result.error?.message ?? result.error) }
		}
		const message = decodeConsoleOutput(result.stdout, result.stderr)
		return { ok: result.status === 0, status: result.status, message: message.length > 0 ? message : undefined }
	}

	try {
		process.kill(pid, 'SIGTERM')
		return { ok: true }
	} catch (error) {
		return { ok: false, reason: 'kill-failed', message: String(error?.message ?? error) }
	}
}
