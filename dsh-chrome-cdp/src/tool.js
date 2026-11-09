/**
 * The model-facing `chrome_cdp` tool: open a real page in the machine's own
 * Chrome, run script inside it, and capture a PNG — in one call.
 *
 * The tool exists because a skill is only consulted when the model decides to
 * consult it, while a tool sits in the catalog of every request. That is the
 * whole difference between "the agent knows it could look at the page" and "the
 * agent looks at the page".
 *
 * @module dsh-chrome-cdp/tool
 */
import fs from 'node:fs'
import path from 'node:path'
import { CdpBrowser, prepareProfileRoot, resolveBrowserExecutable } from './cdp.js'

/** Default emulated viewport, matching a comfortable desktop layout check. */
const DEFAULT_VIEWPORT = { width: 1600, height: 1000 }

/** How long the page is given to settle after `load`, before script runs. */
const DEFAULT_SETTLE_MS = 1200

/**
 * Turn a URL into a filesystem-safe file name stem.
 * @param url - the page URL.
 * @returns a short slug.
 */
function slugify(url) {
	const withoutScheme = url.replace(/^[a-z]+:\/\//i, '')
	const cleaned = withoutScheme.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
	return (cleaned.length === 0 ? 'page' : cleaned).slice(0, 80)
}

/** One compact timestamp usable inside a file name. */
function timestamp() {
	return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
}

/**
 * Build the `chrome_cdp` tool definition.
 *
 * @param options - resolved plugin options.
 * @param options.toolName - the registered tool name.
 * @param options.browserPath - an explicit browser binary, when configured.
 * @param options.headless - whether the default run is windowless.
 * @param options.timeoutMs - the default per-call budget.
 * @param options.profileRoot - where temporary browser profiles are created.
 * @param options.screenshotDir - where screenshots land when the call does not say.
 * @returns the tool definition accepted by `ctx.tools.register`.
 */
export function chromeCdpTool(options) {
	return {
		name: options.toolName,
		description: [
			'Open a real page in this machine\'s own Chrome over the DevTools Protocol, run JavaScript inside it, and capture a PNG screenshot.',
			'Use it whenever the answer depends on what a page actually renders — visual acceptance of a front-end change (layout, spacing, dark mode, responsive breakpoints), a "you look at it yourself" request, or any claim that is cheaper to verify than to argue about (e.g. prove there is no page scrollbar by measuring scrollHeight against clientHeight).',
			'It needs no Playwright or Puppeteer, and it never touches the browser the user is working in: every call launches Chrome on a throwaway profile and kills it afterwards.',
			'Pass `script` to measure: return a JSON string and read it back from the result, so a single call yields both the numbers and the screenshot. When the result names a PNG path, open it with read_image before drawing conclusions — measurements alone miss "it fits but it looks wrong".',
		].join(' '),
		parameters: {
			type: 'object',
			properties: {
				url: {
					type: 'string',
					description: 'Absolute http(s) URL to open, usually a local dev-server address such as http://localhost:5173/.',
				},
				script: {
					type: 'string',
					description: 'JavaScript to run in the page after it loads, as an expression or as a body containing `return`. Return a JSON string (JSON.stringify(...)) so the measurement survives intact. Runs after the settle wait and after waitForSelector.',
				},
				waitForSelector: {
					type: 'string',
					description: 'CSS selector to wait for before measuring or screenshotting. Use it instead of guessing a fixed delay when the page renders asynchronously.',
				},
				waitMs: {
					type: 'integer',
					description: `Extra milliseconds to let the page settle after load, before waitForSelector and script. Default ${DEFAULT_SETTLE_MS}.`,
				},
				dark: {
					type: 'boolean',
					description: 'Render the dark theme: adds the `dark` class to <html> and emulates prefers-color-scheme: dark. Pass false for the light theme. Applies before script and the screenshot.',
				},
				screenshot: {
					type: 'boolean',
					description: 'Capture a PNG. Default true; set false for a measurement-only call.',
				},
				viewportWidth: {
					type: 'integer',
					description: `Emulated viewport width in CSS pixels. Default ${DEFAULT_VIEWPORT.width}. Use it to check a responsive breakpoint.`,
				},
				viewportHeight: {
					type: 'integer',
					description: `Emulated viewport height in CSS pixels. Default ${DEFAULT_VIEWPORT.height}.`,
				},
				outPath: {
					type: 'string',
					description: 'Where to write the PNG. Defaults to a timestamped file under the session workspace\'s .dsh/chrome-cdp directory.',
				},
				headless: {
					type: 'boolean',
					description: `Run without a visible window. Default ${options.headless}; set false only when a page refuses to render headless and watching it helps.`,
				},
				timeoutMs: {
					type: 'integer',
					description: `Overall budget for this call in milliseconds. Default ${options.timeoutMs}.`,
				},
			},
			required: ['url'],
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					url: { type: 'string' },
					title: { type: 'string' },
					measure: { type: 'string' },
					screenshotPath: { type: 'string' },
					notes: { type: 'string' },
				},
				required: ['url'],
			},
			render: (_args, value) => {
				const lines = [`<url>${value.url}</url>`, `<title>${value.title ?? ''}</title>`]
				if (value.measure !== undefined && value.measure.length > 0) {
					lines.push('<measure>', value.measure, '</measure>')
				}
				if (value.screenshotPath !== undefined) {
					lines.push(
						'<screenshot>',
						value.screenshotPath,
						'</screenshot>',
						'Open that PNG with the read_image tool and judge it by eye before reporting a result.',
					)
				}
				if (value.notes !== undefined && value.notes.length > 0) lines.push(`<notes>${value.notes}</notes>`)
				return [{ type: 'text', text: lines.join('\n') }]
			},
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const url = typeof args.url === 'string' ? args.url.trim() : ''
			if (url.length === 0) throw new Error('chrome_cdp: `url` must be a non-empty string')
			if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
				throw new Error(`chrome_cdp: \`url\` must be an absolute http(s) or file URL, received "${url}"`)
			}

			const width = positiveInteger(args.viewportWidth, DEFAULT_VIEWPORT.width, 'viewportWidth')
			const height = positiveInteger(args.viewportHeight, DEFAULT_VIEWPORT.height, 'viewportHeight')
			const waitMs = nonNegativeInteger(args.waitMs, DEFAULT_SETTLE_MS, 'waitMs')
			const timeoutMs = positiveInteger(args.timeoutMs, options.timeoutMs, 'timeoutMs')
			const headless = args.headless ?? options.headless
			const wantScreenshot = args.screenshot ?? true
			const cwd = exec.agent?.session?.header?.cwd ?? process.cwd()
			const executable = resolveBrowserExecutable(options.browserPath)
			const profileRoot = prepareProfileRoot(options.profileRoot)

			const browser = await CdpBrowser.launch({
				executable,
				url,
				headless,
				width,
				height,
				profileRoot,
				timeoutMs,
				signal: exec.signal,
			})

			try {
				const ready = await browser.waitFor('document.readyState === "complete"', timeoutMs, exec.signal)
				const notes = []
				if (!ready) notes.push('the page never reported readyState "complete"; results may be from a partially rendered page')
				await sleep(waitMs, exec.signal)

				if (typeof args.waitForSelector === 'string' && args.waitForSelector.trim().length > 0) {
					const selector = JSON.stringify(args.waitForSelector.trim())
					const found = await browser.waitFor(`!!document.querySelector(${selector})`, timeoutMs, exec.signal)
					if (!found) notes.push(`selector ${args.waitForSelector.trim()} never appeared`)
				}

				if (args.dark === true || args.dark === false) {
					// Both halves matter: the class covers apps that switch on a root
					// class, and the media emulation covers apps that read the media
					// query. A theme switch driven by localStorage is left to `script`.
					await browser.setColorScheme(args.dark ? 'dark' : 'light')
					await browser.evaluate(
						args.dark
							? "document.documentElement.classList.add('dark'); document.documentElement.style.colorScheme = 'dark'; 'ok'"
							: "document.documentElement.classList.remove('dark'); document.documentElement.style.colorScheme = 'light'; 'ok'",
					)
					await sleep(350, exec.signal)
				}

				const measure = typeof args.script === 'string' && args.script.trim().length > 0
					? await browser.evaluate(args.script)
					: undefined
				const title = await browser.evaluate('document.title').catch(() => undefined)

				let screenshotPath
				if (wantScreenshot) {
					const bytes = await browser.screenshot()
					screenshotPath = resolveScreenshotPath(args.outPath, options.screenshotDir, cwd, url)
					fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
					fs.writeFileSync(screenshotPath, bytes)
				}

				return {
					url: await browser.evaluate('location.href').catch(() => url),
					...(typeof title === 'string' ? { title } : {}),
					...(measure === undefined ? {} : { measure: stringifyMeasurement(measure) }),
					...(screenshotPath === undefined ? {} : { screenshotPath }),
					...(notes.length === 0 ? {} : { notes: notes.join('; ') }),
				}
			} finally {
				await browser.close()
			}
		},
	}
}

/**
 * Render whatever the page script returned as text the model can read.
 * @param value - the unwrapped evaluate result.
 * @returns the measurement text.
 */
function stringifyMeasurement(value) {
	if (typeof value === 'string') return value
	if (value === undefined) return '(the script returned nothing)'
	try {
		return JSON.stringify(value, null, 1)
	} catch {
		return String(value)
	}
}

/**
 * Decide where the PNG lands.
 * @param requested - an explicit `outPath` from the call.
 * @param configuredDir - the plugin's configured screenshot directory.
 * @param cwd - the session workspace root.
 * @param url - the captured URL, used for the file name stem.
 * @returns the absolute file path.
 */
function resolveScreenshotPath(requested, configuredDir, cwd, url) {
	if (typeof requested === 'string' && requested.trim().length > 0) {
		return path.resolve(cwd, requested.trim())
	}
	const directory = typeof configuredDir === 'string' && configuredDir.trim().length > 0
		? path.resolve(cwd, configuredDir.trim())
		: path.join(cwd, '.dsh', 'chrome-cdp')
	return path.join(directory, `${timestamp()}-${slugify(url)}.png`)
}

/**
 * Read an optional positive integer argument.
 * @param value - the raw argument.
 * @param fallback - the value used when the argument is absent.
 * @param label - the argument name used in the error.
 * @returns the resolved integer.
 */
function positiveInteger(value, fallback, label) {
	if (value === undefined) return fallback
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`chrome_cdp: \`${label}\` must be a positive integer`)
	return value
}

/**
 * Read an optional non-negative integer argument.
 * @param value - the raw argument.
 * @param fallback - the value used when the argument is absent.
 * @param label - the argument name used in the error.
 * @returns the resolved integer.
 */
function nonNegativeInteger(value, fallback, label) {
	if (value === undefined) return fallback
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`chrome_cdp: \`${label}\` must be a non-negative integer`)
	return value
}

/** Promise-based sleep that honours cancellation. */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (ms <= 0) return resolve()
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort)
			resolve()
		}, ms)
		const onAbort = () => {
			clearTimeout(timer)
			reject(new Error('chrome_cdp: aborted'))
		}
		signal?.addEventListener('abort', onAbort, { once: true })
	})
}
