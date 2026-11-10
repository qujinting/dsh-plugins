/**
 * Integration tests against the **real** cordis runtime shipped with DSH.
 *
 * The rest of the suite runs on a hand-written stand-in, which is fast and
 * honest about the contract but cannot prove the bridge still speaks the actual
 * framework. This file boots a genuine `Context` from the installation, provides
 * real services through it, and drives the capability table end to end.
 *
 * It is skipped when the installation is not present, so the package stays
 * testable on a machine that only has the sources. Point `DSH_APP_ROOT` at a
 * different checkout to test that one.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

// Relaunch plans and the restart ledger live under DSH_HOME; keep them out of
// the operator's real profile.
process.env.DSH_HOME ??= mkdtempSync(join(tmpdir(), 'dsh-bridge-test-'))

import { apply } from '../src/index.js'

const APP_ROOT = process.env.DSH_APP_ROOT ?? 'D:/apps/DSH/resources/app/dsh'
const CORDIS = join(APP_ROOT, 'node_modules/@deepseek-ai/cordis/lib/index.js')
const available = existsSync(CORDIS)
const skip = available ? false : `no cordis installation at ${CORDIS}`

/**
 * Boot a real cordis context with the given fixtures and the bridge on it.
 * @param fixtures - services to provide on the root context.
 * @param config - bridge configuration.
 * @returns the root context and the provided bridge.
 */
async function boot(fixtures, config = {}) {
	const { Context } = await import(pathToFileURL(CORDIS).href)
	const root = new Context()

	await root.plugin({
		name: 'fixtures',
		apply(ctx) {
			for (const [name, value] of Object.entries(fixtures)) ctx.provide(name, value)
		},
	})
	await root.plugin({ name: 'dsh-bridge', apply }, config)

	return { root, bridge: root.get('dshBridge') }
}

test('the bridge speaks the real cordis context', { skip }, async () => {
	const { root, bridge } = await boot({ sampler: { ping: () => 'pong' } })

	assert.equal(root.fiber.state, 2, 'the root fiber is settled')
	assert.equal(bridge.version, 3)
	assert.deepEqual(
		bridge.list().map(item => item.name).sort(),
		['app.exit', 'app.restart', 'app.restartState', 'config.edit', 'plugin.list', 'plugin.restart', 'service.call', 'service.describe', 'service.list'],
	)

	const list = await bridge.invoke('service.list')
	assert.equal(list.ok, true, JSON.stringify(list.error))
	const sampler = list.value.find(row => row.name === 'sampler')
	assert.equal(sampler.available, true, 'service.list reads the real reflect.props')
	assert.equal(sampler.denied, false)

	const called = await bridge.call('sampler', 'ping')
	assert.equal(called.ok, true, JSON.stringify(called.error))
	assert.equal(called.value.value, 'pong')
})

test('the real context keeps the default gates closed', { skip }, async () => {
	const calls = []
	const { bridge } = await boot({
		loader: {
			entries: () => [][Symbol.iterator](),
			update: async id => calls.push(id),
			import: async name => calls.push(name),
		},
		shell: { run: async command => calls.push(command) },
	})

	const denied = await bridge.invoke('service.call', { service: 'loader', method: 'entries' })
	assert.equal(denied.error.code, 'service-denied')

	const shell = await bridge.invoke('service.call', { service: 'shell', method: 'run', args: ['whoami'] })
	assert.equal(shell.error.code, 'service-denied')

	assert.deepEqual(calls, [])
})

test('re-enabling a service still leaves its mutators behind the method gate', { skip }, async () => {
	const calls = []
	const { bridge } = await boot(
		{
			loader: {
				entries: () => [][Symbol.iterator](),
				update: async id => calls.push(id),
				import: async name => calls.push(name),
			},
		},
		{ serviceDeny: ['credentials', 'configEditor', 'dshBridge'] },
	)

	const entries = await bridge.invoke('service.call', { service: 'loader', method: 'entries' })
	assert.equal(entries.ok, true, JSON.stringify(entries.error))

	const update = await bridge.invoke('service.call', { service: 'loader', method: 'update', args: ['row-1', {}] })
	assert.equal(update.error.code, 'method-denied')

	const imported = await bridge.invoke('service.call', { service: 'loader', method: 'import', args: ['file:///tmp/x.js'] })
	assert.equal(imported.error.code, 'method-denied')

	assert.deepEqual(calls, [])
})

test('the real context refuses non-data arguments before reaching the service', { skip }, async () => {	let touched = 0
	const { bridge } = await boot({
		sampler: {
			take(value) {
				touched += 1
				return typeof value
			},
		},
	})

	const callback = await bridge.invoke('service.call', { service: 'sampler', method: 'take', args: [() => {}] })
	assert.equal(callback.error.code, 'bad-request')
	assert.equal(touched, 0)

	const plain = await bridge.invoke('service.call', { service: 'sampler', method: 'take', args: [{ ok: true }] })
	assert.equal(plain.ok, true)
	assert.equal(plain.value.value, 'object')
	assert.equal(touched, 1)
})
