/**
 * The HTTP surface the settings page talks to.
 *
 * A profile-installed plugin cannot use the generated `@Remote` namespaces —
 * those need build-time artifacts this package deliberately does not depend on —
 * so the browser half speaks to a plain route registered on `ctx.webServer`,
 * exactly as the sibling desktop plugins do.
 *
 * Three properties make that acceptable for a secret store:
 *
 * 1. **The request fence is the product's own.** `ctx.connection.requestRejection`
 *    applies the Host/Origin fence and then browser authentication, which is the
 *    same check every `/api` request passes. A route that skipped it would be
 *    reachable by any local process.
 * 2. **Reads are metadata by default.** `GET /state` never carries a value; the
 *    only response that does is `POST /reveal`, which is opt-in per call and
 *    switchable off for a deployment.
 * 3. **Nothing is cached.** Every response is `no-store`, and the audit line
 *    names the key, never the value.
 *
 * @module dsh-secret-broker/route
 */

import path from 'node:path'
import { SecretStore, parseScope, pathContains, projectDirectory, projectScope } from './store.js'

/** Every route this plugin owns lives under this prefix. */
export const ROUTE_BASE = '/api/dsh-secret-broker'

/** Requests larger than this are refused before the body is read. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Register the routes.
 *
 * @param ctx - the plugin context.
 * @param store - the secret store.
 * @param options - resolved plugin options.
 * @returns the disposer that unregisters the route.
 */
export function registerRoutes(ctx, store, options) {
	return ctx.webServer.register({
		kind: 'prefix',
		path: ROUTE_BASE,
		handler: async (req, res) => {
			try {
				await handle(ctx, store, options, req, res)
			} catch (error) {
				// The webserver answers a throwing handler with a bare 400; a JSON
				// body is what the page can actually render.
				sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
			}
		},
	})
}

/**
 * Dispatch one request.
 *
 * @param ctx - the plugin context.
 * @param store - the secret store.
 * @param options - resolved plugin options.
 * @param req - the incoming request.
 * @param res - the response.
 */
async function handle(ctx, store, options, req, res) {
	if (reject(ctx, req, res)) return

	const url = new URL(String(req.url), 'http://localhost')
	const route = url.pathname.slice(ROUTE_BASE.length) || '/'

	if (route === '/state') {
		if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
		await store.ready
		sendJson(res, 200, stateOf(ctx, store, options))
		return
	}

	if (req.method !== 'POST') return methodNotAllowed(res, 'POST')

	const body = await readJsonBody(req)
	await store.ready

	if (route === '/set') {
		const entry = await store.set({ key: body.key, value: body.value, scope: body.scope, description: body.description })
		sendJson(res, 200, { ok: true, key: entry })
		return
	}
	if (route === '/delete') {
		const removed = await store.remove({ key: body.key, scope: body.scope })
		sendJson(res, 200, { ok: true, removed })
		return
	}
	if (route === '/promote') {
		const entry = await store.promote({ key: body.key, from: body.from, to: body.to })
		sendJson(res, 200, { ok: true, key: entry })
		return
	}
	if (route === '/reveal') {
		if (!options.allowReveal) {
			sendJson(res, 403, { ok: false, error: '此部署已关闭「查看已存值」' })
			return
		}
		const scope = String(body.scope ?? '')
		const key = String(body.key ?? '')
		const entry = store.all().find((candidate) => candidate.scope === scope && candidate.key === key)
		if (entry === undefined) {
			sendJson(res, 404, { ok: false, error: `没有找到 ${scope} 下的 ${key}` })
			return
		}
		// The audit trail records that a value was read and which one; the value
		// itself must never reach a log line.
		ctx.logger?.info?.(`secret-broker: 界面查看了 ${key}（${scope}）`)
		sendJson(res, 200, { ok: true, key, scope, value: entry.value })
		return
	}

	sendJson(res, 404, { ok: false, error: `未知的路由：${route}` })
}

/**
 * The settings page's whole read model — deliberately value-free.
 *
 * @param ctx - the plugin context.
 * @param store - the secret store.
 * @param options - resolved plugin options.
 * @returns the wire payload.
 */
function stateOf(ctx, store, options) {
	const sessions = listSessions(ctx)
	const live = new Set(sessions.map((session) => session.id))
	const liveCwds = sessions.map((session) => session.cwd).filter((cwd) => cwd.length > 0)
	return {
		ok: true,
		encryption: store.sealed ? 'dpapi' : 'none',
		locked: store.locked,
		writable: store.writable,
		dataDir: store.dataDir,
		allowReveal: options.allowReveal,
		titleBarValues: options.titleBarValues,
		redactResults: options.redactResults,
		keyPrefix: options.keyPrefix,
		warnings: store.warnings,
		sessions,
		projects: listProjects(store, sessions),
		keys: store.all().map((entry) => ({
			...SecretStore.metadata(entry),
			orphan: isOrphan(entry.scope, live, liveCwds),
		})),
	}
}

/**
 * Whether a scope can no longer apply to anything.
 *
 * A session scope dies with its session; a project scope outlives sessions and
 * only becomes orphaned when no live session is working in that directory or
 * beneath it — which is a fact worth surfacing, because the alternative is a
 * token nobody will ever use again sitting in the list forever.
 *
 * @param scope - the entry's canonical scope.
 * @param liveSessions - the ids of live sessions.
 * @param liveCwds - the working directories of live sessions.
 * @returns whether the scope currently applies to nothing.
 */
function isOrphan(scope, liveSessions, liveCwds) {
	const parsed = parseScope(scope)
	if (parsed === undefined) return false
	if (parsed.kind === 'session') return !liveSessions.has(parsed.sessionId)
	if (parsed.kind === 'project') return !liveCwds.some((cwd) => pathContains(parsed.directory, cwd))
	return false
}

/**
 * The project scopes a picker should offer: one per live working directory, plus
 * any project the store already holds so an orphan stays reachable.
 *
 * @param store - the secret store.
 * @param sessions - the live session descriptors.
 * @returns project descriptors, each naming its scope and directory.
 */
function listProjects(store, sessions) {
	const projects = []
	const seen = new Set()
	for (const session of sessions) {
		if (session.projectScope === undefined || seen.has(session.projectScope)) continue
		seen.add(session.projectScope)
		projects.push({ scope: session.projectScope, cwd: session.cwd, live: true })
	}
	for (const entry of store.all()) {
		if (seen.has(entry.scope)) continue
		const directory = projectDirectory(entry.scope)
		if (directory === undefined) continue
		seen.add(entry.scope)
		projects.push({ scope: entry.scope, cwd: directory, live: false })
	}
	return projects
}

/**
 * The live sessions, for the scope picker.
 *
 * A session header carries no title, so the label is the workspace directory
 * plus a short id — enough to recognise the session the user is looking at
 * without reaching into another subsystem's projections.
 *
 * @param ctx - the plugin context.
 * @returns session descriptors, newest first.
 */
function listSessions(ctx) {
	try {
		const agents = ctx.get?.('agents')
		if (agents === undefined || agents === null || typeof agents.list !== 'function') return []
		return agents
			.list()
			.map((agent) => {
				const header = agent?.session?.header
				const id = header?.id
				if (typeof id !== 'string' || id.length === 0) return undefined
				const cwd = typeof header?.cwd === 'string' ? header.cwd : ''
				const name = cwd.length > 0 ? path.basename(cwd) : '会话'
				const scope = cwd.length > 0 ? projectScope(cwd) : undefined
				return {
					id,
					cwd,
					label: `${name} · ${shortId(id)}`,
					createdAt: header?.createdAt === undefined ? '' : String(header.createdAt),
					// The client never derives this itself: one normalizer decides what
					// a project scope is, and it lives on the host.
					...(scope === undefined ? {} : { projectScope: scope }),
				}
			})
			.filter((session) => session !== undefined)
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
	} catch {
		return []
	}
}

/**
 * A short, recognisable piece of a session id.
 *
 * Every session id starts with the same `session-` prefix, so slicing from the
 * front would produce a label identical for every session. The prefix is
 * dropped first, with the raw head as a fallback for an id that is only a
 * prefix.
 *
 * @param id - the session id.
 * @returns at most eight characters that distinguish sessions.
 */
function shortId(id) {
	const tail = id.startsWith('session-') ? id.slice('session-'.length) : id
	const short = tail.slice(0, 8)
	return short.length > 0 ? short : id.slice(0, 8)
}

/**
 * Apply the request fence.
 *
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
	// Without the connection service there is no browser authentication to
	// borrow, so the fence degrades to the one check that still means something:
	// the request must come from this machine.
	if (!isLoopbackRequest(req)) {
		sendJson(res, 403, { ok: false, error: '缺少 connection 服务，已退化为仅回环地址可访问' })
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
