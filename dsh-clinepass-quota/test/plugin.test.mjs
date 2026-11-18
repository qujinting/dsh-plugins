import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { apply } from '../src/index.js'

/** 一套刚好够用的假上下文：只实现 apply 真正碰到的接线。 */
function fakeHarness({ credentials } = {}) {
	const tools = []
	const routes = []
	const ctx = {
		logger: { info: () => {}, warn: () => {} },
		get: (name) => (name === 'credentials' ? credentials : undefined),
		inject: (_names, callback) => {
			callback(ctx)
		},
		effect: (factory) => factory(),
		tools: { register: (definition) => { tools.push(definition); return () => {} } },
		webServer: { register: (route) => { routes.push(route); return () => {} } },
	}
	return { ctx, tools, routes }
}

/** 一个只够处理 JSON 往返的请求/响应替身。 */
function call(route, { method = 'GET', url = '/state', body, host = '127.0.0.1:65154' } = {}) {
	const req = new EventEmitter()
	req.method = method
	req.url = `/api/dsh-clinepass-quota${url}`
	req.headers = { host }
	req.destroy = () => {}
	const chunks = []
	const res = {
		statusCode: 200,
		headers: {},
		setHeader(name, value) { this.headers[name.toLowerCase()] = value },
		end(chunk) { if (chunk !== undefined) chunks.push(Buffer.from(chunk)) },
	}
	const done = route.handler(req, res).then(() => {
		const text = Buffer.concat(chunks).toString('utf8')
		return { status: res.statusCode, headers: res.headers, json: text.length === 0 ? undefined : JSON.parse(text) }
	})
	if (body !== undefined) {
		queueMicrotask(() => {
			req.emit('data', Buffer.from(JSON.stringify(body)))
			req.emit('end')
		})
	} else {
		queueMicrotask(() => {
			req.emit('end')
		})
	}
	return done
}

test('apply 注册了工具与路由', () => {
	const { ctx, tools, routes } = fakeHarness()
	apply(ctx, {})
	assert.equal(tools.length, 1)
	assert.equal(tools[0].name, 'clinepass_quota')
	assert.equal(typeof tools[0].execute, 'function')
	assert.equal(routes.length, 1)
	assert.equal(routes[0].path, '/api/dsh-clinepass-quota')
	assert.equal(routes[0].kind, 'prefix')
})

test('registerTool/registerRoutes 可以关掉', () => {
	const { ctx, tools, routes } = fakeHarness()
	apply(ctx, { registerTool: false, registerRoutes: false })
	assert.equal(tools.length, 0)
	assert.equal(routes.length, 0)
})

test('GET /state 在没有 key 时回 200 + 可读原因', async () => {
	const { ctx, routes } = fakeHarness()
	apply(ctx, { apiKeyEnv: [], dataDir: '.tmp-test' })
	const result = await call(routes[0])
	assert.equal(result.status, 200)
	assert.equal(result.json.ok, true)
	assert.equal(result.json.key.configured, false)
	assert.match(result.json.error, /还没有配置 Cline API Key/u)
	assert.match(result.headers['content-type'], /application\/json/u)
	assert.equal(result.headers['cache-control'], 'no-store')
})

test('没有写入口：POST /key 与 /key/clear 一律 404', async () => {
	const { ctx, routes } = fakeHarness()
	apply(ctx, { apiKeyEnv: [], dataDir: '.tmp-test' })
	const save = await call(routes[0], { method: 'POST', url: '/key', body: { apiKey: 'cpk_0123456789' } })
	assert.equal(save.status, 404)
	const clear = await call(routes[0], { method: 'POST', url: '/key/clear', body: {} })
	assert.equal(clear.status, 404)
})

test('未知路由 404，GET /refresh 405', async () => {
	const { ctx, routes } = fakeHarness()
	apply(ctx, { apiKeyEnv: [], dataDir: '.tmp-test' })
	const missing = await call(routes[0], { method: 'POST', url: '/nope', body: {} })
	assert.equal(missing.status, 404)
	const wrongMethod = await call(routes[0], { url: '/refresh' })
	assert.equal(wrongMethod.status, 405)
	assert.equal(wrongMethod.headers.allow, 'POST')
})

test('凭据服务提供的 key 让 state 认为已配置（无网络时不报配置缺失）', async () => {
	const credentials = {
		resolve: async (ref) => (ref === 'CLINEPASS_API_KEY' ? { value: 'cpk_0123456789', source: 'store' } : undefined),
		set: async () => {},
		unset: async () => {},
		describe: async () => ({ configured: true, writable: true }),
	}
	const { ctx, routes } = fakeHarness({ credentials })
	// 指向一个必然立刻拒绝连接的端口：验证的是接线与降级，不是网络。
	apply(ctx, { apiKeyEnv: ['CLINEPASS_API_KEY'], dataDir: '.tmp-test', baseUrl: 'http://127.0.0.1:9/api/v1', timeoutMs: 1_000 })
	const result = await call(routes[0])
	assert.equal(result.status, 200)
	assert.equal(result.json.key.configured, true)
	assert.equal(result.json.key.source, 'credentials')
	assert.doesNotMatch(result.json.key.mask, /0123456789/u)
	assert.match(result.json.error, /连接|失败|fetch/u)
})
