/**
 * A minimal MCP client over stdio: newline-delimited JSON-RPC 2.0, no SDK.
 *
 * The Harness already ships `@deepseek-ai/dsh-mcp-client`, and this plugin does
 * not replace it. That bridge registers every tool a server publishes — for REA
 * that is 229 schemas in every request of every session, which is exactly the
 * cost this plugin exists to remove. So the transport is reimplemented here in
 * ~250 lines against the wire protocol, and only two model-facing tools come out
 * the other side: a catalog search and a single dispatcher.
 *
 * @module dsh-rea/client
 */

import { spawn } from 'node:child_process'
import readline from 'node:readline'

/** Protocol revision this client offers; the server may answer with its own. */
const PROTOCOL_VERSION = '2025-06-18'

/** How much stderr is retained for diagnostics when a launch fails. */
const STDERR_TAIL_BYTES = 4_000

/** Package runners are `.cmd` shims on Windows and need `cmd.exe /d /c`. */
const PACKAGE_RUNNERS = /^(?:npx|npm|pnpm|yarn|bunx|bun|corepack)$/i

/**
 * Decide how to spawn the configured command.
 *
 * A bare `npx` is not an executable on Windows: it is `npx.cmd`, which Node
 * refuses to spawn directly. Routing through `cmd.exe /d /c` is what the DSH
 * preset dialect already does for the same reason, and it keeps one default
 * that works on every platform.
 *
 * @param command - the configured executable.
 * @param args - its arguments.
 * @returns the executable to spawn and the argument vector to pass.
 */
export function spawnTarget(command, args) {
	if (process.platform === 'win32' && PACKAGE_RUNNERS.test(command)) {
		return { file: process.env.ComSpec ?? 'cmd.exe', argv: ['/d', '/c', command, ...args] }
	}
	return { file: command, argv: [...args] }
}

/** One MCP stdio session with lazy start, a tool catalog, and idle shutdown. */
export class McpStdioClient {
	#options
	#child = null
	#reader = null
	#pending = new Map()
	#nextId = 0
	#startPromise = null
	#tools = null
	#disposed = false
	#stderr = ''
	#log

	/**
	 * @param options - resolved client options.
	 * @param options.resolveLaunch - resolves the launch line at the moment a start is needed.
	 * @param options.cwd - working directory for the child when the launch line does not name one.
	 * @param options.startupTimeoutMs - budget for spawn, initialize, and discovery.
	 * @param options.callTimeoutMs - budget for one `tools/call`.
	 * @param options.logger - diagnostic sink; never receives credentials.
	 */
	constructor(options) {
		this.#options = options
		this.#log = typeof options.logger === 'function' ? options.logger : () => {}
	}

	/** The catalog discovered on the last successful start, if any. */
	get tools() {
		return this.#tools
	}

	/** Whether a live child process exists right now. */
	get running() {
		return this.#child !== null && this.#child.exitCode === null && this.#disposed === false
	}

	/**
	 * Whether a request is in flight right now.
	 *
	 * A long decompile holds one `tools/call` open for minutes, and the idle
	 * watchdog must never take the process away from it. The caller-facing use of
	 * this is narrow on purpose: it gates shutdown and connection tests, nothing
	 * that changes what a call may do.
	 */
	get busy() {
		return this.#pending.size > 0 || this.#startPromise !== null
	}

	/** Why the last launch failed, trimmed for a tool result. */
	get stderrTail() {
		return this.#stderr.trim()
	}

	/**
	 * Ensure a started session. Concurrent callers share one launch.
	 * @returns the discovered tool catalog.
	 */
	async start() {
		if (this.#disposed) throw new Error('dsh-rea: the REA MCP client has been disposed')
		if (this.#startPromise !== null) return await this.#startPromise
		this.#startPromise = this.#launch()
		try {
			return await this.#startPromise
		} finally {
			this.#startPromise = null
		}
	}

	/**
	 * Call one MCP tool.
	 * @param name - the server's raw tool name.
	 * @param args - its arguments object.
	 * @param signal - cancellation from the tool execution.
	 * @param timeoutMs - budget for this call; overrides the configured default.
	 * @returns the MCP `tools/call` result.
	 */
	async call(name, args, signal, timeoutMs) {
		await this.start()
		const budget = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.#options.callTimeoutMs
		return await this.#request('tools/call', { name, arguments: args }, budget, signal)
	}

	/**
	 * Terminate the child and reject everything still waiting.
	 * @param reason - recorded in the log.
	 */
	async stop(reason = 'stopped') {
		const child = this.#child
		this.#child = null
		this.#tools = null
		this.#rejectAll(new Error(`dsh-rea: the REA MCP server ${reason}`))
		this.#reader?.close()
		this.#reader = null
		if (child === null || child.exitCode !== null) return
		try {
			// Windows: `child.kill()` only stops the immediate child. `npx` runs as a
			// chain of processes (cmd → node → cmd → rea), so killing the first one
			// orphans the rest and they keep holding memory and target handles. Kill
			// the whole tree.
			if (process.platform === 'win32' && typeof child.pid === 'number') {
				spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'taskkill', '/pid', String(child.pid), '/T', '/F'], {
					stdio: 'ignore',
					windowsHide: true,
				})
				return
			}
			child.kill()
		} catch (error) {
			this.#log(`dsh-rea: could not stop the REA MCP server: ${error.message}`)
		}
	}

	/** Refuse further launches and release the child. */
	async dispose() {
		this.#disposed = true
		await this.stop('was disposed with the plugin')
	}

	/** Start the child, speak `initialize`, and discover the tool catalog. */
	async #launch() {
		// Resolved per launch, not at construction: the settings page can change
		// which REA a session uses, and the next call must pick that up.
		const launch = await this.#options.resolveLaunch()
		const command = launch.command
		const args = Array.isArray(launch.args) ? launch.args : []
		const cwd = launch.cwd ?? this.#options.cwd
		const { file, argv } = spawnTarget(command, args)
		this.#stderr = ''

		const child = spawn(file, argv, {
			stdio: ['pipe', 'pipe', 'pipe'],
			cwd,
			env: process.env,
			windowsHide: true,
		})
		this.#child = child

		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		child.stderr.on('data', (chunk) => {
			this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL_BYTES)
		})
		child.on('error', (error) => {
			this.#log(`dsh-rea: server process error: ${error.message}`)
			this.#rejectAll(new Error(`dsh-rea: the REA MCP server failed: ${error.message}`))
		})
		child.on('exit', (code, signal) => {
			if (this.#child !== child) return
			this.#child = null
			this.#tools = null
			this.#reader?.close()
			this.#reader = null
			const how = signal === null ? `exit code ${code}` : `signal ${signal}`
			this.#rejectAll(new Error(`dsh-rea: the REA MCP server stopped (${how}) ${this.#stderr.trim()}`.trim()))
			this.#log(`dsh-rea: server process ended with ${how}`)
		})

		await new Promise((resolve, reject) => {
			const onSpawn = () => {
				child.off('error', onError)
				resolve()
			}
			const onError = (error) => {
				child.off('spawn', onSpawn)
				this.#child = null
				reject(new Error(`dsh-rea: cannot start "${command}": ${error.message}`))
			}
			child.once('spawn', onSpawn)
			child.once('error', onError)
		})

		this.#reader = readline.createInterface({ input: child.stdout })
		this.#reader.on('line', (line) => this.#onLine(line))

		const startupTimeoutMs = this.#options.startupTimeoutMs
		try {
			const init = await this.#request('initialize', {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: 'dsh-rea', version: '0.1.0' },
			}, startupTimeoutMs)

			this.#notify('notifications/initialized', {})
			const server = init?.serverInfo
			this.#log(`dsh-rea: connected to ${server?.name ?? 'unknown server'} ${server?.version ?? ''}`.trim())

			this.#tools = await this.#listTools(startupTimeoutMs)
			return this.#tools
		} catch (error) {
			// A failed handshake must not leave a half-started server behind. Without
			// this, a slow or broken launch leaks the child of every attempt — and a
			// caller that retries accumulates them faster than they exit.
			await this.stop('failed to start')
			const tail = this.#stderr.trim()
			throw tail.length === 0 ? error : new Error(`${error.message}\n${tail}`)
		}
	}

	/**
	 * Page through `tools/list` until the server stops handing out cursors.
	 * @param timeoutMs - budget for the whole discovery.
	 * @returns the tool catalog in discovery order.
	 */
	async #listTools(timeoutMs) {
		const tools = []
		let cursor
		for (let page = 0; page < 50; page += 1) {
			const result = await this.#request('tools/list', cursor === undefined ? {} : { cursor }, timeoutMs)
			for (const tool of result?.tools ?? []) tools.push(tool)
			cursor = result?.nextCursor ?? undefined
			if (cursor === undefined || cursor === null || cursor === '') break
		}
		if (tools.length === 0) throw new Error('dsh-rea: the REA MCP server published no tools')
		return tools
	}

	/** Dispatch one inbound protocol line. */
	#onLine(line) {
		const text = line.trim()
		if (text.length === 0) return
		let message
		try {
			message = JSON.parse(text)
		} catch {
			this.#log(`dsh-rea: ignoring a non-JSON protocol line: ${text.slice(0, 120)}`)
			return
		}
		if (message?.id !== undefined && this.#pending.has(message.id)) {
			const settle = this.#pending.get(message.id)
			this.#pending.delete(message.id)
			settle(message)
			return
		}
		// A server-initiated request we do not implement must be answered, or the
		// server waits on it forever.
		if (message?.id !== undefined && message?.method !== undefined) {
			this.#write({
				jsonrpc: '2.0',
				id: message.id,
				error: { code: -32601, message: `dsh-rea: unsupported server request ${message.method}` },
			})
		}
	}

	/** Send a request and wait for its matching response. */
	#request(method, params, timeoutMs, signal) {
		const child = this.#child
		if (child === null || child.exitCode !== null) {
			throw new Error('dsh-rea: the REA MCP server is not running')
		}
		const id = ++this.#nextId
		return new Promise((resolve, reject) => {
			if (signal?.aborted === true) {
				reject(new Error('dsh-rea: aborted'))
				return
			}
			const timer = setTimeout(() => {
				this.#pending.delete(id)
				reject(new Error(`dsh-rea: ${method} timed out after ${timeoutMs} ms`))
			}, timeoutMs)
			const onAbort = () => {
				clearTimeout(timer)
				this.#pending.delete(id)
				reject(new Error('dsh-rea: aborted'))
			}
			signal?.addEventListener('abort', onAbort, { once: true })
			this.#pending.set(id, (message) => {
				clearTimeout(timer)
				signal?.removeEventListener('abort', onAbort)
				if (message.error !== undefined) {
					const detail = message.error?.message ?? JSON.stringify(message.error)
					reject(new Error(`dsh-rea: ${method} failed: ${detail}`))
					return
				}
				resolve(message.result)
			})
			this.#write({ jsonrpc: '2.0', id, method, params })
		})
	}

	/** Send a notification (no response expected). */
	#notify(method, params) {
		this.#write({ jsonrpc: '2.0', method, params })
	}

	/** Write one frame, turning a dead pipe into a diagnosable error. */
	#write(message) {
		const child = this.#child
		if (child === null || child.stdin.writable === false) {
			throw new Error('dsh-rea: the REA MCP server stdin is closed')
		}
		child.stdin.write(`${JSON.stringify(message)}\n`)
	}

	/** Fail every outstanding request with one reason. */
	#rejectAll(error) {
		if (this.#pending.size === 0) return
		const pending = [...this.#pending.values()]
		this.#pending.clear()
		for (const settle of pending) settle({ error: { message: error.message } })
	}
}
