/**
 * The HTTP surface the settings page talks to.
 *
 * A profile-installed plugin cannot use the generated `@Remote` namespaces —
 * those need build-time artifacts this package does not carry — so the browser
 * half speaks to a plain route on `ctx.webServer`, the same way the sibling
 * desktop plugins do. The fence is the product's own: `ctx.connection` applies
 * the Host/Origin check and then browser authentication, exactly as every `/api`
 * request does, and without it the route degrades to loopback-only.
 *
 * Nothing here is a capability the model cannot already reach: writing a path and
 * starting an install are the same two decisions the tool surface implies.
 *
 * @module dsh-rea/route
 */

import path from 'node:path'
import { DEFAULT_VERSION, PACKAGE_NAME } from './install.js'

/** Every route this plugin owns lives under this prefix. */
export const ROUTE_BASE = '/api/dsh-rea'

/** Requests larger than this are refused before the body is read. */
const MAX_BODY_BYTES = 16 * 1024

/** How long the settings page's "test connection" is allowed to take. */
const PROBE_TIMEOUT_MS = 90_000

/**
 * Register the routes.
 * @param ctx - the plugin context.
 * @param surface - the runtime operations the page may invoke.
 * @returns the disposer that unregisters the route.
 */
export function registerRoutes(ctx, surface) {
	return ctx.webServer.register({
		kind: 'prefix',
		path: ROUTE_BASE,
		handler: async (req, res) => {
			try {
				await handle(ctx, surface, req, res)
			} catch (error) {
				sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
			}
		},
	})
}

/**
 * Dispatch one request.
 * @param ctx - the plugin context.
 * @param surface - the runtime operations.
 * @param req - the incoming request.
 * @param res - the response.
 */
async function handle(ctx, surface, req, res) {
	if (reject(ctx, req, res)) return

	const url = new URL(String(req.url), 'http://localhost')
	const route = url.pathname.slice(ROUTE_BASE.length) || '/'

	if (route === '/status') {
		if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
		sendJson(res, 200, { ok: true, ...surface.status() })
		return
	}

	if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
	const body = await readJsonBody(req)

	if (route === '/set-path') {
		const result = surface.setScript(body.path)
		sendJson(res, result.ok ? 200 : 400, result.ok ? { ok: true, ...surface.status() } : result)
		return
	}
	if (route === '/clear-path') {
		surface.clearScript()
		sendJson(res, 200, { ok: true, ...surface.status() })
		return
	}
	if (route === '/install') {
		const result = surface.install(body.version)
		sendJson(res, result.started === true ? 200 : 409, { ok: result.started === true, ...result, ...surface.status() })
		return
	}
	if (route === '/cancel-install') {
		const cancelled = surface.cancelInstall()
		sendJson(res, 200, { ok: true, cancelled, ...surface.status() })
		return
	}
	if (route === '/probe') {
		const started = Date.now()
		try {
			const tools = await withTimeout(surface.probe(), PROBE_TIMEOUT_MS)
			sendJson(res, 200, { ok: true, tools, elapsedMs: Date.now() - started, ...surface.status() })
		} catch (error) {
			sendJson(res, 200, { ok: false, error: error?.message ?? String(error), elapsedMs: Date.now() - started })
		}
		return
	}

	sendJson(res, 404, { ok: false, error: `未知的路由：${route}` })
}

/**
 * Which REA entry point a path names, if any.
 *
 * A user pasting a path usually copied the `rea.mjs` inside `scripts/`; some will
 * paste the package directory or the `bin` shim instead. Accepting all three is
 * the difference between a setting that works and one that refuses a correct
 * answer.
 *
 * @param raw - the raw path from the request.
 * @returns the resolved entry point, or an error description.
 */
export function normaliseScriptPath(raw) {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		return { ok: false, error: '请填写 rea.mjs 的绝对路径' }
	}
	const trimmed = raw.trim().replace(/^["']|["']$/gu, '')
	if (!path.isAbsolute(trimmed)) return { ok: false, error: '请填写绝对路径（例如 C:\\...\\rea-agents\\scripts\\rea.mjs）' }
	return { ok: true, path: path.resolve(trimmed) }
}

/**
 * Run a promise with a deadline.
 * @param promise - the work.
 * @param ms - the budget.
 * @returns its value.
 */
async function withTimeout(promise, ms) {
	let timer
	try {
		return await Promise.race([
			promise,
			new Promise((_resolve, rejectPromise) => {
				timer = setTimeout(() => rejectPromise(new Error(`操作超过 ${String(Math.round(ms / 1000))} 秒未完成`)), ms)
				timer.unref?.()
			}),
		])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

/**
 * Refuse a request that fails the shell's own fence.
 * @param ctx - the plugin context.
 * @param req - the incoming request.
 * @param res - the response.
 * @returns whether the request was refused.
 */
function reject(ctx, req, res) {
	let connection
	try {
		connection = ctx.get?.('connection')
	} catch {
		connection = undefined
	}
	if (connection !== undefined && connection !== null && typeof connection.requestRejection === 'function') {
		const status = connection.requestRejection(req)
		if (status !== undefined) {
			res.statusCode = status
			res.end()
			return true
		}
		return false
	}
	if (!isLoopbackRequest(req)) {
		sendJson(res, 403, { ok: false, error: '缺少 connection 服务，已退化为仅本机可访问' })
		return true
	}
	return false
}

/**
 * Whether a request's Host (and Origin, when present) is loopback.
 * @param req - the incoming request.
 * @returns whether it may be served.
 */
function isLoopbackRequest(req) {
	const hosts = [req.headers?.host, originHost(req.headers?.origin)].filter((value) => typeof value === 'string')
	if (hosts.length === 0) return false
	return hosts.every((value) => {
		const bare = value.replace(/:\d+$/u, '').replace(/^\[|\]$/gu, '').toLowerCase()
		return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1'
	})
}

/**
 * Extract the host from an Origin header.
 * @param origin - the raw header value.
 * @returns the host, or undefined.
 */
function originHost(origin) {
	if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') return undefined
	try {
		return new URL(origin).host
	} catch {
		return 'invalid'
	}
}

/**
 * Read and parse a JSON body under a size cap.
 * @param req - the incoming request.
 * @returns the parsed body.
 */
async function readJsonBody(req) {
	const raw = await new Promise((resolve, rejectPromise) => {
		const chunks = []
		let size = 0
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > MAX_BODY_BYTES) {
				rejectPromise(new Error(`请求体超过 ${String(MAX_BODY_BYTES)} 字节`))
				req.destroy?.()
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
		req.on('error', rejectPromise)
	})
	if (raw.trim().length === 0) return {}
	try {
		const parsed = JSON.parse(raw)
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be an object')
		return parsed
	} catch (error) {
		throw new Error(`请求体不是合法的 JSON 对象：${error?.message ?? error}`)
	}
}

/**
 * Answer with JSON and no caching.
 * @param res - the response.
 * @param status - the status code.
 * @param payload - the JSON payload.
 */
function sendJson(res, status, payload) {
	const body = Buffer.from(JSON.stringify(payload), 'utf8')
	res.statusCode = status
	res.setHeader('Content-Type', 'application/json; charset=utf-8')
	res.setHeader('Content-Length', String(body.byteLength))
	res.setHeader('Cache-Control', 'no-store')
	res.setHeader('X-Content-Type-Options', 'nosniff')
	res.end(body)
}

/**
 * Answer 405 with the allowed method.
 * @param res - the response.
 * @param allowed - the one method this route accepts.
 */
function methodNotAllowed(res, allowed) {
	res.setHeader('Allow', allowed)
	sendJson(res, 405, { ok: false, error: `此路由只接受 ${allowed}` })
}

/** Re-exported so the settings page and the manifest stay in step. */
export { DEFAULT_VERSION, PACKAGE_NAME }
