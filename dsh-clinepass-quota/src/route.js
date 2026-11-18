/**
 * 浏览器半边说话的入口：`/api/dsh-clinepass-quota`。
 *
 * 两个动作，都围绕同一个 `QuotaService`：
 *
 *   GET  /state      读当前状态（缓存优先，可能触发一次网络）
 *   POST /refresh    强制查一次上游
 *
 * 没有写入面。API Key 的增删属于 DSH 的凭据管理，这条路由不该多出一个能改
 * 凭据的入口 —— 少一个可写端点，就少一类要审的东西。
 *
 * 访问围栏仍然借用 `ctx.connection.requestRejection`（与其它内置路由同一套
 * 会话鉴权）；拿不到 connection 服务时退化为「只接受回环地址」。
 *
 * @module dsh-clinepass-quota/route
 */

/** 本插件的路由前缀。 */
export const ROUTE_BASE = '/api/dsh-clinepass-quota'

/**
 * 注册路由。
 *
 * 只有两个只读动作：`/state` 与 `/refresh`。插件不接收任何写入 —— key 的
 * 增删由 DSH 的凭据管理负责，这条路由没有理由多出一个能改凭据的表面。
 *
 * @param ctx - 插件上下文。
 * @param service - 额度服务。
 * @returns webServer 的注销函数。
 */
export function registerRoutes(ctx, service) {
	return ctx.webServer.register({
		kind: 'prefix',
		path: ROUTE_BASE,
		handler: async (req, res) => {
			try {
				await handle(ctx, service, req, res)
			} catch (error) {
				// webServer 会把抛出的处理函数变成裸 400，页面读不出原因。
				sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
			}
		},
	})
}

/**
 * 分发一个请求。
 *
 * @param ctx - 插件上下文。
 * @param service - 额度服务。
 * @param req - 入站请求。
 * @param res - 响应。
 */
async function handle(ctx, service, req, res) {
	if (reject(ctx, req, res)) return

	const url = new URL(String(req.url), 'http://localhost')
	const route = url.pathname.slice(ROUTE_BASE.length) || '/'

	if (route === '/state' || route === '/') {
		if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
		const state = await service.state({ force: false })
		sendJson(res, 200, { ok: true, ...project(state, service.options) })
		return
	}

	if (req.method !== 'POST') return methodNotAllowed(res, 'POST')

	if (route === '/refresh') {
		const state = await service.state({ force: true })
		sendJson(res, 200, { ok: true, ...project(state, service.options) })
		return
	}

	sendJson(res, 404, { ok: false, error: `未知路由 ${route}` })
}

/**
 * 把服务状态投影成页面需要的形状。
 *
 * 二次加工只做两件事：把绝对时间换成页面能直接算的毫秒，以及绝不外泄 key。
 *
 * @param state - `QuotaService.state()` 的结果。
 * @param options - 已解析的插件选项（只暴露界面需要的开关）。
 * @returns 响应负载（不含 `ok`）。
 */
function project(state, options) {
	const snapshot = state.snapshot
	return {
		key: state.key,
		ui: { headerBadge: options.headerBadge !== false },
		cacheSeconds: state.cacheSeconds,
		cache: state.cache,
		...(state.error === undefined ? {} : { error: state.error }),
		...(state.authFailed === true ? { authFailed: true } : {}),
		...(snapshot === undefined ? {} : {
			snapshot: {
				fetchedAt: snapshot.fetchedAt,
				fetchedAtMs: Date.parse(snapshot.fetchedAt) || Date.now(),
				baseUrl: snapshot.baseUrl,
				hasPlan: snapshot.hasPlan === true,
				windows: snapshot.windows ?? [],
				...(snapshot.account === undefined ? {} : { account: snapshot.account }),
				...(snapshot.credits === undefined ? {} : { credits: snapshot.credits }),
				notes: snapshot.notes ?? [],
			},
		}),
	}
}

/**
 * 应用请求围栏。
 *
 * @param ctx - 插件上下文。
 * @param req - 入站请求。
 * @param res - 响应。
 * @returns 是否已拒绝。
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
		sendJson(res, 403, { ok: false, error: '缺少 connection 服务，已退化为仅回环地址可访问' })
		return true
	}
	return false
}

/**
 * Host 与 Origin（若有）是否都是回环。
 * @param req - 入站请求。
 * @returns 是否可以服务。
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
 * 从 Origin 头里取 host。
 * @param origin - 原始头。
 * @returns host 或 undefined。
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
 * 回一段不缓存的 JSON。
 * @param res - 响应。
 * @param status - 状态码。
 * @param payload - JSON 负载。
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
 * 以 405 回答，并给出允许的方法。
 * @param res - 响应。
 * @param allowed - 允许的方法。
 */
function methodNotAllowed(res, allowed) {
	res.setHeader('Allow', allowed)
	sendJson(res, 405, { ok: false, error: `此路由只接受 ${allowed}` })
}
