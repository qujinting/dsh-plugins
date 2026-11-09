/**
 * Behavioural tests for `config.edit`.
 *
 * The fake editor mirrors the two properties of the real one that the bridge
 * depends on: `configuration()` only exposes rows it is willing to edit, and
 * `edit(entry, change)` derives the persisted config through that callback
 * under its own lock. Everything else — YAML comment preservation, file locks,
 * reload coordination — belongs to the host, not to this plugin.
 */

import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { test } from 'node:test'

import { apply } from '../src/index.js'

/**
 * Build a fake host with a configEditor service over the given rows.
 * @param options - editable rows and plugin config.
 * @returns the bridge, the write log, and the rows.
 */
function harness({ rows = [], config = {} } = {}) {
	const store = new Map()
	const props = { loader: { type: 'service' }, configEditor: { type: 'service' } }
	const writes = []

	const editor = {
		configuration() {
			return rows
		},
		async edit(entry, change) {
			const row = rows.find(item => item.entry === entry)
			if (row === undefined) throw new Error('Configuration entry is no longer available')
			const next = change(structuredClone(row.entry.options.config ?? {}), structuredClone(row.inherited))
			// The real editor deletes the override entirely when it matches the
			// inherited layer, rather than writing the values back.
			row.override = isDeepStrictEqual(next, row.inherited) ? {} : next
			row.entry.options.config = next
			writes.push({ id: entry.id, next })
		},
	}
	store.set('configEditor', editor)
	store.set('loader', { entries: () => [][Symbol.iterator]() })

	const ctx = {
		reflect: { props },
		fiber: { state: 2, restart() {} },
		logger: { info() {}, warn() {} },
		get: serviceName => store.get(serviceName),
		provide(serviceName, value) {
			props[serviceName] = { type: 'service' }
			store.set(serviceName, value)
		},
		effect: run => run(),
	}

	apply(ctx, config)
	return { bridge: store.get('dshBridge'), writes, rows }
}

/** Build one editable row. */
const row = (id, config, inherited) => ({
	entry: { id, options: { id, name: `dsh-${id}`, config: structuredClone(config) } },
	inherited: structuredClone(inherited),
	override: structuredClone(config),
})

test('config.edit needs an explicit confirmation', async () => {
	const { bridge, writes } = harness({ rows: [row('target', { a: 1 }, { a: 1 })] })
	const refused = await bridge.invoke('config.edit', { plugin: 'target', patch: { a: 2 } })
	assert.equal(refused.ok, false)
	assert.equal(refused.error.code, 'confirmation-required')
	assert.deepEqual(writes, [])
})

test('config.edit refuses to rewrite the bridge\'s own row', async () => {
	const { bridge, writes } = harness({ rows: [row('dsh-bridge', { a: 1 }, {})] })
	const refused = await bridge.invoke('config.edit', {
		plugin: 'dsh-bridge',
		patch: { a: 2 },
		confirm: true,
	})
	assert.equal(refused.error.code, 'bad-request')
	assert.match(refused.error.message, /own row/)
	assert.deepEqual(writes, [])
})

test('a patch is merged and does not pin inherited defaults', async () => {
	// `limit` is supplied by the bundle layer and untouched by the caller, so it
	// must not be copied into the profile patch; `custom` only exists in the
	// profile layer and must survive.
	const { bridge, writes } = harness({
		rows: [row('target', { limit: 10, retries: 3, custom: 'keep' }, { limit: 10, retries: 3 })],
	})
	const result = await bridge.invoke('config.edit', {
		plugin: 'target',
		patch: { retries: 5 },
		confirm: true,
	})
	assert.equal(result.ok, true)
	assert.deepEqual(writes[0].next, { retries: 5, custom: 'keep' })
	assert.equal(result.value.saved, true)
	assert.equal(result.value.plugin, 'target')
})

test('an explicit undefined removes a key', async () => {
	const { bridge, writes } = harness({ rows: [row('target', { a: 1, b: 2 }, {})] })
	await bridge.invoke('config.edit', { plugin: 'target', patch: { b: undefined, a: 1 }, confirm: true })
	assert.deepEqual(writes[0].next, { a: 1 })
})

test('the complete-config mode writes exactly what it was given', async () => {
	const { bridge, writes } = harness({ rows: [row('target', { a: 1, b: 2 }, { a: 1, b: 2 })] })
	const result = await bridge.invoke('config.edit', {
		plugin: 'target',
		config: { only: true },
		confirm: true,
	})
	assert.equal(result.value.mode, 'config')
	assert.deepEqual(writes[0].next, { only: true })
})

test('dryRun reports the write without touching the profile', async () => {
	const { bridge, writes } = harness({ rows: [row('target', { a: 1, b: 2 }, { a: 1, b: 2 })] })
	const result = await bridge.invoke('config.edit', {
		plugin: 'target',
		patch: { a: 9 },
		dryRun: true,
		confirm: true,
	})
	assert.equal(result.ok, true)
	assert.deepEqual(writes, [], 'dryRun must not reach the editor at all')
	assert.equal(result.value.dryRun, true)
	assert.deepEqual(result.value.willWrite, { a: 9 }, 'only the touched field is pinned')
	assert.equal(result.value.removesOverride, false)
})

test('a patch that restores the inherited values removes the override', async () => {
	const { bridge } = harness({ rows: [row('target', { a: 2 }, { a: 1 })] })
	const result = await bridge.invoke('config.edit', { plugin: 'target', patch: { a: 1 }, confirm: true })
	assert.equal(result.ok, true)
	assert.equal(result.value.removesOverride, true)
	assert.deepEqual(result.value.persisted, { kind: 'object', fields: {}, truncated: false })
})

test('a target the editor will not edit is reported, not attempted', async () => {
	const { bridge, writes } = harness({ rows: [row('target', {}, {})] })
	const missing = await bridge.invoke('config.edit', { plugin: 'nowhere', patch: {}, confirm: true })
	assert.equal(missing.ok, false)
	assert.equal(missing.error.code, 'no-such-plugin')
	assert.match(missing.error.message, /root include/)

	const duplicate = await bridge.invoke('config.edit', { plugin: 'dsh-target', patch: { a: 1 }, confirm: true })
	assert.equal(duplicate.ok, true, 'the package name is accepted as well as the Loader id')
	assert.equal(writes.length, 1)
})

test('a profile without the config editor reports availability', async () => {
	const store = new Map()
	const props = { loader: { type: 'service' } }
	const ctx = {
		reflect: { props },
		fiber: { state: 2, restart() {} },
		logger: { info() {}, warn() {} },
		get: serviceName => store.get(serviceName),
		provide(serviceName, value) {
			props[serviceName] = { type: 'service' }
			store.set(serviceName, value)
		},
		effect: run => run(),
	}
	apply(ctx, {})
	const bridge = store.get('dshBridge')

	const result = await bridge.invoke('config.edit', { plugin: 'target', patch: {}, confirm: true })
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'service-unavailable')
})

test('bad request shapes are rejected before the editor is touched', async () => {
	const { bridge, writes } = harness({ rows: [row('target', {}, {})] })
	for (const params of [
		{ plugin: 'target', confirm: true },
		{ plugin: 'target', config: [], confirm: true },
		{ plugin: 'target', patch: 'nope', confirm: true },
		{ patch: { a: 1 }, confirm: true },
	]) {
		const result = await bridge.invoke('config.edit', params)
		assert.equal(result.ok, false, JSON.stringify(params))
		assert.equal(result.error.code, 'bad-request', JSON.stringify(params))
	}
	assert.deepEqual(writes, [])
})

test('a rejected write leaves the earlier config in place', async () => {
	const rows = [row('target', { a: 1 }, {})]
	const { bridge } = harness({ rows })
	const editor = {
		configuration: () => rows,
		edit: async () => {
			throw new Error('Configuration for "target" is overridden by a home patch or command-line overlay')
		},
	}
	const store = new Map([['configEditor', editor], ['loader', { entries: () => [][Symbol.iterator]() }]])
	const props = { loader: { type: 'service' }, configEditor: { type: 'service' } }
	const ctx = {
		reflect: { props },
		fiber: { state: 2, restart() {} },
		logger: { info() {}, warn() {} },
		get: serviceName => store.get(serviceName),
		provide(serviceName, value) {
			props[serviceName] = { type: 'service' }
			store.set(serviceName, value)
		},
		effect: run => run(),
	}
	apply(ctx, {})
	const bridged = store.get('dshBridge')

	const result = await bridged.invoke('config.edit', { plugin: 'target', patch: { a: 2 }, confirm: true })
	assert.equal(result.ok, false)
	assert.match(result.error.message, /overridden/)
	assert.deepEqual(rows[0].entry.options.config, { a: 1 })
})
