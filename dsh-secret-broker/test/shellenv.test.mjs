/**
 * Injection: what one shell execution receives, and why.
 *
 * These are the tests that encode the security claim — an execution gets a
 * value only when the command names it and only when the scope applies — so
 * they are written against the same store the host uses, not a hand-rolled
 * stand-in.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ShellEnvBridge, parseMarkers, resolveEnvironment } from '../src/shellenv.js'
import { GLOBAL_SCOPE, SecretStore, projectScope, sessionScope } from '../src/store.js'
import { createFakeShellEnv } from './helpers.mjs'

/** A loaded plaintext store with a few keys already in it. */
async function seededStore() {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-shellenv-'))
	const store = new SecretStore({ dataDir, encryption: 'none', keyPrefix: 'DSH_SECRET_', maxEntries: 200, logger: { warn() {} } })
	await store.set({ key: 'GLOBAL_TOKEN', value: 'global-value', scope: GLOBAL_SCOPE })
	await store.set({ key: 'OWN_TOKEN', value: 'session-value', scope: sessionScope('session-a') })
	await store.set({ key: 'OTHER_TOKEN', value: 'other-value', scope: sessionScope('session-b') })
	return store
}

/** A minimal tool execution as `ctx.shellEnv.resolve` receives it. */
function execution(command, sessionId, cwd) {
	return {
		name: 'pwsh',
		arguments: { command },
		agent: sessionId === undefined ? undefined : { session: { header: { id: sessionId, ...(cwd === undefined ? {} : { cwd }) } } },
	}
}

test('a project key reaches any session working in that directory', async () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-shellenv-'))
	const store = new SecretStore({ dataDir, encryption: 'none', keyPrefix: 'DSH_SECRET_', maxEntries: 200, logger: { warn() {} } })
	await store.set({ key: 'REPO_TOKEN', value: 'repo-value', scope: projectScope('D:\\work\\repo') })
	const command = 'echo $env:DSH_SECRET_REPO_TOKEN'
	assert.deepEqual(
		resolveEnvironment(store, execution(command, 'some-other-session', 'D:\\work\\repo\\packages\\app')),
		{ DSH_SECRET_REPO_TOKEN: 'repo-value' },
		'a different session in a subdirectory is still inside the project',
	)
	assert.deepEqual(resolveEnvironment(store, execution(command, 'some-other-session', 'D:\\work\\elsewhere')), {}, 'and outside it gets nothing')
	assert.deepEqual(resolveEnvironment(store, execution(command, 'some-other-session', undefined)), {}, 'no working directory, no project key')
})

test('a session key beats the project key of the directory it works in', async () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-shellenv-'))
	const store = new SecretStore({ dataDir, encryption: 'none', keyPrefix: 'DSH_SECRET_', maxEntries: 200, logger: { warn() {} } })
	await store.set({ key: 'TOKEN', value: 'repo-value', scope: projectScope('D:\\work\\repo') })
	await store.set({ key: 'TOKEN', value: 'session-value', scope: sessionScope('s1') })
	const command = 'echo $env:DSH_SECRET_TOKEN'
	assert.deepEqual(resolveEnvironment(store, execution(command, 's1', 'D:\\work\\repo')), { DSH_SECRET_TOKEN: 'session-value' })
	assert.deepEqual(resolveEnvironment(store, execution(command, 's2', 'D:\\work\\repo')), { DSH_SECRET_TOKEN: 'repo-value' })
})

test('parseMarkers reads the key list and the `all` escape hatch', () => {
	assert.deepEqual([...parseMarkers('# secret-broker: A, b').keys], ['a', 'b'])
	assert.equal(parseMarkers('# secret-broker: A, B').all, false)
	assert.equal(parseMarkers('no marker here').keys.size, 0)
	const all = parseMarkers('#secret-broker: all')
	assert.equal(all.all, true)
	assert.equal(parseMarkers('echo hi # secret-broker: X\nmore').keys.has('x'), true)
})

test('a command that does not name a variable receives nothing', async () => {
	const store = await seededStore()
	assert.deepEqual(resolveEnvironment(store, execution('Get-ChildItem env:', 'session-a')), {})
	assert.deepEqual(resolveEnvironment(store, execution('npm run deploy', 'session-a')), {})
})

test('a named variable is injected, and only that one', async () => {
	const store = await seededStore()
	const values = resolveEnvironment(store, execution('curl -H "Authorization: Bearer $env:DSH_SECRET_GLOBAL_TOKEN" https://x', 'session-a'))
	assert.deepEqual(values, { DSH_SECRET_GLOBAL_TOKEN: 'global-value' })
})

test('variable names match case-insensitively', async () => {
	const store = await seededStore()
	const values = resolveEnvironment(store, execution('echo $env:dsh_secret_global_token', 'session-a'))
	assert.deepEqual(values, { DSH_SECRET_GLOBAL_TOKEN: 'global-value' })
})

test('the marker opts a script in without naming the variable', async () => {
	const store = await seededStore()
	const command = '# secret-broker: OWN_TOKEN\npwsh -File ./deploy.ps1'
	assert.deepEqual(resolveEnvironment(store, execution(command, 'session-a')), { DSH_SECRET_OWN_TOKEN: 'session-value' })
})

test('`all` injects every entry the session may use', async () => {
	const store = await seededStore()
	const values = resolveEnvironment(store, execution('# secret-broker: all\n./run.ps1', 'session-a'))
	assert.deepEqual(values, {
		DSH_SECRET_GLOBAL_TOKEN: 'global-value',
		DSH_SECRET_OWN_TOKEN: 'session-value',
	})
})

test('another session\'s entries stay out, and a session value shadows a global one', async () => {
	const store = await seededStore()
	assert.deepEqual(resolveEnvironment(store, execution('# secret-broker: all\nx', 'session-b')), {
		DSH_SECRET_GLOBAL_TOKEN: 'global-value',
		DSH_SECRET_OTHER_TOKEN: 'other-value',
	})
	await store.set({ key: 'GLOBAL_TOKEN', value: 'shadowed', scope: sessionScope('session-a') })
	const values = resolveEnvironment(store, execution('echo $env:DSH_SECRET_GLOBAL_TOKEN', 'session-a'))
	assert.deepEqual(values, { DSH_SECRET_GLOBAL_TOKEN: 'shadowed' })
})

test('a non-shell execution is never injected', async () => {
	const store = await seededStore()
	assert.deepEqual(resolveEnvironment(store, { name: 'read', arguments: { path: 'DSH_SECRET_GLOBAL_TOKEN' }, agent: { session: { header: { id: 'session-a' } } } }), {})
	assert.deepEqual(resolveEnvironment(store, { name: 'pwsh', arguments: {}, agent: undefined }), {})
})

test('the bridge declares the union of scopes and replaces itself as keys change', async () => {
	const store = await seededStore()
	const shellEnv = createFakeShellEnv()
	const bridge = new ShellEnvBridge(shellEnv, store)
	assert.equal(bridge.sync(), true)
	assert.deepEqual(Object.keys(shellEnv.contributors.get('secret-broker').variables).sort(), [
		'DSH_SECRET_GLOBAL_TOKEN', 'DSH_SECRET_OTHER_TOKEN', 'DSH_SECRET_OWN_TOKEN',
	])
	for (const variable of Object.values(shellEnv.contributors.get('secret-broker').variables)) {
		assert.ok(variable.description.trim().length > 0, 'the registry rejects a description-less declaration')
	}

	await store.set({ key: 'LATE', value: 'late-value', scope: GLOBAL_SCOPE },)
	assert.equal(bridge.sync(), true)
	assert.ok(Object.hasOwn(shellEnv.contributors.get('secret-broker').variables, 'DSH_SECRET_LATE'))
	assert.equal(shellEnv.contributors.size, 1, 'the old registration was released before the new one')

	bridge.release()
	assert.equal(shellEnv.contributors.size, 0)
})

test('the bridge reports a registry refusal instead of throwing', async () => {
	const store = await seededStore()
	const bridge = new ShellEnvBridge({
		register() {
			throw new Error('duplicate contributor')
		},
	}, store)
	assert.equal(bridge.sync(), false)
	assert.equal(bridge.dispose, undefined)
})
