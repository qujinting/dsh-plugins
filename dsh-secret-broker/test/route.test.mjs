/**
 * The HTTP surface.
 *
 * Two things are being pinned here and both are security claims rather than
 * behaviour claims: the fence is applied before anything else (so a refused
 * request never reaches the store), and the state response is structurally
 * incapable of carrying a value.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ROUTE_BASE, registerRoutes } from '../src/route.js'
import { GLOBAL_SCOPE, SecretStore, projectScope, sessionScope } from '../src/store.js'
import { callRoute, createFakeConnection, createFakeContext } from './helpers.mjs'

/** The options `registerRoutes` reads. */
const OPTIONS = { allowReveal: true, redactResults: true, keyPrefix: 'DSH_SECRET_', titleBarValues: 'masked' }

/** A store plus a context whose route has been registered. */
async function harness({ connection, allowReveal = true, seed = true } = {}) {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-route-'))
	const store = new SecretStore({ dataDir, encryption: 'none', keyPrefix: 'DSH_SECRET_', maxEntries: 200, logger: { warn() {} } })
	if (seed) {
		await store.set({ key: 'TOKEN', value: 'super-secret-value', scope: GLOBAL_SCOPE, description: '全局 token' })
		await store.set({ key: 'OWN', value: 'session-only-value', scope: sessionScope('session-a') })
	}
	const services = {
		webServer: {
			register(route) {
				ctx.records.routes.push(route)
				return () => {}
			},
		},
		agents: {
			list: () => [{ session: { header: { id: 'session-a', cwd: 'D:\\work\\proj', createdAt: '2026-01-01T00:00:00.000Z' } } }],
		},
	}
	if (connection !== undefined) services.connection = connection
	const ctx = createFakeContext(services)
	registerRoutes(ctx, store, { ...OPTIONS, allowReveal })
	await store.ready
	return { ctx, store, dataDir }
}

/** A loopback Host header, which the fallback fence accepts. */
const LOOPBACK = { host: '127.0.0.1:19387' }

test('the route is registered as a prefix under the plugin\'s own path', async () => {
	const { ctx } = await harness()
	assert.equal(ctx.records.routes.length, 1)
	assert.deepEqual({ kind: ctx.records.routes[0].kind, path: ctx.records.routes[0].path }, { kind: 'prefix', path: ROUTE_BASE })
})

test('state reports metadata, never a value', async () => {
	const { ctx } = await harness()
	const response = await callRoute(ctx, { method: 'GET', path: '/state', headers: LOOPBACK })
	assert.equal(response.statusCode, 200)
	const body = response.json()
	assert.equal(body.ok, true)
	assert.equal(body.encryption, 'none')
	assert.equal(body.titleBarValues, 'masked', 'the title-bar posture reaches the client through state')
	assert.equal(body.writable, true)
	assert.equal(body.keys.length, 2)
	assert.deepEqual(Object.keys(body.keys[0]).sort(), ['createdAt', 'description', 'env', 'key', 'orphan', 'scope', 'updatedAt'])
	assert.ok(!response.body.includes('super-secret-value'), 'no value appears anywhere in the response')
	assert.ok(!response.body.includes('session-only-value'))
	assert.equal(body.sessions[0].id, 'session-a')
	assert.equal(body.sessions[0].label, 'proj · a')
	assert.equal(response.headers['cache-control'], 'no-store')
	assert.equal(response.headers['x-content-type-options'], 'nosniff')
})

test('an orphaned session scope is flagged', async () => {
	const { ctx } = await harness()
	const response = await callRoute(ctx, { method: 'GET', path: '/state', headers: LOOPBACK })
	const own = response.json().keys.find((entry) => entry.key === 'OWN')
	assert.equal(own.orphan, false, 'session-a is live')
	assert.equal(response.json().keys.find((entry) => entry.key === 'TOKEN').orphan, false)
})

test('state names each session\'s project, and a project outlives its sessions', async () => {
	const { ctx, store } = await harness()
	await store.set({ key: 'REPO', value: 'repo-secret-value', scope: projectScope('D:\\work\\proj') })
	await store.set({ key: 'ELSEWHERE', value: 'elsewhere-secret-value', scope: projectScope('D:\\other') })
	const response = await callRoute(ctx, { method: 'GET', path: '/state', headers: LOOPBACK })
	assert.equal(response.statusCode, 200)
	const body = response.json()

	// The client never derives a project scope; the host hands it over.
	assert.equal(body.sessions[0].projectScope, projectScope('D:\\work\\proj'))
	const projects = Object.fromEntries(body.projects.map((project) => [project.scope, project]))
	assert.equal(projects[projectScope('D:\\work\\proj')].live, true)
	assert.equal(projects[projectScope('D:\\other')].live, false, 'a project nobody works in is still offered, so it stays reachable')

	const keys = Object.fromEntries(body.keys.map((entry) => [entry.key, entry]))
	assert.equal(keys.REPO.orphan, false, 'session-a works in that directory')
	assert.equal(keys.ELSEWHERE.orphan, true, 'nobody works there')
	assert.ok(!response.body.includes('repo-secret-value'))
	assert.ok(!response.body.includes('elsewhere-secret-value'))
})

test('a refused request never reaches the store', async () => {
	const connection = createFakeConnection(401)
	const { ctx } = await harness({ connection })
	const refused = await callRoute(ctx, { method: 'GET', path: '/state' })
	assert.equal(refused.statusCode, 401)
	assert.equal(refused.body, '')
	assert.equal(connection.calls.length, 1)

	const forbidden = await harness({ connection: createFakeConnection(403) })
	const blocked = await callRoute(forbidden.ctx, { method: 'POST', path: '/set', rawBody: JSON.stringify({ key: 'X', value: 'y', scope: 'global' }) })
	assert.equal(blocked.statusCode, 403)
	assert.equal(forbidden.store.all().length, 2, 'nothing was written')
})

test('without the connection service the fence degrades to loopback only', async () => {
	const { ctx } = await harness()
	const refused = await callRoute(ctx, { method: 'GET', path: '/state', headers: { host: 'evil.example:19387' } })
	assert.equal(refused.statusCode, 403)
	const badOrigin = await callRoute(ctx, {
		method: 'POST',
		path: '/set',
		headers: { host: '127.0.0.1:19387', origin: 'https://evil.example' },
		rawBody: JSON.stringify({ key: 'X', value: 'y', scope: 'global' }),
	})
	assert.equal(badOrigin.statusCode, 403)
	const admitted = await callRoute(ctx, { method: 'GET', path: '/state', headers: { host: 'localhost:19387', origin: 'http://localhost:19387' } })
	assert.equal(admitted.statusCode, 200)
})

test('set, delete and promote', async () => {
	const { ctx, store } = await harness()
	const set = await callRoute(ctx, {
		method: 'POST',
		path: '/set',
		headers: LOOPBACK,
		rawBody: JSON.stringify({ key: 'NEW', value: 'fresh-value', scope: 'global', description: 'added' }),
	})
	assert.equal(set.statusCode, 200)
	assert.equal(set.json().key.env, 'DSH_SECRET_NEW')
	assert.equal(set.json().key.value, undefined, 'the write response carries metadata only')
	assert.equal(store.effective(undefined).length, 2)

	const promote = await callRoute(ctx, {
		method: 'POST',
		path: '/promote',
		headers: LOOPBACK,
		rawBody: JSON.stringify({ key: 'OWN', from: 'session:session-a', to: 'global' }),
	})
	assert.equal(promote.statusCode, 200)
	assert.equal(promote.json().key.scope, 'global')

	const remove = await callRoute(ctx, {
		method: 'POST',
		path: '/delete',
		headers: LOOPBACK,
		rawBody: JSON.stringify({ key: 'OWN', scope: 'global' }),
	})
	assert.equal(remove.json().removed, true)

	const missing = await callRoute(ctx, {
		method: 'POST',
		path: '/delete',
		headers: LOOPBACK,
		rawBody: JSON.stringify({ key: 'NOPE', scope: 'global' }),
	})
	assert.equal(missing.json().removed, false)
})

test('a store refusal is answered as a JSON error', async () => {
	const { ctx } = await harness()
	const response = await callRoute(ctx, {
		method: 'POST',
		path: '/set',
		headers: LOOPBACK,
		rawBody: JSON.stringify({ key: '1BAD', value: 'x', scope: 'global' }),
	})
	assert.equal(response.statusCode, 500)
	assert.match(response.json().error, /密钥名/)
})

test('reveal is gated by the deployment switch and audits only the key', async () => {
	const { ctx } = await harness()
	const response = await callRoute(ctx, {
		method: 'POST',
		path: '/reveal',
		headers: LOOPBACK,
		rawBody: JSON.stringify({ key: 'TOKEN', scope: 'global' }),
	})
	assert.equal(response.statusCode, 200)
	assert.equal(response.json().value, 'super-secret-value')
	assert.ok(ctx.records.infos.some((line) => line.includes('TOKEN') && !line.includes('super-secret-value')), 'the audit line names the key, not the value')

	const off = await harness({ allowReveal: false })
	const refused = await callRoute(off.ctx, {
		method: 'POST',
		path: '/reveal',
		headers: LOOPBACK,
		rawBody: JSON.stringify({ key: 'TOKEN', scope: 'global' }),
	})
	assert.equal(refused.statusCode, 403)

	const unknown = await callRoute(ctx, {
		method: 'POST',
		path: '/reveal',
		headers: LOOPBACK,
		rawBody: JSON.stringify({ key: 'NOPE', scope: 'global' }),
	})
	assert.equal(unknown.statusCode, 404)
})

test('method, body and route guards', async () => {
	const { ctx } = await harness()
	const wrongMethod = await callRoute(ctx, { method: 'GET', path: '/set', headers: LOOPBACK })
	assert.equal(wrongMethod.statusCode, 405)
	assert.equal(wrongMethod.headers.allow, 'POST')

	const notJson = await callRoute(ctx, { method: 'POST', path: '/set', headers: LOOPBACK, rawBody: 'not json' })
	assert.equal(notJson.statusCode, 500)
	assert.match(notJson.json().error, /JSON/)

	const oversized = await callRoute(ctx, {
		method: 'POST',
		path: '/set',
		headers: LOOPBACK,
		rawBody: JSON.stringify({ key: 'A', value: 'x'.repeat(70 * 1024), scope: 'global' }),
	})
	assert.equal(oversized.statusCode, 500)
	assert.match(oversized.json().error, /请求体超过/)

	const unknown = await callRoute(ctx, { method: 'POST', path: '/nope', headers: LOOPBACK, rawBody: '{}' })
	assert.equal(unknown.statusCode, 404)
})

test('an empty body is an empty object rather than a parse error', async () => {
	const { ctx } = await harness()
	const response = await callRoute(ctx, { method: 'POST', path: '/delete', headers: LOOPBACK })
	assert.equal(response.statusCode, 500)
	assert.match(response.json().error, /作用域/)
})
