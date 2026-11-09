/**
 * The at-rest cipher: Windows DPAPI, scoped to the current user.
 *
 * The store's whole point is that a value which reaches disk is worthless to
 * anyone who is not this Windows account — a copied folder, a synced backup, a
 * colleague's machine, a second local user. The only OS facility on this
 * platform that gives that without shipping a native module is DPAPI
 * (`CryptProtectData` behind `System.Security.Cryptography.ProtectedData`), so
 * this module is a thin, dependency-free bridge to it through the Windows
 * PowerShell that ships with the OS.
 *
 * Two properties of the bridge are deliberate:
 *
 * 1. **Nothing secret touches argv.** A process command line is world-readable
 *    on Windows, so the payload travels in the child's *environment* and the
 *    script itself is a fixed, secret-free constant handed over as
 *    `-EncodedCommand`. Both protect and unprotect ask for `CurrentUser`
 *    scope, so the blob is useless under any other account.
 * 2. **Failure is not silent and never destructive.** `available()` is a real
 *    round trip, not a version check; when it fails the store locks itself
 *    read-only instead of writing a blob it may not be able to read back.
 *
 * `powershell.exe` is not `pwsh`: the harness's own tool names do not matter
 * here, and Windows PowerShell 5.1 is present on every supported desktop.
 *
 * @module dsh-secret-broker/crypto
 */

import { spawn } from 'node:child_process'

/** The interpreter every Windows desktop has, without a PATH lookup surprise. */
const POWERSHELL = 'powershell.exe'

/**
 * Refuse payloads a child environment cannot carry with margin. Windows caps
 * the environment block, and a secret longer than this is a file, not a value:
 * the store reports the limit instead of failing mid-write.
 */
export const MAX_SECRET_BYTES = 8192

/** Environment names this module owns in the child it spawns. */
const MODE_ENV = 'DSH_SECRET_BROKER_DPAPI_MODE'
const DATA_ENV = 'DSH_SECRET_BROKER_DPAPI_DATA'

/** How long one round trip may take before the child is killed. */
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * The fixed child script.
 *
 * `Add-Type` is attempted but not required: Windows PowerShell 5.1 needs it to
 * load `System.Security`, while a newer host already has the assembly. The
 * result goes out through `[Console]::Out` so nothing else PowerShell might
 * print can be mistaken for the payload, and base64 keeps the byte stream
 * encoding-agnostic on the way back.
 */
const SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	'try { Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue } catch { }',
	'$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
	'$data = [Convert]::FromBase64String($env:' + DATA_ENV + ')',
	"if ($env:" + MODE_ENV + " -eq 'protect') {",
	'  $out = [System.Security.Cryptography.ProtectedData]::Protect($data, $null, $scope)',
	'} else {',
	'  $out = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $null, $scope)',
	'}',
	'[Console]::Out.Write([Convert]::ToBase64String($out))',
	'[Console]::Out.Flush()',
].join('\n')

/** UTF-16LE base64, which is what `-EncodedCommand` accepts. */
const ENCODED_SCRIPT = Buffer.from(SCRIPT, 'utf16le').toString('base64')

/**
 * One DPAPI round trip.
 *
 * @param mode - `protect` or `unprotect`.
 * @param payload - the bytes to transform.
 * @param timeoutMs - how long the child may take.
 * @returns the transformed bytes.
 * @throws when the interpreter cannot be spawned, exits non-zero, or answers nothing.
 */
function runPowerShell(mode, payload, timeoutMs) {
	return new Promise((resolve, reject) => {
		let child
		try {
			child = spawn(
				POWERSHELL,
				['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_SCRIPT],
				{
					// The payload rides here rather than in argv: a command line is
					// readable by any process on the machine, a child environment is
					// not part of the visible command.
					env: { ...process.env, [MODE_ENV]: mode, [DATA_ENV]: payload.toString('base64') },
					stdio: ['ignore', 'pipe', 'pipe'],
					windowsHide: true,
				},
			)
		} catch (error) {
			reject(new Error(`secret-broker: cannot start ${POWERSHELL}: ${error?.message ?? error}`))
			return
		}

		const stdout = []
		const stderr = []
		let settled = false
		const timer = setTimeout(() => {
			if (settled) return
			settled = true
			try {
				child.kill()
			} catch {
				/* the child is already gone */
			}
			reject(new Error(`secret-broker: DPAPI ${mode} timed out after ${timeoutMs}ms`))
		}, timeoutMs)

		const finish = (error, value) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (error !== undefined) reject(error)
			else resolve(value)
		}

		child.stdout.on('data', (chunk) => stdout.push(chunk))
		child.stderr.on('data', (chunk) => stderr.push(chunk))
		child.on('error', (error) => {
			finish(new Error(`secret-broker: cannot start ${POWERSHELL}: ${error?.message ?? error}`))
		})
		child.on('close', (code) => {
			if (code !== 0) {
				const detail = Buffer.concat(stderr).toString('utf8').trim().split('\n')[0] ?? ''
				finish(new Error(`secret-broker: DPAPI ${mode} failed (exit ${String(code)})${detail.length > 0 ? ': ' + detail : ''}`))
				return
			}
			const text = Buffer.concat(stdout).toString('utf8').trim()
			if (text.length === 0) {
				finish(new Error(`secret-broker: DPAPI ${mode} returned nothing`))
				return
			}
			try {
				finish(undefined, Buffer.from(text, 'base64'))
			} catch (error) {
				finish(new Error(`secret-broker: DPAPI ${mode} returned unreadable output: ${error?.message ?? error}`))
			}
		})
	})
}

/**
 * The DPAPI cipher as the store consumes it.
 *
 * One probe decides availability for the process lifetime: the round trip is
 * the only honest test, and repeating a ~200 ms child spawn per keystroke is
 * not. `unavailable` is a promise that never rejects — callers read
 * `available` instead of catching.
 */
export class DpapiCipher {
	/**
	 * @param options - cipher options.
	 * @param options.timeoutMs - per-round-trip budget.
	 */
	constructor(options = {}) {
		this.timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
			? options.timeoutMs
			: DEFAULT_TIMEOUT_MS
		/** Why the cipher is unusable, when it is. */
		this.reason = undefined
		/** Whether a real protect/unprotect round trip has succeeded. */
		this.available = false
		/** In-flight or settled probe, so concurrent callers share one spawn. */
		this.probe = undefined
	}

	/**
	 * Prove the cipher works, once per process.
	 *
	 * @returns whether DPAPI is usable here.
	 */
	async ready() {
		if (this.probe === undefined) this.probe = this.#probe()
		return await this.probe
	}

	/** @returns whether the round trip succeeded. */
	async #probe() {
		if (process.platform !== 'win32') {
			this.reason = 'DPAPI is a Windows facility and this is not Windows'
			return false
		}
		try {
			const marker = Buffer.from('dsh-secret-broker-probe', 'utf8')
			const sealed = await runPowerShell('protect', marker, this.timeoutMs)
			if (sealed.equals(marker)) {
				this.reason = 'DPAPI returned the plaintext unchanged'
				return false
			}
			const opened = await runPowerShell('unprotect', sealed, this.timeoutMs)
			if (!opened.equals(marker)) {
				this.reason = 'DPAPI returned different bytes than it was given'
				return false
			}
			this.available = true
			return true
		} catch (error) {
			this.reason = error?.message ?? String(error)
			return false
		}
	}

	/**
	 * Seal plaintext for the current user.
	 *
	 * @param text - the plaintext.
	 * @returns the sealed bytes.
	 */
	async protect(text) {
		const payload = Buffer.from(text, 'utf8')
		if (payload.byteLength > MAX_SECRET_BYTES) {
			throw new Error(`secret-broker: refusing to seal ${String(payload.byteLength)} bytes; the DPAPI bridge carries at most ${String(MAX_SECRET_BYTES)} per store write`)
		}
		return await runPowerShell('protect', payload, this.timeoutMs)
	}

	/**
	 * Open a blob sealed for the current user.
	 *
	 * @param sealed - the sealed bytes.
	 * @returns the plaintext.
	 */
	async unprotect(sealed) {
		return (await runPowerShell('unprotect', sealed, this.timeoutMs)).toString('utf8')
	}
}
