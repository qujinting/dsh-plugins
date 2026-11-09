/**
 * Plugin assembly.
 *
 * `apply` is where a wrong assumption becomes a broken composition, so these
 * tests are about what it registers, what it leaves alone, what it does when an
 * optional service is simply not mounted, and — the one integration claim worth
 * making here — that a key written through the HTTP route reaches the
 * shell-environment contributor without a restart.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply, inject, name, readOptions } from '../src/index.js'
import { KEYS_VARIABLE, PROMPT_SECTION_NAME } from '../src/prompt.js'
import { callRoute, createFakeContext, createFakeShellEnv } from './helpers.mjs'

/** A data directory that disappears with the test. */
function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-host-'))
}

/** Let the store's async load settle. */
function settle() {
	return new Promise((resolve) => setTimeout(resolve, 30))
}

/**
 * A context carrying every service the plugin may reach for, with recording
 * stubs for the four registries.
 * @param options - service overrides and omissions.
 * @param options.omit - service names to leave unmounted.
 * @returns the fake context.
 */
function fullContext({ omit = [] } = {}) {
	const shellEnv = createFakeShellEnv()
	const all = {
		shellEnv,
		tools: { register: (tool) => { void tool; return () => {} } },
		systemPrompt: { section: () => () => {}, variable: () => () => {} },
		skills: { register: () => () => {} },
		webServer: { register: () => () => {} },
		agents: { list: () => [] },
	}
	return createFakeContext((records) => {
		const services = {}
		for (const [key, value] of Object.entries(all)) {
			if (omit.includes(key)) continue
			services[key] = value
		}
		if (!omit.includes('tools')) {
			services.tools = {
				register(tool) {
					records.tools.push(tool)
					return () => {}
				},
			}
		}
		if (!omit.includes('systemPrompt')) {
			services.systemPrompt = {
				section(section) {
					records.sections.push(section)
					return () => {}
				},
				variable(variableName, provider) {
					records.variables.push({ name: variableName, provider })
					return () => {}
				},
			}
		}
		if (!omit.includes('skills')) {
			services.skills = {
				register(skill) {
					records.skills.push(skill)
					return () => {}
				},
			}
		}
		if (!omit.includes('webServer')) {
			services.webServer = {
				register(route) {
					records.routes.push(route)
					return () => {}
				},
			}
		}
		return services
	})
}

const ROUTE_OPTIONS = { allowReveal: true, redactResults: true, keyPrefix: 'DSH_SECRET_' }

test('the plugin declares its two required services', () => {
	assert.equal(name, 'secret-broker')
	assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

test('readOptions fills defaults and rejects unusable values', () => {
	const warnings = []
	const options = readOptions({
		dataDir: 'custom',
		keyPrefix: 'NOPE_',
		toolName: 'Bad Name',
		redactMinLength: 1,
		maxEntries: 999_999,
		encryption: 'none',
		titleBarValues: 'shouting',
	}, (message) => warnings.push(message))
	assert.ok(path.isAbsolute(options.dataDir))
	assert.ok(options.dataDir.endsWith(`${path.sep}custom`))
	assert.equal(options.keyPrefix, 'DSH_SECRET_')
	assert.equal(options.toolName, 'secret_list')
	assert.equal(options.redactMinLength, 8)
	assert.equal(options.maxEntries, 200)
	assert.equal(options.encryption, 'none')
	assert.equal(options.titleBarValues, 'masked')
	assert.equal(warnings.length, 5)

	const bare = readOptions(undefined)
	assert.equal(bare.allowReveal, true)
	assert.equal(bare.redactResults, true)
	assert.equal(bare.titleBarValues, 'masked', 'the title bar masks values unless a deployment says otherwise')
	assert.equal(bare.registerSkill, true)
	assert.equal(bare.registerPromptSection, true)
	assert.ok(bare.dataDir.endsWith(`${path.sep}data`))
})

test('apply registers the tool, the prompt contributions, the skill, the routes and the listeners', async () => {
	const ctx = fullContext()
	apply(ctx, { dataDir: tempDir() })
	await settle()

	assert.deepEqual(ctx.records.sections.map((section) => section.name), [PROMPT_SECTION_NAME])
	assert.deepEqual(ctx.records.variables.map((variable) => variable.name), [KEYS_VARIABLE])
	assert.equal(ctx.records.tools.length, 1)
	assert.equal(ctx.records.tools[0].name, 'secret_list')
	assert.equal(ctx.records.skills.length, 1)
	assert.equal(ctx.records.skills[0].name, 'secret-broker')
	assert.equal(ctx.records.routes.length, 1)
	assert.equal(ctx.records.listeners.get('tools/post-execute').length, 1)
	assert.equal(ctx.records.listeners.get('tools/ptc-dispatch-log').length, 1)
	assert.equal(ctx.shellEnv.contributors.size, 1, 'the shell-environment contributor is live')
	assert.deepEqual(Object.keys(ctx.shellEnv.contributors.get('secret-broker').variables), [], 'an empty store declares nothing')
	assert.equal(ctx.records.warnings.length, 0, `no warnings expected: ${ctx.records.warnings.join('; ')}`)
})

test('the prompt section states the convention and the variable always answers', async () => {
	const ctx = fullContext()
	apply(ctx, { dataDir: tempDir() })
	await settle()
	const section = ctx.records.sections[0]
	assert.ok(section.text.includes(`{{${KEYS_VARIABLE}}}`))
	assert.ok(section.text.includes('DSH_SECRET_'))
	assert.equal(section.order, 2260)

	const provider = ctx.records.variables[0].provider
	assert.equal(typeof provider({ agent: undefined }), 'string')
	assert.match(provider({ agent: undefined }), /尚未录入/)
	assert.equal(typeof provider({}), 'string', 'a context with no agent at all still answers')
})

test('a key written through the route reaches the shell contributor without a restart', async () => {
	const ctx = fullContext()
	apply(ctx, { dataDir: tempDir() })
	await settle()
	assert.deepEqual(Object.keys(ctx.shellEnv.contributors.get('secret-broker').variables), [])

	const response = await callRoute(ctx, {
		method: 'POST',
		path: '/set',
		headers: { host: '127.0.0.1:19387' },
		rawBody: JSON.stringify({ key: 'gh-token', value: 'super-secret-value', scope: 'global' }),
	})
	assert.equal(response.statusCode, 200)
	assert.deepEqual(Object.keys(ctx.shellEnv.contributors.get('secret-broker').variables), ['DSH_SECRET_GH_TOKEN'])
	assert.equal(ctx.shellEnv.contributors.size, 1, 'the replacement released the previous registration')

	// The declared resolver is the one that decides what a shell call receives.
	const contributor = ctx.shellEnv.contributors.get('secret-broker')
	assert.deepEqual(
		contributor.resolve({ name: 'pwsh', arguments: { command: 'echo $env:DSH_SECRET_GH_TOKEN' }, agent: undefined }),
		{ DSH_SECRET_GH_TOKEN: 'super-secret-value' },
	)
	assert.deepEqual(contributor.resolve({ name: 'pwsh', arguments: { command: 'Get-ChildItem env:' }, agent: undefined }), {})

	// And the tool the model calls never sees the value.
	const tool = ctx.records.tools[0]
	const value = await tool.execute({}, { agent: { session: { header: { id: 'session-a' } } } })
	assert.deepEqual(value.keys.map((entry) => [entry.key, entry.env, entry.scope]), [['gh-token', 'DSH_SECRET_GH_TOKEN', 'global']])
	assert.ok(!JSON.stringify(value).includes('super-secret-value'))
	assert.match(tool.output.render({}, value)[0].text, /DSH_SECRET_GH_TOKEN/)
})

test('the route is not registered without a web server, and the gap is reported', async () => {
	const ctx = fullContext({ omit: ['webServer'] })
	apply(ctx, { dataDir: tempDir(), ...ROUTE_OPTIONS })
	await settle()
	assert.equal(ctx.records.routes.length, 0)
	assert.ok(ctx.records.warnings.some((warning) => warning.includes('webServer')), ctx.records.warnings.join('; '))
})

test('a context without the optional services still loads', async () => {
	const ctx = fullContext({ omit: ['shellEnv', 'webServer', 'skills'] })
	apply(ctx, { dataDir: tempDir() })
	await settle()
	assert.equal(ctx.records.tools.length, 1)
	assert.equal(ctx.records.routes.length, 0)
	assert.equal(ctx.records.skills.length, 0)
	assert.ok(ctx.records.warnings.some((warning) => warning.includes('shellEnv')), ctx.records.warnings.join('; '))
})

test('registration is disposed with the plugin fiber', async () => {
	const ctx = fullContext()
	apply(ctx, { dataDir: tempDir() })
	await settle()
	assert.equal(ctx.shellEnv.contributors.size, 1)
	ctx.disposeAll()
	assert.equal(ctx.shellEnv.contributors.size, 0)
	assert.equal(ctx.records.listeners.get('tools/post-execute').length, 0)
	assert.equal(ctx.records.listeners.get('tools/ptc-dispatch-log').length, 0)
})

test('registerSkill and registerPromptSection can be turned off', async () => {
	const ctx = fullContext()
	apply(ctx, { dataDir: tempDir(), registerSkill: false, registerPromptSection: false })
	await settle()
	assert.equal(ctx.records.skills.length, 0)
	assert.equal(ctx.records.sections.length, 0)
	assert.equal(ctx.records.variables.length, 0)
	assert.equal(ctx.records.tools.length, 1, 'the tool is not optional')
})
