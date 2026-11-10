/**
 * Tests for the hardened boundary: what a caller may reach, which methods it may
 * call, what it may pass in, and what it may read back.
 *
 * These are the regressions that justified contract version 2. Before them the
 * bridge enforced one text-level deny list, took any argument (functions
 * included), and redacted only field *names* — so `loader.update()` was reachable
 * with no confirmation, a callback could be smuggled into any method, and a
 * method that returned a bare token string handed it over verbatim.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// Relaunch plans and the restart ledger live under DSH_HOME; keep them out of
// the operator's real profile.
process.env.DSH_HOME ??= mkdtempSync(join(tmpdir(), 'dsh-bridge-test-'))

import { apply } from '../src/index.js'
import { REDACTED } from '../src/serialize.js'

/**
 * Build a fake host with the given services and activate the bridge.
 * @param options - seeded services and plugin config.
 * @returns the bridge, the service store, and the fake context.
 */
function harness({ services = {}, config = {} } = {}) {
	const store = new Map(Object.entries(services))
	const props = {}
	const disposers = []

	for (const key of Object.keys(services)) props[key] = { type: 'service' }

	const ctx = {
		reflect: { props },
		fiber: { state: 2, restart() {} },
		logger: { info() {}, warn() {} },
		get: serviceName => store.get(serviceName),
		provide(serviceName, value) {
			props[serviceName] = { type: 'service' }
			store.set(serviceName, value)
			return () => store.delete(serviceName)
		},
		effect(run) {
			const disposer = run()
			disposers.push(disposer)
			return disposer
		},
	}

	apply(ctx, config)
	return { ctx, bridge: store.get('dshBridge'), store }
}

/** A loader-shaped service, complete with the mutators the bridge must not reach. */
function loaderFixture(calls) {
	return {
		entries() {
			return [][Symbol.iterator]()
		},
		async update(id, options) {
			calls.push(['loader.update', id, options])
			return { id }
		},
		async import(name, getOuterStack) {
			calls.push(['loader.import', name, typeof getOuterStack])
			return {}
		},
		async remove(id) {
			calls.push(['loader.remove', id])
		},
	}
}

test('the default deny list closes exec, filesystem, lifecycle, and secret services', async () => {
	const calls = []
	const { bridge } = harness({
		services: {
			loader: loaderFixture(calls),
			shell: { async run(command) { calls.push(['shell.run', command]) } },
			fs: { async writeFile(path) { calls.push(['fs.writeFile', path]) } },
			settings: { get: () => ({}) },
			credentials: { get: () => 'secret' },
			sampler: { ping: () => 'pong' },
		},
	})

	for (const service of ['loader', 'shell', 'fs', 'settings', 'credentials']) {
		const result = await bridge.invoke('service.call', { service, method: 'x' })
		assert.equal(result.ok, false, `${service} must not be reachable`)
		assert.equal(result.error.code, 'service-denied', `${service}: ${JSON.stringify(result.error)}`)
	}
	assert.deepEqual(calls, [], 'a denied service is rejected before it is touched')

	const reachable = await bridge.invoke('service.call', { service: 'sampler', method: 'ping' })
	assert.equal(reachable.ok, true)
	assert.equal(reachable.value.value, 'pong')
})

test('service.describe is gated by the same deny list', async () => {
	const { bridge } = harness({ services: { loader: loaderFixture([]) } })
	const described = await bridge.invoke('service.describe', { service: 'loader' })
	assert.equal(described.ok, false)
	assert.equal(described.error.code, 'service-denied')
})

test('serviceAllow turns the bridge into an allowlist and the deny list still wins', async () => {
	const { bridge } = harness({
		services: {
			sampler: { ping: () => 'pong' },
			other: { ping: () => 'pong' },
			credentials: { get: () => 'secret' },
		},
		config: { serviceAllow: ['sampler', 'credentials'] },
	})

	assert.equal((await bridge.invoke('service.call', { service: 'sampler', method: 'ping' })).ok, true)

	const outside = await bridge.invoke('service.call', { service: 'other', method: 'ping' })
	assert.equal(outside.error.code, 'service-not-allowed')

	const denied = await bridge.invoke('service.call', { service: 'credentials', method: 'get' })
	assert.equal(denied.error.code, 'service-denied', 'an allowlist entry cannot reopen a denied service')

	const list = await bridge.invoke('service.list')
	const byName = new Map(list.value.map(row => [row.name, row]))
	assert.equal(byName.get('sampler').allowed, true)
	assert.equal(byName.get('other').allowed, false)
	assert.equal(byName.get('credentials').denied, true)
})

test('re-enabling a denied service does not hand back its mutators', async () => {
	const calls = []
	const { bridge } = harness({
		services: { loader: loaderFixture(calls) },
		config: { serviceDeny: ['credentials', 'configEditor', 'dshBridge'] },
	})

	const read = await bridge.invoke('service.call', { service: 'loader', method: 'entries' })
	assert.equal(read.ok, true, 'reading entries is what re-enabling loader is for')

	for (const [method, args] of [
		['update', ['row-1', { config: { evil: true } }]],
		['remove', ['row-1']],
		['import', ['file:///tmp/evil.js']],
	]) {
		const result = await bridge.invoke('service.call', { service: 'loader', method, args })
		assert.equal(result.ok, false, `${method} must be denied`)
		assert.equal(result.error.code, 'method-denied', `${method}: ${JSON.stringify(result.error)}`)
	}
	assert.deepEqual(calls, [], 'no mutator ran')
})

test('method rules apply to nested service names and to function-valued services', async () => {
	const { bridge } = harness({
		services: {
			'db.read': { query: () => [], drop: () => 'dropped' },
			appExit: function exit() {},
		},
		config: { methodDeny: { db: ['drop'] } },
	})

	const nested = await bridge.invoke('service.call', { service: 'db.read', method: 'drop' })
	assert.equal(nested.error.code, 'method-denied', 'a prefix rule must cover db.read')
	assert.equal((await bridge.invoke('service.call', { service: 'db.read', method: 'query' })).ok, true)

	const proto = await bridge.invoke('service.call', { service: 'appExit', method: 'call' })
	assert.equal(proto.error.code, 'method-denied', 'Function.prototype is not a service API')
})

test('arguments must be plain cloneable data', async () => {
	const seen = []
	const { bridge } = harness({
		services: {
			sampler: {
				async take(value) {
					seen.push(value)
					return 'ok'
				},
			},
		},
	})

	class Live {
		constructor() {
			this.touched = true
		}
	}

	const circular = {}
	circular.self = circular

	const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }
	const huge = Array.from({ length: 300 }, (_, index) => index)

	const cases = [
		['function', [() => 'callback']],
		['class instance', [new Live()]],
		['circular', [circular]],
		['nested beyond the bound', [deep]],
		['too many values', [huge]],
		['overlong string', ['x'.repeat(8193)]],
		['Map', [new Map()]],
	]

	for (const [label, args] of cases) {
		const result = await bridge.invoke('service.call', { service: 'sampler', method: 'take', args })
		assert.equal(result.ok, false, `${label} must be rejected`)
		assert.equal(result.error.code, 'bad-request', `${label}: ${JSON.stringify(result.error)}`)
	}
	assert.deepEqual(seen, [], 'a rejected argument never reached the service')

	const accepted = await bridge.invoke('service.call', {
		service: 'sampler',
		method: 'take',
		args: [{ nested: ['plain', 1, true, null] }],
	})
	assert.equal(accepted.ok, true)
})

test('a credential-shaped bare string is redacted, wherever it appears', async () => {
	const token = 'sk-live-abcdefghijklmnopqrstuvwxyz012345'
	const { bridge } = harness({
		services: {
			sampler: {
				bare: () => token,
				listed: () => [token, 'harmless'],
				field: () => ({ apiKey: token, name: 'visible' }),
			},
		},
	})

	assert.equal((await bridge.call('sampler', 'bare')).value.value, REDACTED)
	const listed = (await bridge.call('sampler', 'listed')).value.value
	assert.equal(listed.items[0], REDACTED)
	assert.equal(listed.items[1], 'harmless')
	const field = (await bridge.call('sampler', 'field')).value.value.fields
	assert.equal(field.apiKey, REDACTED)
	assert.equal(field.name, 'visible')
})

test('a truncated snapshot still names what it is hiding', async () => {
	const { bridge } = harness({
		services: { sampler: { deep: () => ({ a: { b: { c: { d: { secret: 'x' } } } } }) } },
	})
	const value = (await bridge.call('sampler', 'deep')).value.value
	const level3 = value.fields.a.fields.b.fields.c
	assert.equal(level3.truncated, true)
	assert.deepEqual(level3.keys, ['d'])
})

test('the audit file records every call when configured', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-'))
	const auditFile = join(dir, 'audit.jsonl')
	try {
		const { bridge } = harness({
			services: { sampler: { ping: () => 'pong' } },
			config: { auditFile },
		})
		await bridge.invoke('service.call', { service: 'sampler', method: 'ping' }, { caller: 'test' })
		await bridge.invoke('service.call', { service: 'loader', method: 'update' }, { caller: 'test' })

		// The append is deliberately fire-and-forget in the plugin, so the test
		// waits for the file to settle instead of for a fixed delay.
		const rows = await waitForRows(auditFile, 2)
		assert.equal(rows.length, 2)
		assert.equal(rows[0].caller, 'test')
		assert.equal(rows[0].ok, true)
		assert.equal(rows[1].ok, false)
		assert.equal(rows[1].error.code, 'service-denied')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

/**
 * Poll a JSONL file until it holds at least `count` rows.
 * @param path - file written by the audit sink.
 * @param count - rows to wait for.
 * @returns the parsed rows.
 */
async function waitForRows(path, count) {
	const deadline = Date.now() + 2000
	let rows = []
	while (Date.now() < deadline) {
		try {
			rows = (await readFile(path, 'utf8'))
				.split('\n')
				.filter(line => line.trim().length > 0)
				.map(line => JSON.parse(line))
			if (rows.length >= count) return rows
		} catch {
			// The file may not exist yet on the first pass.
		}
		await new Promise(resolve => setTimeout(resolve, 10))
	}
	return rows
}

test('no audit file is written unless one is configured', async () => {
	const { bridge } = harness({ services: { sampler: { ping: () => 'pong' } } })
	await bridge.call('sampler', 'ping')
	assert.equal(bridge.audit().length, 1)
	assert.equal(bridge.policy().auditFile, undefined)
})

test('a policy refusal does not spend the breaker, a host failure does', async () => {
	const { bridge } = harness({
		services: {
			loader: loaderFixture([]),
			flaky: {
				async boom() {
					throw new Error('the host is unhappy')
				},
			},
		},
		config: { breakerThreshold: 2 },
	})

	// Five refusals in a row: the caller is wrong, the host is fine.
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const refused = await bridge.invoke('service.call', { service: 'loader', method: 'update' })
		assert.ok(['service-denied', 'method-denied'].includes(refused.error.code), refused.error.code)
	}

	const afterRefusals = await bridge.invoke('service.call', { service: 'flaky', method: 'boom' })
	assert.equal(afterRefusals.error.code, 'failed', 'the capability is not short-circuited by refusals')

	// Two real failures reach the threshold and close the gate.
	const second = await bridge.invoke('service.call', { service: 'flaky', method: 'boom' })
	assert.equal(second.error.code, 'failed')
	const third = await bridge.invoke('service.call', { service: 'flaky', method: 'boom' })
	assert.equal(third.error.code, 'breaker-open')
})

test('the resolved policy is readable and includes the gates', () => {
	const { bridge } = harness()
	const policy = bridge.policy()
	assert.ok(policy.serviceDeny.includes('loader'))
	assert.ok(policy.serviceDeny.includes('shell'))
	assert.deepEqual(policy.serviceAllow, [])
	assert.ok(policy.methodDeny['*'].includes('import'))
	assert.ok(policy.methodDeny.loader.includes('update'))

	// The copy is detached: a consumer cannot edit the live policy.
	policy.serviceDeny.push('sampler')
	assert.equal(bridge.policy().serviceDeny.includes('sampler'), false)
})
