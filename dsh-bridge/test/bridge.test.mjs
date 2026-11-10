/**
 * Behavioural tests for dsh-bridge against a stand-in cordis context.
 *
 * The fake below implements only what the plugin actually consumes — `get`,
 * `provide`, `effect`, `reflect.props`, `fiber.restart`, `logger` — which is
 * also a useful statement of the contract: if the plugin ever needs more of the
 * framework than this, the bridge is coupling harder than advertised.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, name as pluginName } from '../src/index.js'

// The bridge writes relaunch plans and a restart ledger under `DSH_HOME`; a test
// must never do that to the operator's real profile.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-bridge-bridge-'))

/** Wait one macrotask, so a deferred lifecycle action has run. */
const tick = () => new Promise(resolve => setTimeout(resolve, 10))

/**
 * Build a fake host context and activate the plugin on it.
 * @param options - seeded services, config, and loader entries.
 * @returns the context, the provided bridge, and the recording helpers.
 */
function harness({ services = {}, config = {}, entries = [] } = {}) {
	const store = new Map(Object.entries(services))
	const props = {}
	const restarted = []
	const disposers = []

	for (const key of Object.keys(services)) props[key] = { type: 'service' }

	store.set('loader', {
		entries() {
			return entries[Symbol.iterator]()
		},
	})
	props.loader = { type: 'service' }

	const ctx = {
		reflect: { props },
		fiber: {
			state: 2,
			restart() {
				restarted.push('self')
			},
		},
		logger: { info() {}, warn() {} },
		get(serviceName) {
			return store.get(serviceName)
		},
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
	return { ctx, bridge: store.get('dshBridge'), restarted, store }
}

test('the plugin provides one service with a versioned, listable contract', () => {
	const { bridge } = harness()
	assert.equal(pluginName, 'dsh-bridge')
	assert.equal(bridge.version, 3)

	const names = bridge.list().map(item => item.name).sort()
	assert.deepEqual(names, [
		'app.exit',
		'app.restart',
		'app.restartState',
		'config.edit',
		'plugin.list',
		'plugin.restart',
		'service.call',
		'service.describe',
		'service.list',
	])
	assert.ok(bridge.list().every(item => ['low', 'medium', 'high'].includes(item.risk)))
})

test('app.restart needs the same confirmation as the other destructive capabilities', async () => {
	const { bridge } = harness()
	const refused = await bridge.invoke('app.restart')
	assert.equal(refused.ok, false)
	assert.equal(refused.error.code, 'confirmation-required')
})

test('app.restartState reports the relaunch path and the budget without touching the host', async () => {
	const { bridge } = harness()
	const result = await bridge.invoke('app.restartState')
	assert.equal(result.ok, true)
	assert.equal(result.value.host.kind, 'process')
	assert.equal(result.value.host.shutdown, 'self-exit')
	assert.equal(typeof result.value.budget.left, 'number')
	assert.ok(Array.isArray(result.value.recent))
})

test('an unknown capability is reported, not thrown', async () => {
	const { bridge } = harness()
	const result = await bridge.invoke('does.not.exist')
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'unknown-capability')
})

test('service.list reports availability and marks the denied ones', async () => {
	const { bridge } = harness({
		services: { sampler: { ping: () => 'pong' }, credentials: { get: () => 'secret' } },
	})
	const result = await bridge.invoke('service.list')
	assert.equal(result.ok, true)
	const byName = new Map(result.value.map(row => [row.name, row]))
	assert.equal(byName.get('sampler').available, true)
	assert.equal(byName.get('credentials').denied, true)
	assert.equal(byName.get('loader').available, true)
})

test('service.call runs a method and returns a snapshot', async () => {
	const { bridge } = harness({
		services: { sampler: { add: (a, b) => a + b, live: { nested: { deep: { deeper: true } } } } },
	})
	const sum = await bridge.call('sampler', 'add', 2, 3)
	assert.equal(sum.ok, true)
	assert.equal(sum.value.value, 5)

	const snapshot = await bridge.call('sampler', 'add', 1, 1)
	assert.equal(typeof snapshot.value, 'object')
	assert.equal(JSON.parse(JSON.stringify(snapshot)).ok, true)
})

test('service.call refuses a denied service before touching it', async () => {
	let touched = false
	const { bridge } = harness({
		services: {
			credentials: {
				read: () => {
					touched = true
					return 'plaintext'
				},
			},
		},
	})
	const result = await bridge.call('credentials', 'read')
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'service-denied')
	assert.equal(touched, false)
})

test('service.call reports a missing method by name', async () => {
	const { bridge } = harness({ services: { sampler: { add: () => 1 } } })
	const result = await bridge.call('sampler', 'subtract')
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'no-such-method')
})

test('service.describe walks the prototype chain for methods', async () => {
	class Registry {
		add() {}
		remove() {}
	}
	const instance = new Registry()
	instance.count = 0

	const { bridge } = harness({ services: { registry: instance } })
	const result = await bridge.invoke('service.describe', { service: 'registry' })
	assert.equal(result.ok, true)
	assert.deepEqual(result.value.methods, ['add', 'remove'])
	assert.deepEqual(result.value.keys, ['count'])
})

test('a destructive capability needs an explicit confirmation', async () => {
	const { bridge, restarted } = harness()
	const refused = await bridge.invoke('plugin.restart')
	assert.equal(refused.ok, false)
	assert.equal(refused.error.code, 'confirmation-required')
	await tick()
	assert.deepEqual(restarted, [])
})

test('plugin.restart answers first, then reloads on the next tick', async () => {
	const { bridge, restarted } = harness()
	const result = await bridge.invoke('plugin.restart', { confirm: true }, { caller: 'unit-test' })
	assert.equal(result.ok, true)
	assert.equal(result.value.accepted, true)
	assert.deepEqual(restarted, [], 'the caller must receive its receipt before the fiber goes away')
	await tick()
	assert.deepEqual(restarted, ['self'])
})

test('plugin.restart targets another plugin by id or package name', async () => {
	const restarted = []
	const entries = [
		{ id: 'other', options: { name: 'dsh-other' }, fiber: { state: 2, restart: () => restarted.push('other') } },
	]
	const { bridge } = harness({ entries })

	const byName = await bridge.invoke('plugin.restart', { plugin: 'dsh-other', confirm: true })
	assert.equal(byName.ok, true)
	await tick()
	assert.deepEqual(restarted, ['other'])

	const missing = await bridge.invoke('plugin.restart', { plugin: 'nope', confirm: true })
	assert.equal(missing.error.code, 'no-such-plugin')
})

test('plugin.list reports each entry with its activation state', async () => {
	const entries = [
		{ id: 'a', options: { name: 'dsh-a' }, fiber: { state: 2 } },
		{ id: 'b', options: { name: 'dsh-b' }, fiber: { state: 5 } },
	]
	const { bridge } = harness({ entries })
	const result = await bridge.invoke('plugin.list')
	assert.deepEqual(result.value, [
		{ id: 'a', name: 'dsh-a', active: true },
		{ id: 'b', name: 'dsh-b', active: false },
	])
})

test('app.exit asks the launcher only after the receipt', async () => {
	const calls = []
	const { bridge } = harness({ services: { appExit: code => calls.push(code) } })

	const refused = await bridge.invoke('app.exit')
	assert.equal(refused.error.code, 'confirmation-required')

	const accepted = await bridge.invoke('app.exit', { code: 3, confirm: true })
	assert.equal(accepted.ok, true)
	assert.deepEqual(calls, [])
	await tick()
	assert.deepEqual(calls, [3])
})

test('app.exit reports an absent launcher instead of exiting silently', async () => {
	const { bridge } = harness()
	const result = await bridge.invoke('app.exit', { confirm: true })
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'service-unavailable')
})

test('the breaker opens after repeated failures and recovers after cooldown', async () => {
	const { bridge } = harness({
		services: {
			broken: {
				fail: () => {
					throw new Error('nope')
				},
			},
		},
		config: { breakerThreshold: 2, breakerCooldownMs: 40 },
	})

	const first = await bridge.call('broken', 'fail')
	const second = await bridge.call('broken', 'fail')
	assert.equal(first.error.code, 'failed')
	assert.equal(second.error.code, 'failed')

	const shorted = await bridge.call('broken', 'fail')
	assert.equal(shorted.ok, false)
	assert.equal(shorted.error.code, 'breaker-open')

	await new Promise(resolve => setTimeout(resolve, 50))
	const probe = await bridge.call('broken', 'fail')
	assert.equal(probe.error.code, 'failed', 'after the cooldown the call is attempted again')
})

test('a hung service call is cut off by the timeout', async () => {
	const { bridge } = harness({
		services: { slow: { forever: () => new Promise(() => {}) } },
		config: { timeoutMs: 20 },
	})
	const result = await bridge.call('slow', 'forever')
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'timeout')
})

test('every call lands in the audit trail with its caller and outcome', async () => {
	const { bridge } = harness({ services: { sampler: { ok: () => 'yes' } } })
	await bridge.call('sampler', 'ok')
	await bridge.invoke('does.not.exist', {}, { caller: 'auditor' })

	const trail = bridge.audit()
	assert.equal(trail.length, 2)
	assert.equal(trail[0].capability, 'service.call')
	assert.equal(trail[0].ok, true)
	assert.equal(trail[1].caller, 'auditor')
	assert.equal(trail[1].ok, false)
	assert.equal(typeof trail[0].ms, 'number')
})
