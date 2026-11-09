/**
 * A minimal Chrome DevTools Protocol driver over the machine's own browser.
 *
 * The whole point is to depend on nothing: no Playwright, no Puppeteer, no npm
 * package at all. A shipped Chrome plus Node's built-in `fetch` and `WebSocket`
 * globals (Node >= 22) are enough to open a page, run script inside it, and
 * capture a PNG.
 *
 * Three facts drive the design, each learned the hard way:
 *
 * - A fresh `--user-data-dir` is mandatory. Without it a running Chrome just
 *   opens a tab in the existing instance and exits, so the debug port never
 *   appears and every probe dies with "no CDP endpoint".
 * - `--remote-debugging-port=0` plus the `DevToolsActivePort` file the browser
 *   writes into the profile directory is better than a fixed port: nothing to
 *   collide with, and the port is known only after the browser is really up.
 * - The browser process must always be reaped. `stdio: 'ignore'` keeps the
 *   spawn legal under confined sandboxes, and `taskkill /T` on Windows is what
 *   actually takes the renderer children down with it.
 *
 * @module dsh-chrome-cdp/cdp
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Browser binaries probed, in order, when no explicit path is configured. */
const DEFAULT_BROWSER_CANDIDATES = [
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
	path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
	'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
	'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
]

/**
 * Resolve the browser binary to drive.
 * @param configured - an explicit path from plugin config, when present.
 * @returns the first candidate that exists on disk.
 * @throws {Error} when nothing exists, naming the config field that fixes it.
 */
export function resolveBrowserExecutable(configured) {
	const candidates = typeof configured === 'string' && configured.trim().length > 0 ? [configured] : DEFAULT_BROWSER_CANDIDATES
	for (const candidate of candidates) {
		try {
			if (fs.statSync(candidate).isFile()) return candidate
		} catch {}
	}
	throw new Error(
		typeof configured === 'string' && configured.trim().length > 0
			? `chrome-cdp: configured browserPath does not exist: ${configured}`
			: 'chrome-cdp: no Chrome or Edge executable found; set the chrome-cdp plugin\'s browserPath config to the browser binary',
	)
}

/** One JSON-RPC-over-WebSocket client for the browser endpoint, with flat sessions. */
class CdpConnection {
	#socket
	#seq = 0
	#pending = new Map()
	#closed = false

	constructor(socket) {
		this.#socket = socket
		socket.addEventListener('message', (event) => {
			let message
			try {
				message = JSON.parse(event.data)
			} catch {
				return
			}
			if (message.id === undefined) return
			const settle = this.#pending.get(message.id)
			if (settle === undefined) return
			this.#pending.delete(message.id)
			settle(message)
		})
		const fail = (reason) => {
			this.#closed = true
			for (const settle of this.#pending.values()) settle({ error: { message: reason } })
			this.#pending.clear()
		}
		socket.addEventListener('close', () => fail('CDP connection closed'))
		socket.addEventListener('error', () => fail('CDP connection failed'))
	}

	/**
	 * Open a connection to one browser WebSocket endpoint.
	 * @param url - the `webSocketDebuggerUrl` from `/json/version`.
	 * @param signal - cancels the handshake.
	 * @returns the connected client.
	 */
	static async connect(url, signal) {
		const socket = new WebSocket(url)
		await new Promise((resolve, reject) => {
			const onAbort = () => reject(new Error('chrome-cdp: aborted while connecting to CDP'))
			socket.addEventListener('open', () => {
				signal?.removeEventListener('abort', onAbort)
				resolve()
			}, { once: true })
			socket.addEventListener('error', () => reject(new Error(`chrome-cdp: cannot connect to CDP endpoint ${url}`)), { once: true })
			signal?.addEventListener('abort', onAbort, { once: true })
		})
		return new CdpConnection(socket)
	}

	/**
	 * Send one CDP command.
	 * @param method - the CDP method name.
	 * @param params - its parameters.
	 * @param sessionId - the flat session to address, when the command is target-scoped.
	 * @returns the raw CDP reply.
	 */
	send(method, params = {}, sessionId) {
		if (this.#closed) return Promise.resolve({ error: { message: 'CDP connection is closed' } })
		const id = ++this.#seq
		return new Promise((resolve) => {
			this.#pending.set(id, resolve)
			this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
		})
	}

	/** Close the socket without waiting for a handshake. */
	close() {
		this.#closed = true
		try {
			this.#socket.close()
		} catch {}
	}
}

/** One launched browser plus the attached page session inside it. */
export class CdpBrowser {
	#child
	#connection
	#sessionId
	#userDataDir
	#closed = false

	constructor(child, connection, sessionId, userDataDir) {
		this.#child = child
		this.#connection = connection
		this.#sessionId = sessionId
		this.#userDataDir = userDataDir
	}

	/**
	 * Launch a browser on a private temporary profile and attach one page target.
	 *
	 * @param options - launch parameters.
	 * @param options.executable - the browser binary to run.
	 * @param options.url - the first URL to open.
	 * @param options.headless - whether to run without a visible window.
	 * @param options.width - the emulated viewport width.
	 * @param options.height - the emulated viewport height.
	 * @param options.profileRoot - the directory temporary profiles are created under.
	 * @param options.timeoutMs - the budget for launch plus navigation.
	 * @param options.signal - cancels the launch.
	 * @returns the attached browser.
	 */
	static async launch(options) {
		const { executable, url, headless, width, height, profileRoot, timeoutMs, signal } = options
		const deadline = Date.now() + timeoutMs
		const userDataDir = fs.mkdtempSync(path.join(profileRoot, 'profile-'))
		const args = [
			...(headless ? ['--headless=new'] : []),
			'--remote-debugging-port=0',
			'--no-sandbox',
			'--disable-gpu',
			'--hide-scrollbars',
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-extensions',
			'--disable-background-networking',
			'--force-device-scale-factor=1',
			`--user-data-dir=${userDataDir}`,
			`--window-size=${width},${height}`,
			'about:blank',
		]
		const child = spawn(executable, args, { stdio: 'ignore', detached: true })
		const fail = async (error) => {
			await killProcessTree(child)
			removeDirectory(userDataDir)
			throw error
		}
		let connection
		try {
			const port = await waitForDebugPort(userDataDir, child, deadline, signal)
			const version = await fetchJson(`http://127.0.0.1:${port}/json/version`, deadline, signal)
			connection = await CdpConnection.connect(version.webSocketDebuggerUrl, signal)
			const created = await connection.send('Target.createTarget', { url })
			if (created.error !== undefined) throw new Error(`chrome-cdp: cannot open ${url}: ${created.error.message}`)
			const attached = await connection.send('Target.attachToTarget', { targetId: created.result.targetId, flatten: true })
			if (attached.error !== undefined) throw new Error(`chrome-cdp: cannot attach to the page: ${attached.error.message}`)
			const browser = new CdpBrowser(child, connection, attached.result.sessionId, userDataDir)
			await browser.#prepareViewport(width, height)
			return browser
		} catch (error) {
			try {
				connection?.close()
			} catch {}
			return await fail(error)
		}
	}

	/** Enable the domains the driver needs and pin the emulated viewport. */
	async #prepareViewport(width, height) {
		for (const method of ['Page.enable', 'Runtime.enable']) {
			const reply = await this.#connection.send(method, {}, this.#sessionId)
			if (reply.error !== undefined) throw new Error(`chrome-cdp: ${method} failed: ${reply.error.message}`)
		}
		const override = await this.#connection.send(
			'Emulation.setDeviceMetricsOverride',
			{ width, height, deviceScaleFactor: 1, mobile: false },
			this.#sessionId,
		)
		if (override.error !== undefined) throw new Error(`chrome-cdp: cannot set the viewport: ${override.error.message}`)
	}

	/**
	 * Force the page's `prefers-color-scheme` media feature.
	 *
	 * Toggling a root class is not enough on its own: plenty of apps read the
	 * media query directly (or through `useColorScheme`), so a dark screenshot
	 * taken without this can show the light palette.
	 * @param scheme - `dark` or `light`.
	 */
	async setColorScheme(scheme) {
		const reply = await this.#connection.send(
			'Emulation.setEmulatedMedia',
			{ features: [{ name: 'prefers-color-scheme', value: scheme }] },
			this.#sessionId,
		)
		if (reply.error !== undefined) throw new Error(`chrome-cdp: cannot emulate prefers-color-scheme: ${reply.error.message}`)
	}

	/**
	 * Evaluate one JavaScript expression inside the page.
	 * @param expression - an expression, or a statement body containing `return`.
	 * @returns the value, already unwrapped from the CDP envelope.
	 */
	async evaluate(expression) {
		const attempts = [`(async () => (${expression}))()`, `(async () => { ${expression} })()`]
		let lastError
		for (const source of attempts) {
			const reply = await this.#connection.send(
				'Runtime.evaluate',
				{ expression: source, returnByValue: true, awaitPromise: true },
				this.#sessionId,
			)
			if (reply.error !== undefined) throw new Error(`chrome-cdp: Runtime.evaluate failed: ${reply.error.message}`)
			const details = reply.result.exceptionDetails
			if (details !== undefined) {
				lastError = new Error(details.exception?.description ?? details.text ?? 'page script threw')
				// A syntax error means the snippet was a statement body, not an expression: try the other shape.
				if (details.exception?.className === 'SyntaxError') continue
				throw lastError
			}
			return reply.result.result?.value
		}
		throw lastError ?? new Error('chrome-cdp: page script failed')
	}

	/**
	 * Poll an expression until it reports truthy.
	 * @param expression - the condition to poll.
	 * @param timeoutMs - how long to keep polling.
	 * @param signal - cancels the wait.
	 * @returns whether the condition became truthy in time.
	 */
	async waitFor(expression, timeoutMs, signal) {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			signal?.throwIfAborted()
			try {
				if (await this.evaluate(expression)) return true
			} catch {}
			await sleep(150)
		}
		return false
	}

	/**
	 * Capture the current viewport as PNG bytes.
	 * @returns the PNG buffer.
	 */
	async screenshot() {
		const reply = await this.#connection.send('Page.captureScreenshot', { format: 'png' }, this.#sessionId)
		if (reply.error !== undefined) throw new Error(`chrome-cdp: screenshot failed: ${reply.error.message}`)
		return Buffer.from(reply.result.data, 'base64')
	}

	/** Close the page session, kill the browser, and drop the temporary profile. */
	async close() {
		if (this.#closed) return
		this.#closed = true
		try {
			this.#connection.close()
		} catch {}
		await killProcessTree(this.#child)
		removeDirectory(this.#userDataDir)
	}
}

/**
 * Wait for the browser to publish its chosen debug port.
 * @param userDataDir - the private profile directory.
 * @param child - the browser process, watched for early exit.
 * @param deadline - the absolute time budget.
 * @param signal - cancels the wait.
 * @returns the debug port.
 */
async function waitForDebugPort(userDataDir, child, deadline, signal) {
	const marker = path.join(userDataDir, 'DevToolsActivePort')
	while (Date.now() < deadline) {
		signal?.throwIfAborted()
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(`chrome-cdp: the browser exited during startup (code ${child.exitCode ?? child.signalCode})`)
		}
		try {
			const port = Number.parseInt(fs.readFileSync(marker, 'utf8').split('\n')[0], 10)
			if (Number.isSafeInteger(port) && port > 0) return port
		} catch {}
		await sleep(120)
	}
	throw new Error('chrome-cdp: the browser did not expose a CDP endpoint in time')
}

/**
 * Fetch and parse one JSON endpoint.
 * @param url - the endpoint.
 * @param deadline - the absolute time budget.
 * @param signal - cancels the request.
 * @returns the parsed body.
 */
async function fetchJson(url, deadline, signal) {
	let lastError
	while (Date.now() < deadline) {
		signal?.throwIfAborted()
		try {
			const response = await fetch(url, { signal })
			if (response.ok) return await response.json()
			lastError = new Error(`HTTP ${response.status}`)
		} catch (error) {
			lastError = error
		}
		await sleep(150)
	}
	throw new Error(`chrome-cdp: ${url} never answered (${lastError?.message ?? 'timeout'})`)
}

/**
 * Kill one browser process and, on Windows, its renderer children.
 * @param child - the spawned browser process.
 */
async function killProcessTree(child) {
	if (child.exitCode !== null || child.signalCode !== null) return
	const pid = child.pid
	if (pid === undefined) return
	if (process.platform === 'win32') {
		await new Promise((resolve) => {
			const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
			killer.on('exit', resolve)
			killer.on('error', resolve)
		})
		return
	}
	try {
		child.kill('SIGKILL')
	} catch {}
}

/**
 * Remove a temporary profile directory, tolerating the browser's late file handles.
 * @param directory - the directory to remove.
 */
function removeDirectory(directory) {
	try {
		fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
	} catch {}
}

/**
 * Create the private root temporary browser profiles live under.
 * @param configured - an explicit root from plugin config, when present.
 * @returns the absolute root path.
 */
export function prepareProfileRoot(configured) {
	const root = typeof configured === 'string' && configured.trim().length > 0
		? configured
		: path.join(os.tmpdir(), 'dsh-chrome-cdp')
	fs.mkdirSync(root, { recursive: true })
	return root
}
