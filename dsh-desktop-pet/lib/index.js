/**
 * dsh-desktop-pet — host half.
 *
 * A Live2D desk pet for the DSH Web GUI needs four things the browser cannot
 * provide on its own, and this half exists to provide exactly those:
 *
 *   1. The pet's files. The model lives inside this package, so the host reads
 *      it from disk and serves only what `c_0120.model3.json` actually
 *      references (its "reference closure") — a request for anything else,
 *      including any `..` traversal, is a 404.
 *   2. The proprietary Cubism Core runtime. Live2D's licence forbids shipping
 *      `live2dcubismcore.min.js` inside a redistributable package, so the host
 *      fetches it once from Live2D's official CDN, caches it under
 *      `$DSH_HOME/desktop-pet/.runtime/`, and serves that copy from then on.
 *   3. The MIT vendor bundle (`lib/live2d-vendor.js`, built by
 *      `npm run build:vendor`) as a lazily requested script.
 *   4. The DSH session's activity, folded into one coarse phase and pushed to
 *      the page over SSE, so the pet follows the agent instead of only
 *      reacting to clicks.
 *
 * Everything is dependency-free: no `@deepseek-ai/*` import, because a
 * profile-installed plugin cannot resolve those anyway.
 *
 * @module dsh-desktop-pet
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-desktop-pet'

/**
 * The one host service this plugin contributes to. `webServer` is required
 * rather than optional: without an HTTP carrier there is no page to hang a pet
 * on, and a silently inactive plugin is harder to diagnose than a missing
 * injection.
 */
export const inject = ['webServer']

/** Everything this plugin serves lives under one prefix. */
const ROUTE_BASE = '/api/dsh-pet'

/** Live2D's official distribution point for the Cubism Core runtime. */
const CUBISM_CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'

/** How long a freshly fetched Cubism Core may be reused before revalidation. */
const CORE_FETCH_TIMEOUT_MS = 30_000

/** SSE keep-alive interval: an idle page must not look like a dead socket. */
const SSE_PING_MS = 25_000

/** How long the "done" celebration is held before falling back. */
const DONE_HOLD_MS = 3_500

/** How long a tool ping is held (long enough to bridge consecutive calls). */
const TOOL_HOLD_MS = 1_400

/** How long a failure is shown before the pet settles back. */
const FAILED_HOLD_MS = 5_000

/** Extensions the reference closure is allowed to pull in. */
const ASSET_EXTENSIONS = new Set([
	'.json', '.moc3', '.png', '.jpg', '.jpeg', '.webp', '.wav', '.mp3', '.ogg', '.motion3.json', '.exp3.json',
])

/** Media types for the handful of file kinds a Live2D pet actually uses. */
const MEDIA_TYPES = new Map([
	['.json', 'application/json; charset=utf-8'],
	['.moc3', 'application/octet-stream'],
	['.png', 'image/png'],
	['.jpg', 'image/jpeg'],
	['.jpeg', 'image/jpeg'],
	['.webp', 'image/webp'],
	['.js', 'text/javascript; charset=utf-8'],
	['.wav', 'audio/wav'],
	['.mp3', 'audio/mpeg'],
	['.ogg', 'audio/ogg'],
])

/** This package's own directory, resolved from the module URL. */
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * Project the loader-validated config onto plain values with defaults.
 * @param config - the composition entry's configuration.
 * @returns resolved plugin options.
 */
export function readOptions(config) {
	const source = config !== null && typeof config === 'object' ? config : {}
	return {
		petId: nonEmptyString(source.petId) ?? 'ds-whale-girl',
		petRoot: path.resolve(PACKAGE_ROOT, nonEmptyString(source.petRoot) ?? 'assets/pet'),
		vendorFile: path.resolve(PACKAGE_ROOT, nonEmptyString(source.vendorFile) ?? 'lib/live2d-vendor.js'),
		cacheRoot: path.resolve(
			nonEmptyString(source.cacheRoot) ?? path.join(dshHome(), 'desktop-pet'),
			'.runtime',
		),
		allowRemoteCoreFetch: source.allowRemoteCoreFetch ?? true,
	}
}

/**
 * Register the routes and the activity mirror.
 * @param ctx - the plugin context.
 * @param config - the composition entry's validated configuration.
 */
export function apply(ctx, config) {
	const options = readOptions(config)
	const assets = new AssetIndex(options.petRoot)
	const core = new CubismCoreCache(options)
	const hub = new ActivityHub()

	attachActivityEvents(ctx, hub)

	ctx.effect(
		() => ctx.webServer.register({
			kind: 'prefix',
			path: ROUTE_BASE,
			handler: (req, res) => {
				void handle(req, res).catch((error) => {
					ctx.logger?.warn?.(`desktop-pet: ${error?.message ?? error}`)
					sendJson(res, 500, { error: 'internal error' })
				})
			},
		}),
		'desktop-pet.routes()',
	)

	ctx.effect(() => () => hub.dispose(), 'desktop-pet.activity()')

	/**
	 * Dispatch one request. Everything is answered from this one handler so the
	 * plugin claims a single prefix and cannot collide with another route owner.
	 */
	async function handle(req, res) {
		if (!isLoopback(req)) {
			sendJson(res, 403, { error: 'the desktop pet only answers loopback requests' })
			return
		}
		const url = new URL(req.url ?? '/', 'http://127.0.0.1')
		const route = url.pathname.slice(ROUTE_BASE.length).replace(/^\/+/, '')
		const method = req.method ?? 'GET'
		if (method !== 'GET' && method !== 'HEAD') {
			sendJson(res, 405, { error: 'method not allowed' })
			return
		}

		if (route === 'catalog') {
			sendJson(res, 200, await buildCatalog(options, assets, hub, core))
			return
		}
		if (route === 'events') {
			streamActivity(req, res, hub)
			return
		}
		if (route === 'runtime/core.js') {
			await serveCore(req, res, core, options, method === 'HEAD')
			return
		}
		if (route === 'runtime/vendor.js') {
			await serveFile(req, res, options.vendorFile, method === 'HEAD', 'text/javascript; charset=utf-8')
			return
		}
		if (route.startsWith('asset/')) {
			const relative = safeDecode(route.slice('asset/'.length))
			if (relative === undefined) {
				sendJson(res, 400, { error: 'malformed asset path' })
				return
			}
			await serveAsset(req, res, assets, relative, method === 'HEAD')
			return
		}
		sendJson(res, 404, { error: `no such desktop-pet route: /${route}` })
	}

	ctx.logger?.info?.(`desktop-pet: serving ${options.petId} from ${options.petRoot}`)
}

// --------------------------------------------------------------------- assets

/**
 * The set of files a pet is allowed to be served, derived from the model's own
 * references rather than from a directory listing: a pet is a *closure*, not a
 * folder, so a stray file next to the model is not reachable.
 */
class AssetIndex {
	/** @param petRoot - the directory a pet's files live in. */
	constructor(petRoot) {
		this.petRoot = petRoot
		this.closure = new Map()
		this.manifest = undefined
		this.expressions = {}
		this.error = undefined
		this.stamp = undefined
		this.pending = undefined
		this.rebuilds = 0
		this.misses = 0
		this.healed = 0
	}

	/**
	 * Compute the pet manifest and the reference closure, reusing them until the
	 * files they were derived from change.
	 *
	 * Two properties matter here, and both were learned the hard way:
	 *
	 *   * **One rebuild at a time.** A page load asks for the catalog, then fires
	 *     44 expression requests and a handful of model assets concurrently. Every
	 *     caller shares the single in-flight rebuild instead of starting its own.
	 *   * **Atomic replacement.** The rebuilt closure is a new map that is swapped
	 *     in one assignment. Clearing the live map instead let a request that
	 *     arrived mid-rebuild read a half-filled one and 404 on a texture that was
	 *     sitting right there on disk.
	 *
	 * @returns the manifest, or `undefined` when the pet cannot be read.
	 */
	async load() {
		if (this.pending !== undefined) return this.pending
		this.pending = this.#rebuild().finally(() => {
			this.pending = undefined
		})
		return this.pending
	}

	/** The single rebuild behind `load()`. */
	async #rebuild(force = false) {
		const stamp = await this.#stamp()
		if (!force && this.manifest !== undefined && this.stamp === stamp) return this.manifest
		this.rebuilds += 1

		const closure = new Map()
		let manifest
		let expressions = {}
		let error
		try {
			const manifestPath = path.join(this.petRoot, 'pet.json')
			manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
			closure.set('pet.json', manifestPath)
			if (typeof manifest.preview === 'string') this.#claim(closure, manifest.preview)
			if (typeof manifest.model === 'string') {
				const modelPath = this.#claim(closure, manifest.model)
				if (modelPath === undefined) throw new Error(`model file is missing: ${manifest.model}`)
				await this.#expand(closure, modelPath)
				expressions = await this.#readExpressions(modelPath)
			}
		} catch (cause) {
			manifest = undefined
			error = cause?.message ?? String(cause)
		}

		this.closure = closure
		this.manifest = manifest
		this.expressions = expressions
		this.error = error
		this.stamp = stamp
		return manifest
	}

	/** A cheap content fingerprint of the two files the index is derived from. */
	async #stamp() {
		const parts = []
		for (const relative of ['pet.json', await this.#declaredModel()]) {
			if (relative === undefined) {
				parts.push('-')
				continue
			}
			try {
				const stat = await fsp.stat(path.join(this.petRoot, relative))
				parts.push(`${stat.size}:${Math.floor(stat.mtimeMs)}`)
			} catch {
				parts.push('missing')
			}
		}
		return parts.join('|')
	}

	/** The model path named by `pet.json`, read without going through the cache. */
	async #declaredModel() {
		if (this.manifest !== undefined && typeof this.manifest.model === 'string') return this.manifest.model
		try {
			const manifest = JSON.parse(await fsp.readFile(path.join(this.petRoot, 'pet.json'), 'utf8'))
			return typeof manifest.model === 'string' ? manifest.model : undefined
		} catch {
			return undefined
		}
	}

	/**
	 * Read the model's expression table, so the browser half can fetch each
	 * expression file and drive the model's parameters itself. The engine holds
	 * exactly one expression at a time, which cannot express a look made of
	 * several slots at once.
	 * @param modelPath - the model3.json.
	 * @returns expression name -> pet-relative file path.
	 */
	async #readExpressions(modelPath) {
		const table = {}
		try {
			const model = JSON.parse(await fsp.readFile(modelPath, 'utf8'))
			const base = path.dirname(path.relative(this.petRoot, modelPath))
			for (const entry of model.FileReferences?.Expressions ?? []) {
				if (typeof entry?.Name !== 'string' || typeof entry?.File !== 'string') continue
				const relative = base === '.' ? entry.File : `${base}/${entry.File}`
				table[entry.Name] = relative.replace(/\\/g, '/')
			}
		} catch {
			/* a model without expressions simply has an empty table */
		}
		return table
	}

	/**
	 * Serve-side lookup: resolve one pet-relative path against the reference
	 * closure.
	 *
	 * A miss is the one moment the derived closure is worth recomputing. The
	 * closure is built from the model's own references, so a miss normally means
	 * the path really is not part of this pet — but it can also mean the closure
	 * is stale, or was read while a rebuild was swapping it. Answering 404 for a
	 * file that is sitting on disk is the failure users actually notice, so before
	 * giving up this checks whether the path is a real file inside the pet and, if
	 * it is, rebuilds once and looks again.
	 *
	 * The whitelist still holds: a rebuild only ever claims what the model
	 * references, so a file that is merely *present* still resolves to nothing.
	 *
	 * @param relative - a path from a request.
	 * @returns the absolute path, or `undefined` when it is not in the closure.
	 */
	async resolve(relative) {
		const normalised = normaliseRelative(relative)
		if (normalised === undefined) return undefined
		const hit = this.closure.get(normalised)
		if (hit !== undefined) return hit

		const candidate = path.resolve(this.petRoot, normalised)
		const root = path.resolve(this.petRoot)
		if (candidate !== root && !candidate.startsWith(root + path.sep)) return undefined
		if (!isFile(candidate)) return undefined

		this.misses += 1
		await this.#rebuild(true)
		const healed = this.closure.get(normalised)
		if (healed !== undefined) this.healed += 1
		return healed
	}

	/** A snapshot of the index for diagnostics. */
	get stats() {
		return { size: this.closure.size, rebuilds: this.rebuilds, misses: this.misses, healed: this.healed }
	}

	#claim(closure, relative) {
		const normalised = normaliseRelative(relative)
		if (normalised === undefined) return undefined
		const absolute = path.resolve(this.petRoot, normalised)
		const root = path.resolve(this.petRoot)
		if (absolute !== root && !absolute.startsWith(root + path.sep)) return undefined
		if (!isFile(absolute)) return undefined
		closure.set(normalised, absolute)
		return absolute
	}

	/**
	 * Walk one JSON asset and claim everything it references, recursively, so a
	 * model's textures, motions, expressions, physics, and pose files all land
	 * in the closure without anyone maintaining a list.
	 * @param closure - the map being built.
	 * @param absolute - the JSON file to expand.
	 */
	async #expand(closure, absolute) {
		let parsed
		try {
			parsed = JSON.parse(await fsp.readFile(absolute, 'utf8'))
		} catch {
			return
		}
		const base = path.dirname(absolute)
		for (const candidate of collectStrings(parsed)) {
			if (!looksLikeAsset(candidate)) continue
			const referenced = path.resolve(base, candidate.replace(/\\/g, '/'))
			const relative = path.relative(this.petRoot, referenced)
			const claimed = this.#claim(closure, relative)
			if (claimed === undefined) continue
			if (claimed.toLowerCase().endsWith('.json')) await this.#expand(closure, claimed)
		}
	}
}

/**
 * Normalise a pet-relative path into the key the closure uses, or `undefined`
 * when it is empty, absolute, or contains a NUL byte.
 * @param relative - a path as written in a model file or received in a request.
 * @returns the normalised key, or `undefined`.
 */
function normaliseRelative(relative) {
	if (typeof relative !== 'string' || relative.length === 0) return undefined
	const normalised = relative.replace(/\\/g, '/').replace(/^\.\//, '')
	if (normalised.includes('\0') || path.isAbsolute(normalised)) return undefined
	return normalised
}

/** Every string value anywhere inside a parsed JSON document. */
function collectStrings(value, out = []) {
	if (typeof value === 'string') out.push(value)
	else if (Array.isArray(value)) for (const item of value) collectStrings(item, out)
	else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out)
	return out
}

/** Whether a JSON string value is worth trying to resolve as a pet file. */
function looksLikeAsset(value) {
	if (value.length === 0 || value.length > 512) return false
	if (value.includes('\0') || value.includes('://')) return false
	if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false
	const lower = value.toLowerCase()
	for (const extension of ASSET_EXTENSIONS) if (lower.endsWith(extension)) return true
	return false
}

/**
 * Serve one file out of the closure, with a metadata ETag so a page reload
 * revalidates instead of re-downloading four megabytes of textures.
 */
async function serveAsset(req, res, assets, relative, headOnly) {
	await assets.load()
	const absolute = await assets.resolve(relative)
	if (absolute === undefined) {
		sendJson(res, 404, { error: `not part of this pet's reference closure: ${relative}` })
		return
	}
	await serveFile(req, res, absolute, headOnly)
}

/** Send a file with an ETag, honouring `If-None-Match`. */
async function serveFile(req, res, absolute, headOnly, contentTypeOverride) {
	let stat
	try {
		stat = await fsp.stat(absolute)
	} catch {
		sendJson(res, 404, { error: 'file not found' })
		return
	}
	const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
	res.setHeader('etag', etag)
	res.setHeader('cache-control', 'no-cache')
	if (req?.headers?.['if-none-match'] === etag) {
		res.statusCode = 304
		res.end()
		return
	}
	res.statusCode = 200
	res.setHeader('content-type', contentTypeOverride ?? MEDIA_TYPES.get(path.extname(absolute).toLowerCase()) ?? 'application/octet-stream')
	res.setHeader('content-length', String(stat.size))
	if (headOnly) {
		res.end()
		return
	}
	await new Promise((resolve, reject) => {
		const stream = fs.createReadStream(absolute)
		stream.on('error', reject)
		stream.on('end', resolve)
		stream.pipe(res)
	})
}

// ----------------------------------------------------------------- cubism core

/**
 * The Cubism Core runtime, cached on disk. Live2D's licence keeps the file out
 * of this package; the CDN keeps the user from having to find it themselves.
 */
class CubismCoreCache {
	/** @param options - resolved plugin options. */
	constructor(options) {
		this.options = options
		this.file = path.join(options.cacheRoot, 'live2dcubismcore.min.js')
		this.status = 'unknown'
		this.detail = ''
		this.inflight = undefined
	}

	/** Whether a usable copy is already on disk. */
	async cached() {
		try {
			const stat = await fsp.stat(this.file)
			if (stat.size > 0) return true
		} catch {
			/* not cached yet */
		}
		return false
	}

	/**
	 * Ensure a usable copy exists, fetching it from Live2D when allowed.
	 * @returns the absolute path, or `undefined` when unavailable.
	 */
	async ensure() {
		if (await this.cached()) {
			this.status = 'cached'
			this.detail = this.file
			return this.file
		}
		if (!this.options.allowRemoteCoreFetch) {
			this.status = 'missing'
			this.detail = 'remote fetch disabled by config'
			return undefined
		}
		if (this.inflight === undefined) {
			this.inflight = this.#fetch().finally(() => {
				this.inflight = undefined
			})
		}
		return this.inflight
	}

	async #fetch() {
		try {
			const response = await fetch(CUBISM_CORE_URL, {
				signal: AbortSignal.timeout(CORE_FETCH_TIMEOUT_MS),
			})
			if (!response.ok) throw new Error(`CDN answered ${response.status}`)
			const body = await response.text()
			// A CDN error page is 200 with HTML; require the runtime's own symbol
			// before anything is written to disk.
			if (!body.includes('Live2DCubismCore')) throw new Error('downloaded file is not the Cubism Core runtime')
			await fsp.mkdir(path.dirname(this.file), { recursive: true })
			const temporary = `${this.file}.${process.pid}.tmp`
			await fsp.writeFile(temporary, body, 'utf8')
			await fsp.rename(temporary, this.file)
			this.status = 'downloaded'
			this.detail = CUBISM_CORE_URL
			return this.file
		} catch (error) {
			this.status = 'missing'
			this.detail = error?.message ?? String(error)
			return undefined
		}
	}
}

/** Answer the Cubism Core route, with a diagnosable body when it is absent. */
async function serveCore(req, res, core, options, headOnly) {
	const file = await core.ensure()
	if (file === undefined) {
		res.setHeader('x-dsh-pet-core', 'missing')
		sendJson(res, 502, {
			error: 'the Live2D Cubism Core runtime is unavailable',
			detail: core.detail,
			hint:
				'Download live2dcubismcore.min.js from the Live2D Cubism SDK for Web and place it at '
				+ path.join(options.cacheRoot, 'live2dcubismcore.min.js'),
		})
		return
	}
	res.setHeader('x-dsh-pet-core', core.status)
	await serveFile(req, res, file, headOnly, 'text/javascript; charset=utf-8')
}

// ------------------------------------------------------------------- activity

/**
 * The activity mirror: folds DSH session events into one coarse phase and fans
 * that phase out to every subscribed SSE response.
 */
class ActivityHub {
	constructor() {
		this.phase = 'idle'
		this.running = false
		this.listeners = new Set()
		this.holdTimer = undefined
	}

	/** Current snapshot, sent as the first frame of every stream. */
	snapshot() {
		return { phase: this.phase, at: Date.now() }
	}

	/** Subscribe one SSE response; returns the unsubscribe function. */
	subscribe(listener) {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	/** Where the pet settles once a transient phase expires. */
	#base() {
		return this.running ? 'thinking' : 'idle'
	}

	/** Enter a phase immediately, cancelling any pending fallback. */
	set(phase) {
		if (this.holdTimer !== undefined) {
			clearTimeout(this.holdTimer)
			this.holdTimer = undefined
		}
		if (this.phase === phase) return
		this.phase = phase
		this.#emit()
	}

	/**
	 * Play a short phase and fall back, unless something else takes over first.
	 * @param phase - the transient phase.
	 * @param ms - how long to hold it.
	 * @param fallback - the phase to return to (defaults to the current base).
	 */
	hold(phase, ms, fallback) {
		if (this.holdTimer !== undefined) clearTimeout(this.holdTimer)
		this.phase = phase
		this.#emit()
		this.holdTimer = setTimeout(() => {
			this.holdTimer = undefined
			const next = fallback ?? this.#base()
			if (this.phase !== phase) return
			this.phase = next
			this.#emit()
		}, ms)
		this.holdTimer?.unref?.()
	}

	#emit() {
		const payload = this.snapshot()
		for (const listener of this.listeners) {
			try {
				listener(payload)
			} catch {
				/* one dead stream must not break the others */
			}
		}
	}

	dispose() {
		if (this.holdTimer !== undefined) clearTimeout(this.holdTimer)
		this.holdTimer = undefined
		this.listeners.clear()
	}
}

/**
 * Fold the official DSH events into hub phases.
 *
 * Waterfall events (`approval/request`, `user-questions/request`) are observed
 * without ever deciding anything: the observer runs inside its own `try`, and
 * `next()` is called unconditionally afterwards, so a pet bug can never stall
 * an approval or a question for the whole session.
 */
function attachActivityEvents(ctx, hub) {
	const listen = (event, handler) => {
		try {
			ctx.on(event, handler)
		} catch {
			/* a host that does not carry this event simply keeps mirroring the rest */
		}
	}

	listen('agent/status', (payload) => {
		const running = payload?.status === 'running'
		const wasRunning = hub.running
		hub.running = running
		if (running) {
			hub.set('thinking')
			return
		}
		// A turn that just finished deserves a visible beat before the pet settles.
		if (wasRunning) hub.hold('done', DONE_HOLD_MS, 'idle')
		else hub.set('idle')
	})

	// `tools/result` is an emit, not a waterfall: observing it cannot influence
	// tool dispatch at all.
	listen('tools/result', () => {
		hub.hold('tool', TOOL_HOLD_MS)
	})

	listen('agent/error', () => {
		hub.hold('failed', FAILED_HOLD_MS)
	})

	listen('subagent/start', () => {
		hub.hold('tool', TOOL_HOLD_MS)
	})

	const observe = (event, handler) => {
		listen(event, (...args) => {
			const next = args[args.length - 1]
			try {
				handler(args[0])
			} catch {
				/* never let an observation break the chain */
			}
			return typeof next === 'function' ? next() : undefined
		})
	}
	observe('approval/request', () => hub.set('waiting'))
	observe('user-questions/request', () => hub.set('waiting'))
}

/** Stream activity as server-sent events for the lifetime of one page. */
function streamActivity(req, res, hub) {
	res.writeHead(200, {
		'content-type': 'text/event-stream; charset=utf-8',
		'cache-control': 'no-cache, no-transform',
		connection: 'keep-alive',
		'x-accel-buffering': 'no',
	})
	res.write('retry: 3000\n\n')
	const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
	send(hub.snapshot())
	const unsubscribe = hub.subscribe(send)
	const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS)
	ping.unref?.()
	const close = () => {
		clearInterval(ping)
		unsubscribe()
	}
	req.on('close', close)
	res.on('close', close)
}

// -------------------------------------------------------------------- catalog

/** The JSON document the browser half boots from. */
async function buildCatalog(options, assets, hub, core) {
	const manifest = await assets.load()
	const coreAvailable = await core.cached()
	const model = manifest !== undefined && typeof manifest.model === 'string'
		? `asset/${manifest.model}`
		: undefined
	return {
		ok: manifest !== undefined,
		petId: options.petId,
		manifest,
		expressions: assets.expressions,
		error: assets.error,
		closure: assets.stats,
		model: model === undefined ? undefined : `${ROUTE_BASE}/${model}`,
		preview: manifest?.preview === undefined ? undefined : `${ROUTE_BASE}/asset/${manifest.preview}`,
		runtime: {
			core: `${ROUTE_BASE}/runtime/core.js`,
			coreAvailable,
			coreSource: core.detail,
			vendor: `${ROUTE_BASE}/runtime/vendor.js`,
		},
		events: `${ROUTE_BASE}/events`,
		phase: hub.snapshot(),
	}
}

// -------------------------------------------------------------------- plumbing

/** This machine's DSH home directory. */
function dshHome() {
	const configured = process.env.DSH_HOME
	if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
	return path.join(os.homedir(), '.dsh')
}

/** Read an optional non-empty string. */
function nonEmptyString(value) {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	return trimmed.length === 0 ? undefined : trimmed
}

/** Whether a request came from this machine. */
function isLoopback(req) {
	const address = req.socket?.remoteAddress ?? ''
	return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Whether a path exists and is a regular file. */
function isFile(absolute) {
	try {
		return fs.statSync(absolute).isFile()
	} catch {
		return false
	}
}

/** Decode a URL path segment, rejecting malformed escapes. */
function safeDecode(value) {
	try {
		return decodeURIComponent(value)
	} catch {
		return undefined
	}
}

/** Send a JSON response. */
function sendJson(res, status, body) {
	const payload = JSON.stringify(body)
	res.statusCode = status
	res.setHeader('content-type', 'application/json; charset=utf-8')
	// The catalog describes live state (the pet's manifest and the current
	// session phase), so it must never be served from a cache.
	res.setHeader('cache-control', 'no-store')
	res.setHeader('content-length', String(Buffer.byteLength(payload)))
	res.end(payload)
}
