/**
 * dsh-theme-orbital — host half.
 *
 * Two contributions, both mounted from the bundle row:
 *
 *   1. `webserver/index-inject` rows, rendered into every index response before
 *      any plug-in script runs (the desktop app collects the same table with
 *      `webServer.collectIndexInjections()` and applies it on boot):
 *        · a `global` row carrying the animation config,
 *        · a `style` row: `--dsw-alias-*` overrides (marked `!important` so they
 *          beat the inline values ui-layout writes on <body>) plus the static
 *          stylesheet,
 *        · the veil markup and its reveal controller (skipped for `animation: none`).
 *
 *   2. `/api/dsh-theme/*` routes that serve the same files with an ETag. The
 *      desktop app only collects injections once per launch, so the browser half
 *      re-fetches `theme.css` here on every page load to keep the live page in
 *      sync with edits on disk.
 *
 * Everything here is deliberately failure-tolerant: a broken palette or a
 * missing file degrades the theme, never the app boot.
 */

import { createReadStream, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-theme-orbital'

/** Route prefix claimed from the host web server. */
export const ROUTE_BASE = '/api/dsh-theme'

/**
 * Comment marker prefixed to the injected stylesheet. The browser half finds
 * the host's <style> by it and reads the revision out of it, which is how a
 * desktop window (which collects injections only once per launch) still picks
 * up stylesheet edits on refresh.
 */
export const STYLE_MARKER = '/* dsh-theme-orbital'

/** Files the browser half is allowed to fetch, by route suffix. */
const SERVED_FILES = new Map([
	['/theme.css', { file: 'theme.css', type: 'text/css; charset=utf-8' }],
	['/palette.json', { file: 'palette.json', type: 'application/json; charset=utf-8' }],
	['/boot.html', { file: 'boot.html', type: 'text/html; charset=utf-8' }],
	['/boot.js', { file: 'boot.js', type: 'text/javascript; charset=utf-8' }],
])

/** Package root (`lib/` → package root). */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Directory holding the authored theme assets. */
const THEME_DIR = join(PACKAGE_ROOT, 'theme')

/** Animation modes accepted by the boot controller. */
const ANIMATIONS = new Set(['hud', 'fade', 'none'])

/**
 * How the Windows native title bar (minimize / maximize / close) behaves while
 * the entrance veil is on screen:
 *   hide   — the overlay plate turns transparent and the glyphs take the film's
 *            own backdrop colour, so the controls read as absent;
 *   blend  — transparent plate, glyphs recoloured for contrast (still usable);
 *   off    — leave the shell's measured title-bar colours untouched.
 */
const TITLE_BAR_MODES = new Set(['hide', 'blend', 'off'])

/** Media extensions the video routes are willing to stream. */
const MEDIA_TYPES = new Map([
	['.mp4', 'video/mp4'],
	['.webm', 'video/webm'],
	['.m4v', 'video/x-m4v'],
])

/** Default intro film, resolved from the package root. */
const DEFAULT_INTRO_VIDEO = 'videos/进场60帧4K.mp4'

/** Glow presets, as multipliers consumed by the stylesheet. */
const GLOW_STRENGTH = { off: '0', low: '0.5', medium: '1', high: '1.6' }

/** mtime+size keyed text cache, so edits on disk show up without a restart. */
const fileCache = new Map()

/** Parsed palette memoized by file revision, so edits show up on the next render. */
let paletteCache

/**
 * Normalize one bundle-row config object. Unknown/invalid values fall back to
 * the shipped defaults instead of throwing — a theme must never stop the boot.
 * @param {unknown} config raw row config.
 * @returns {{enabled: boolean, animation: string, playOn: string, durationMs: number, holdMs: number, introTailMs: number, titleBar: string, scanlines: boolean, grid: boolean, glow: string}} options
 */
export function readOptions(config) {
	const source = config !== null && typeof config === 'object' ? config : {}
	const animation = typeof source.animation === 'string' && ANIMATIONS.has(source.animation) ? source.animation : 'hud'
	const playOn = source.playOn === 'always' ? 'always' : 'cold'
	const glow = typeof source.glow === 'string' && GLOW_STRENGTH[source.glow] !== undefined ? source.glow : 'medium'
	const rawDuration = Number(source.durationMs)
	const durationMs = Number.isFinite(rawDuration) ? Math.min(4000, Math.max(800, Math.round(rawDuration))) : 1500
	const rawOpacity = Number(source.backgroundOpacity)
	const backgroundOpacity = Number.isFinite(rawOpacity) ? Math.min(1, Math.max(0, rawOpacity)) : 0.85
	const rawBlur = Number(source.backgroundBlur)
	const backgroundBlur = Number.isFinite(rawBlur) ? Math.min(80, Math.max(0, Math.round(rawBlur))) : 6
	const rawConversationOpacity = Number(source.backgroundOpacityConversation)
	const backgroundOpacityConversation = Number.isFinite(rawConversationOpacity)
		? Math.min(1, Math.max(0, rawConversationOpacity))
		: 0.55
	const rawConversationBlur = Number(source.backgroundBlurConversation)
	const backgroundBlurConversation = Number.isFinite(rawConversationBlur)
		? Math.min(80, Math.max(0, Math.round(rawConversationBlur)))
		: 8
	const rawHold = Number(source.holdMs)
	const holdMs = Number.isFinite(rawHold) ? Math.min(3000, Math.max(0, Math.round(rawHold))) : 350
	const rawTail = Number(source.introTailMs)
	const introTailMs = Number.isFinite(rawTail) ? Math.min(5000, Math.max(0, Math.round(rawTail))) : 1500
	const titleBar = typeof source.titleBar === 'string' && TITLE_BAR_MODES.has(source.titleBar) ? source.titleBar : 'hide'
	return {
		enabled: source.enabled !== false,
		animation,
		playOn,
		durationMs,
		holdMs,
		introTailMs,
		titleBar,
		introVideo: mediaPath(source.introVideo, DEFAULT_INTRO_VIDEO),
		backgroundVideo: mediaPath(source.backgroundVideo, ''),
		backgroundScope: source.backgroundScope === 'empty' ? 'empty' : 'always',
		backgroundOpacity,
		backgroundBlur,
		backgroundOpacityConversation,
		backgroundBlurConversation,
		scanlines: source.scanlines !== false,
		grid: source.grid !== false,
		glow,
	}
}

/**
 * Normalize one media setting into a package-root-relative path.
 * @param {unknown} value raw config value.
 * @param {string} fallback value used when the field is absent.
 * @returns {string} a relative path, or '' to disable the slot.
 */
function mediaPath(value, fallback) {
	if (value === undefined) return fallback
	if (typeof value !== 'string') return fallback
	const trimmed = value.trim()
	return trimmed
}

/**
 * Read one authored theme file, reusing the cached text while mtime and size are
 * unchanged. Returns `undefined` for a missing/unreadable file rather than
 * throwing, so a half-installed theme still boots.
 * @param {string} file file name inside `theme/`.
 * @returns {{text: string, rev: string} | undefined} file text plus a revision token.
 */
export function readThemeFile(file) {
	const absolute = join(THEME_DIR, file)
	let stat
	try {
		stat = statSync(absolute)
	} catch {
		return undefined
	}
	const rev = `${stat.mtimeMs.toString(36)}-${String(stat.size)}`
	const cached = fileCache.get(file)
	if (cached !== undefined && cached.rev === rev) return cached
	let text
	try {
		text = readFileSync(absolute, 'utf8')
	} catch {
		return undefined
	}
	const next = { text, rev }
	fileCache.set(file, next)
	return next
}

/**
 * Load and validate the palette document. The parsed document is memoized by
 * file revision, so editing `theme/palette.json` on disk takes effect on the
 * next index render without restarting the host.
 * @returns {object | undefined} parsed palette, or undefined when unusable.
 */
export function loadPalette() {
	const asset = readThemeFile('palette.json')
	if (asset === undefined) return undefined
	if (paletteCache !== undefined && paletteCache.rev === asset.rev) return paletteCache.palette
	let parsed
	try {
		parsed = JSON.parse(asset.text)
	} catch {
		return undefined
	}
	if (parsed === null || typeof parsed !== 'object' || parsed.alias === undefined) return undefined
	paletteCache = { rev: asset.rev, palette: parsed }
	return parsed
}

/** Reset the palette cache (used by tests and by the diagnostics route). */
export function resetPaletteCache() {
	paletteCache = undefined
}

/**
 * Render the token layer: the DeepSeek Blue design is single-scheme (dark), so
 * the palette's dark projection is emitted under both `html body` and
 * `html body[data-ds-dark-theme]`. That locks the design even when the DSH
 * appearance preference is light, without depending on the shell's attribute.
 * Alias tokens carry `!important` so they also beat the inline values ui-layout
 * writes on <body>; the design-platform surfaces and metrics follow.
 * @param {object} palette parsed palette document.
 * @param {ReturnType<typeof readOptions>} options normalized config.
 * @returns {string} CSS text.
 */
export function composeTokenCss(palette, options) {
	const light = []
	const dark = []
	for (const [token, pair] of Object.entries(palette.alias ?? {})) {
		if (pair === null || typeof pair !== 'object') continue
		if (typeof pair.light !== 'string' || typeof pair.dark !== 'string') continue
		light.push(`${token}:${pair.dark} !important`)
		dark.push(`${token}:${pair.dark} !important`)
	}
	const specificLight = []
	const specificDark = []
	for (const [token, pair] of Object.entries(palette.specific ?? {})) {
		if (pair === null || typeof pair !== 'object') continue
		if (typeof pair.light !== 'string' || typeof pair.dark !== 'string') continue
		/* `!important` matters once <body> carries data-ds-dark-theme: the app's own
		   `body[data-ds-dark-theme]` block outranks plain `html body`, and its default
		   surfaces would win over the palette. */
		specificLight.push(`${token}:${pair.dark} !important`)
		specificDark.push(`${token}:${pair.dark} !important`)
	}
	const metrics = []
	for (const [token, value] of Object.entries(palette.metrics ?? {})) {
		if (typeof value === 'string') metrics.push(`${token}:${value}`)
	}
	const blocks = []
	/* Specificity notes: the injected <style> lands before the app's own
	   stylesheets in a browser index response, so equal-specificity rules would
	   lose. `html body` outranks `body`, `html body[data-ds-dark-theme]` outranks
	   `body[data-ds-dark-theme]`, and `:root:root` outranks `:root`. Alias tokens
	   additionally carry `!important` so they also beat the inline values
	   ui-layout writes on <body>. */
	if (light.length > 0) blocks.push(`html body{${light.join(';')}}`)
	if (dark.length > 0) blocks.push(`html body[data-ds-dark-theme]{${dark.join(';')}}`)
	if (specificLight.length > 0) blocks.push(`html body{${specificLight.join(';')}}`)
	if (specificDark.length > 0) blocks.push(`html body[data-ds-dark-theme]{${specificDark.join(';')}}`)
	if (metrics.length > 0) blocks.push(`:root:root{${metrics.join(';')}}`)
	/* Native form controls and scrollbars must follow the locked dark design. */
	blocks.push(':root:root{color-scheme:dark !important}')
	blocks.push(
		`:root:root{--orbital-scanline-opacity:${options.scanlines ? '0.035' : '0'};--orbital-grid-opacity:${options.grid ? '0.85' : '0'};--orbital-glow:${GLOW_STRENGTH[options.glow] ?? '1'};--orbital-veil-duration:${String(options.durationMs)}ms;--orbital-bg-opacity:${String(options.backgroundOpacity)};--orbital-bg-blur:${String(options.backgroundBlur)}px;--orbital-bg-opacity-conversation:${String(options.backgroundOpacityConversation)};--orbital-bg-blur-conversation:${String(options.backgroundBlurConversation)}px}`,
	)
	return blocks.join('\n')
}

/**
 * Compose the complete injected stylesheet: token layer + authored stylesheet,
 * wrapped in a revision marker the browser half can read back.
 * @param {ReturnType<typeof readOptions>} options normalized config.
 * @returns {{css: string, rev: string} | undefined} stylesheet text and revision.
 */
export function composeStyleSheet(options) {
	const palette = loadPalette()
	if (palette === undefined) return undefined
	const stylesheet = readThemeFile('theme.css')
	const paletteFile = readThemeFile('palette.json')
	const rev = [
		paletteFile?.rev ?? 'none',
		stylesheet?.rev ?? 'none',
		options.scanlines ? 's1' : 's0',
		options.grid ? 'g1' : 'g0',
		options.glow,
		String(options.durationMs),
		String(options.backgroundOpacity),
		String(options.backgroundBlur),
		String(options.backgroundOpacityConversation),
		String(options.backgroundBlurConversation),
	].join('.')
	const css = `${STYLE_MARKER} rev:${rev} */\n${composeTokenCss(palette, options)}\n${stylesheet?.text ?? ''}`
	return { css, rev }
}

/**
 * Build the structured index-injection rows for one index render. Pure given
 * the current files on disk; the caller decides whether to push them.
 * @param {ReturnType<typeof readOptions>} options normalized config.
 * @returns {Array<object>} injection rows in render order.
 */
export function composeInjections(options) {
	const sheet = composeStyleSheet(options)
	if (sheet === undefined) return []
	const rows = [
		{
			kind: 'global',
			name: '__DSH_THEME_BOOT__',
			value: {
				enabled: options.enabled,
				animation: options.animation,
				playOn: options.playOn,
				durationMs: options.durationMs,
				holdMs: options.holdMs,
				introTailMs: options.introTailMs,
				titleBar: options.titleBar,
				introSrc: options.animation !== 'none' && options.introVideo !== '' ? `${ROUTE_BASE}/video/intro` : null,
				backgroundSrc: options.backgroundVideo === '' ? null : `${ROUTE_BASE}/video/bg`,
				backgroundScope: options.backgroundScope,
			},
		},
		{ kind: 'style', text: sheet.css },
	]

	if (options.animation !== 'none') {
		const veil = readThemeFile('boot.html')
		if (veil !== undefined) rows.push({ kind: 'html', placement: 'body', html: veil.text })
	}

	/* The controller is always shipped: with no veil it is a no-op, but it also
	   defines the replay entry point the sidebar button uses. */
	const controller = readThemeFile('boot.js')
	if (controller !== undefined) rows.push({ kind: 'script', placement: 'body', text: controller.text })

	return rows
}

/** Loopback-only guard for the theme routes. */
function isLoopback(request) {
	const address = request.socket?.remoteAddress ?? ''
	return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.')
}

/**
 * Resolve one configured media path to a file that lives inside the package and
 * has a video extension. Anything else (missing file, traversal, unknown type)
 * resolves to undefined and the route answers 404.
 * @param {string} relative package-root-relative path from the config.
 * @returns {{absolute: string, type: string} | undefined} the streamable file.
 */
export function resolveMedia(relative) {
	if (typeof relative !== 'string' || relative.trim() === '') return undefined
	const absolute = resolve(PACKAGE_ROOT, relative)
	if (absolute !== PACKAGE_ROOT && !absolute.startsWith(PACKAGE_ROOT + sep)) return undefined
	const type = MEDIA_TYPES.get(extname(absolute).toLowerCase())
	if (type === undefined) return undefined
	try {
		if (!statSync(absolute).isFile()) return undefined
	} catch {
		return undefined
	}
	return { absolute, type }
}

/**
 * Stream one video with byte-range support, which is what the browser's media
 * stack uses to start playback and to seek. Small intro films are usually fine
 * without ranges, but a 4K file is not: without a 206 answer Chrome stalls.
 * @param {import('node:http').IncomingMessage} request incoming request.
 * @param {import('node:http').ServerResponse} response response to own.
 * @param {{absolute: string, type: string}} media resolved media file.
 */
export function serveMedia(request, response, media) {
	let size
	try {
		size = statSync(media.absolute).size
	} catch {
		response.writeHead(404)
		response.end()
		return
	}
	const head = request.method === 'HEAD'
	const base = {
		'content-type': media.type,
		'accept-ranges': 'bytes',
		'cache-control': 'no-cache',
	}
	const range = typeof request.headers.range === 'string' ? request.headers.range.trim() : ''
	if (range === '') {
		response.writeHead(200, { ...base, 'content-length': String(size) })
		if (head) {
			response.end()
			return
		}
		createReadStream(media.absolute).pipe(response)
		return
	}
	const match = /^bytes=(\d*)-(\d*)$/u.exec(range)
	if (match === null) {
		response.writeHead(416, { ...base, 'content-range': `bytes */${String(size)}` })
		response.end()
		return
	}
	const [, rawStart, rawEnd] = match
	let start
	let end
	if (rawStart === '') {
		const suffix = Number(rawEnd)
		if (!Number.isFinite(suffix) || suffix <= 0) {
			response.writeHead(416, { ...base, 'content-range': `bytes */${String(size)}` })
			response.end()
			return
		}
		start = Math.max(0, size - suffix)
		end = size - 1
	} else {
		start = Number(rawStart)
		end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
	}
	if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
		response.writeHead(416, { ...base, 'content-range': `bytes */${String(size)}` })
		response.end()
		return
	}
	response.writeHead(206, {
		...base,
		'content-length': String(end - start + 1),
		'content-range': `bytes ${String(start)}-${String(end)}/${String(size)}`,
	})
	if (head) {
		response.end()
		return
	}
	createReadStream(media.absolute, { start, end }).pipe(response)
}

/** Terminate one JSON response. */
function sendJson(response, status, value) {
	const body = JSON.stringify(value)
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(body),
		'cache-control': 'no-store',
	})
	response.end(body)
}

/**
 * Serve one `/api/dsh-theme/*` request.
 * @param {object} options normalized config.
 * @param {import('node:http').IncomingMessage} request incoming request.
 * @param {import('node:http').ServerResponse} response response to own.
 */
export function handleRoute(options, request, response) {
	if (!isLoopback(request)) {
		sendJson(response, 403, { error: 'the orbital theme only answers loopback requests' })
		return
	}
	const method = request.method ?? 'GET'
	if (method !== 'GET' && method !== 'HEAD') {
		response.writeHead(405, { allow: 'GET, HEAD' })
		response.end()
		return
	}
	const url = new URL(request.url ?? '/', 'http://127.0.0.1')
	const suffix = url.pathname.slice(ROUTE_BASE.length)

	if (suffix === '/video/intro' || suffix === '/video/bg') {
		const relative = suffix === '/video/intro' ? options.introVideo : options.backgroundVideo
		const media = resolveMedia(relative)
		if (media === undefined) {
			sendJson(response, 404, { error: `no video configured for ${suffix}` })
			return
		}
		serveMedia(request, response, media)
		return
	}

	if (suffix === '/injected.css') {
		const sheet = composeStyleSheet(options)
		if (sheet === undefined) {
			sendJson(response, 404, { error: 'theme palette is missing or invalid' })
			return
		}
		const etag = `"${sheet.rev}"`
		const requested = url.searchParams.get('rev')
		if (requested === sheet.rev || request.headers['if-none-match'] === etag) {
			response.writeHead(304, { etag })
			response.end()
			return
		}
		response.writeHead(200, {
			'content-type': 'text/css; charset=utf-8',
			'content-length': Buffer.byteLength(sheet.css),
			etag,
			'cache-control': 'no-cache',
		})
		if (method === 'HEAD') response.end()
		else response.end(sheet.css)
		return
	}

	if (suffix === '/status') {
		const files = {}
		for (const [, entry] of SERVED_FILES) {
			const asset = readThemeFile(entry.file)
			files[entry.file] = asset === undefined ? null : asset.rev
		}
		sendJson(response, 200, {
			name,
			version: 1,
			enabled: options.enabled,
			animation: options.animation,
			playOn: options.playOn,
			durationMs: options.durationMs,
			holdMs: options.holdMs,
			introTailMs: options.introTailMs,
			titleBar: options.titleBar,
			introVideo: options.introVideo,
			backgroundVideo: options.backgroundVideo,
			backgroundScope: options.backgroundScope,
			backgroundOpacity: options.backgroundOpacity,
			backgroundBlur: options.backgroundBlur,
			backgroundOpacityConversation: options.backgroundOpacityConversation,
			backgroundBlurConversation: options.backgroundBlurConversation,
			scanlines: options.scanlines,
			grid: options.grid,
			glow: options.glow,
			revision: composeStyleSheet(options)?.rev ?? null,
			files,
		})
		return
	}

	const wanted = SERVED_FILES.get(suffix)

	if (wanted === undefined) {
		sendJson(response, 404, { error: `no such theme asset: ${suffix}` })
		return
	}

	const asset = readThemeFile(wanted.file)
	if (asset === undefined) {
		sendJson(response, 404, { error: `theme asset is not installed: ${wanted.file}` })
		return
	}

	const etag = `"${asset.rev}"`
	if (request.headers['if-none-match'] === etag) {
		response.writeHead(304, { etag })
		response.end()
		return
	}
	response.writeHead(200, {
		'content-type': wanted.type,
		'content-length': Buffer.byteLength(asset.text),
		etag,
		'cache-control': 'no-cache',
	})
	if (method === 'HEAD') response.end()
	else response.end(asset.text)
}

/**
 * Mount the theme.
 * @param {object} ctx host plugin context.
 * @param {unknown} config bundle-row config.
 */
export function apply(ctx, config) {
	const options = readOptions(config)
	if (!options.enabled) {
		ctx.logger?.info?.('dsh-theme-orbital: disabled by config; injecting nothing')
		return
	}

	ctx.on('webserver/index-inject', (table) => {
		try {
			const rows = composeInjections(options)
			if (rows.length === 0) {
				ctx.logger?.warn?.('dsh-theme-orbital: theme/palette.json is missing or invalid; index left untouched')
				return
			}
			table.push(...rows)
		} catch (error) {
			/* A throwing listener would break the whole index render. */
			ctx.logger?.warn?.(`dsh-theme-orbital: index injection skipped: ${error?.message ?? error}`)
		}
	})

	ctx.inject(['webServer'], (scope) => {
		scope.effect(
			() =>
				scope.webServer.register({
					kind: 'prefix',
					path: ROUTE_BASE,
					handler: (request, response) => {
						try {
							handleRoute(options, request, response)
						} catch (error) {
							ctx.logger?.warn?.(`dsh-theme-orbital: route failed: ${error?.message ?? error}`)
							if (!response.headersSent) sendJson(response, 500, { error: 'theme route failed' })
							else response.end()
						}
					},
				}),
			'dsh-theme-orbital: routes',
		)
		ctx.logger?.info?.(`dsh-theme-orbital: assets served from ${THEME_DIR}`)
	})
}
