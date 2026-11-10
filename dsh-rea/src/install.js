/**
 * Where REA comes from, and how it gets there.
 *
 * The gateway itself is happy with any launch line. What it cannot assume is
 * that the machine has REA at all: a plugin installed from a bundle reaches
 * users who never ran `npx rea-agents`. So this module owns three questions and
 * nothing else:
 *
 * 1. **What should we launch?** A state file records an explicit `rea.mjs`, a
 *    vendor install made by this plugin wins next, then the user's configured
 *    command, then `npx`. Resolution happens per launch, so changing it from the
 *    settings page takes effect on the next call — no plugin reload.
 * 2. **Is it there?** Every candidate is checked against the filesystem, and the
 *    version is read from the package manifest rather than promised.
 * 3. **How do we get it?** An install runs the package manager into the plugin's
 *    own data directory (never into the package source, which is a git
 *    checkout), streams its log, and records the result. A failed or cancelled
 *    install leaves the previous launch untouched.
 *
 * @module dsh-rea/install
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Package this plugin installs from the public registry. */
export const PACKAGE_NAME = 'rea-agents'

/** Version installed when the settings page does not name one. */
export const DEFAULT_VERSION = '6.8.0'

/** Relative path of the MCP entry point inside an installed package. */
const ENTRY = path.join('node_modules', PACKAGE_NAME, 'scripts', 'rea.mjs')

/** State file inside the data directory. */
const STATE_FILE = 'state.json'

/** Install log inside the data directory, kept for post-mortem. */
const INSTALL_LOG = 'install.log'

/** How much of the install log is kept in memory for the status endpoint. */
const LOG_TAIL_CHARS = 24_000

/** A package install is allowed this long before it is reported as stuck. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Resolve the directory this plugin keeps its own state in.
 *
 * The profile's own directory is the right home, but it has to be asked for
 * correctly: `DSH_PROFILE_DIR` is injected into the *shell tool's* children by
 * `dsh-shell-env`, not into the Host process, so reading it here silently fell
 * back to the user-level directory on a profile boot. `ctx.profileContext.dir`
 * is the service the Host actually has, and it names the same directory the
 * profile's `package.json` lives in.
 *
 * Never the package directory: a linked checkout is the user's source tree, and a
 * published package is replaced on upgrade.
 *
 * @param options - resolved plugin options.
 * @param profileDir - the live profile directory, when a profile is mounted.
 * @returns the absolute data directory.
 */
export function resolveDataDir(options, profileDir) {
	if (typeof options.dataDir === 'string' && options.dataDir.trim().length > 0) {
		return path.resolve(options.dataDir.trim())
	}
	if (typeof profileDir === 'string' && profileDir.trim().length > 0) {
		return path.join(path.resolve(profileDir.trim()), 'data', 'dsh-rea')
	}
	const envDir = process.env.DSH_PROFILE_DIR
	if (typeof envDir === 'string' && envDir.trim().length > 0) {
		return path.join(path.resolve(envDir.trim()), 'data', 'dsh-rea')
	}
	return path.join(os.homedir(), '.dsh', 'data', 'dsh-rea')
}

/**
 * Read the state document, tolerating anything on disk.
 * @param dataDir - the plugin data directory.
 * @returns the state, with `{}` for a missing or unreadable file.
 */
export function readState(dataDir) {
	try {
		const raw = fs.readFileSync(path.join(dataDir, STATE_FILE), 'utf8')
		const parsed = JSON.parse(raw)
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
	} catch {
		return {}
	}
}

/**
 * Write the state document atomically.
 * @param dataDir - the plugin data directory.
 * @param state - the complete state.
 */
export function writeState(dataDir, state) {
	fs.mkdirSync(dataDir, { recursive: true })
	const target = path.join(dataDir, STATE_FILE)
	const temporary = `${target}.${String(process.pid)}.tmp`
	fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
	fs.renameSync(temporary, target)
}

/**
 * Read one package's version from its manifest.
 * @param packageDir - the installed package directory.
 * @returns the version, or undefined when the manifest is unreadable.
 */
function readVersion(packageDir) {
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
		return typeof manifest.version === 'string' ? manifest.version : undefined
	} catch {
		return undefined
	}
}

/**
 * Whether a path is a usable REA MCP entry point.
 * @param candidate - the path to check.
 * @returns whether it exists and is a file.
 */
export function isEntryPoint(candidate) {
	try {
		return fs.statSync(candidate).isFile()
	} catch {
		return false
	}
}

/**
 * Describe the vendor install this plugin made, if any.
 * @param dataDir - the plugin data directory.
 * @returns its entry point and version, or undefined.
 */
export function vendorInstall(dataDir) {
	const entry = path.join(dataDir, ENTRY)
	if (!isEntryPoint(entry)) return undefined
	return {
		script: entry,
		version: readVersion(path.join(dataDir, 'node_modules', PACKAGE_NAME)),
	}
}

/**
 * Build the launch line a candidate describes.
 * @param script - absolute path to the REA MCP entry point.
 * @param origin - which source produced it.
 * @param version - the installed version, when known.
 * @returns a launch descriptor.
 */
function launchFromScript(script, origin, version) {
	return {
		command: process.execPath,
		args: [script, 'mcp'],
		origin,
		script,
		...(version === undefined ? {} : { version }),
	}
}

/**
 * Decide what to launch, in priority order.
 *
 * The explicit path wins over the vendor install on purpose: a user who typed a
 * path meant it, and the settings page offers a separate button to forget it.
 *
 * @param dataDir - the plugin data directory.
 * @param state - the current state document.
 * @param options - resolved plugin options (the `command`/`args` fallback).
 * @returns a launch descriptor, plus what the settings page needs to explain it.
 */
export function resolveLaunch(dataDir, state, options) {
	const explicit = typeof state.reaScript === 'string' ? state.reaScript : undefined
	if (explicit !== undefined && isEntryPoint(explicit)) {
		return launchFromScript(explicit, 'configured', state.reaVersion)
	}
	const vendor = vendorInstall(dataDir)
	if (vendor !== undefined) {
		return launchFromScript(vendor.script, 'vendor', vendor.version)
	}
	return {
		command: options.command,
		args: [...options.args],
		origin: 'command',
	}
}

/**
 * Every place REA could come from on this machine, for the settings page.
 * @param dataDir - the plugin data directory.
 * @param state - the current state document.
 * @param options - resolved plugin options.
 * @returns one row per candidate, the winner first.
 */
export function candidates(dataDir, state, options) {
	const rows = []
	const explicit = typeof state.reaScript === 'string' ? state.reaScript : undefined
	if (explicit !== undefined) {
		rows.push({
			origin: 'configured',
			label: '手动指定的 rea.mjs',
			path: explicit,
			available: isEntryPoint(explicit),
		})
	}
	const vendor = vendorInstall(dataDir)
	rows.push({
		origin: 'vendor',
		label: '插件目录内置安装',
		path: path.join(dataDir, ENTRY),
		available: vendor !== undefined,
		...(vendor?.version === undefined ? {} : { version: vendor.version }),
	})
	rows.push({
		origin: 'command',
		label: `默认启动命令（${options.command} ${options.args.join(' ')}）`.trim(),
		path: options.command,
		available: true,
	})
	return rows
}

/** One in-flight install, owned by the plugin for its lifetime. */
export class Installer {
	#dataDir
	#log
	#logger
	#child = null
	#status
	#logText = ''
	#timer = null

	/**
	 * @param options - installer options.
	 * @param options.dataDir - the plugin data directory.
	 * @param options.logger - diagnostic sink.
	 */
	constructor(options) {
		this.#dataDir = options.dataDir
		this.#logger = options.logger
		this.#log = (message) => this.#logger?.(`dsh-rea: ${message}`)
		this.#status = { status: 'idle' }
	}

	/** The current install status, safe to serialise. */
	get status() {
		return { ...this.#status, log: this.#logText }
	}

	/**
	 * Start an install if none is running.
	 * @param version - the version to install, or the default.
	 * @returns the accepted status, or a description of what is running already.
	 */
	start(version) {
		if (this.#child !== null) {
			return { started: false, status: this.status, error: '已经有一个安装在进行中' }
		}
		const target = typeof version === 'string' && version.trim().length > 0 ? version.trim() : DEFAULT_VERSION
		if (!/^[0-9A-Za-z.^~-]+$/u.test(target)) {
			return { started: false, status: this.status, error: `版本号 "${target}" 不合法` }
		}

		fs.mkdirSync(this.#dataDir, { recursive: true })
		// A bare `npm install <pkg>` needs a manifest to resolve into; writing one
		// keeps the data directory self-describing and the install repeatable.
		const manifest = path.join(this.#dataDir, 'package.json')
		if (!fs.existsSync(manifest)) {
			fs.writeFileSync(manifest, `${JSON.stringify({ name: 'dsh-rea-vendor', private: true, version: '0.0.0' }, null, 2)}\n`, 'utf8')
		}

		const args = ['install', `${PACKAGE_NAME}@${target}`, '--no-audit', '--no-fund', '--loglevel=error']
		const [file, argv] = packageManager(args)
		this.#logText = ''
		this.#status = { status: 'running', version: target, startedAt: new Date().toISOString() }
		this.#append(`> ${[file, ...argv].join(' ')}\n`)

		let child
		try {
			child = spawn(file, argv, {
				cwd: this.#dataDir,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
				env: process.env,
			})
		} catch (error) {
			this.#status = { status: 'failed', version: target, error: error.message, finishedAt: new Date().toISOString() }
			return { started: false, status: this.status, error: error.message }
		}
		this.#child = child
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		child.stdout.on('data', (chunk) => this.#append(chunk))
		child.stderr.on('data', (chunk) => this.#append(chunk))
		// A cancelled install still emits `exit` later. Without this guard that
		// late event would rewrite the status of whatever install replaced it.
		child.on('error', (error) => {
			if (this.#child !== child) return
			this.#finish(target, `无法启动 ${file}：${error.message}`)
		})
		child.on('exit', (code, signal) => {
			if (this.#child !== child) return
			if (code === 0) {
				const entry = path.join(this.#dataDir, ENTRY)
				if (!isEntryPoint(entry)) {
					this.#finish(target, `安装命令结束，但没有找到 ${entry}`)
					return
				}
				this.#finish(target, undefined)
				return
			}
			this.#finish(target, signal === null ? `安装命令以退出码 ${String(code)} 结束` : `安装命令被信号 ${signal} 终止`)
		})

		this.#timer = setTimeout(() => {
			this.#append('\n[dsh-rea] 安装超过时限，已终止\n')
			this.cancel()
			this.#finish(target, '安装超时，已终止')
		}, INSTALL_TIMEOUT_MS)
		this.#timer.unref?.()
		return { started: true, status: this.status }
	}

	/** Stop the running install, if any. */
	cancel() {
		const child = this.#child
		if (child === null) return false
		this.#child = null
		if (this.#timer !== null) clearTimeout(this.#timer)
		this.#timer = null
		killTree(child.pid)
		this.#status = { ...this.#status, status: 'cancelled', finishedAt: new Date().toISOString() }
		return true
	}

	/** Release the timer and the child when the plugin unloads. */
	dispose() {
		this.cancel()
	}

	/** Record the terminal status and flush the log. */
	#finish(version, error) {
		if (this.#timer !== null) clearTimeout(this.#timer)
		this.#timer = null
		this.#child = null
		if (this.#status.status === 'cancelled') {
			this.#flush()
			return
		}
		this.#status = error === undefined
			? { status: 'done', version, finishedAt: new Date().toISOString() }
			: { status: 'failed', version, error, finishedAt: new Date().toISOString() }
		this.#flush()
		if (error === undefined) this.#log(`installed ${PACKAGE_NAME}@${version} into ${this.#dataDir}`)
		else this.#log(`install failed: ${error}`)
	}

	/** Append one chunk to the bounded log. */
	#append(chunk) {
		this.#logText = (this.#logText + String(chunk)).slice(-LOG_TAIL_CHARS)
	}

	/** Keep the install log on disk for a later post-mortem. */
	#flush() {
		try {
			fs.writeFileSync(path.join(this.#dataDir, INSTALL_LOG), this.#logText, 'utf8')
		} catch (error) {
			this.#log(`could not write the install log: ${error.message}`)
		}
	}
}

/**
 * Build the package-manager invocation for this platform.
 * @param args - arguments after the package manager name.
 * @returns the executable and its arguments.
 */
function packageManager(args) {
	if (process.platform === 'win32') {
		return [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args]]
	}
	return ['npm', args]
}

/**
 * Kill a process and its children.
 * @param pid - the process id to kill.
 */
function killTree(pid) {
	if (typeof pid !== 'number') return
	if (process.platform === 'win32') {
		spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'taskkill', '/pid', String(pid), '/T', '/F'], {
			stdio: 'ignore',
			windowsHide: true,
		})
		return
	}
	try {
		process.kill(pid, 'SIGTERM')
	} catch {
		// Already gone.
	}
}
