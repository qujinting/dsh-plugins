/**
 * Store behaviour: validation, scope semantics, persistence, and the locked
 * posture that protects a blob the process cannot open.
 *
 * Encryption is exercised separately (`crypto.test.mjs`); these tests run the
 * plaintext path so they stay fast and deterministic, except for the one case
 * that is specifically about what happens to a sealed file.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { GLOBAL_SCOPE, SecretStore, envNameFor, pathContains, projectDirectory, projectScope, scopesOverlap, sessionScope } from '../src/store.js'

/** A fresh data directory per test. */
function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-store-'))
}

/** A plaintext store over one directory. */
function storeIn(dir, overrides = {}) {
	return new SecretStore({
		dataDir: dir,
		encryption: 'none',
		keyPrefix: 'DSH_SECRET_',
		maxEntries: 200,
		logger: { warn() {} },
		...overrides,
	})
}

test('envNameFor upper-cases and folds separators', () => {
	assert.equal(envNameFor('gh-token', 'DSH_SECRET_'), 'DSH_SECRET_GH_TOKEN')
	assert.equal(envNameFor('DB_PASS', 'DSH_SECRET_'), 'DSH_SECRET_DB_PASS')
	assert.equal(envNameFor('a-b_c', 'DSH_SECRET_'), 'DSH_SECRET_A_B_C')
})

test('a project scope is a normalized directory, never a session', () => {
	const resolved = path.resolve('D:\\work\\repo')
	assert.equal(projectScope('D:\\work\\repo\\'), `project:${resolved}`, 'a trailing separator is not a second project')
	assert.equal(projectScope('  D:\\work\\repo  '), `project:${resolved}`, 'surrounding whitespace is forgiven')
	assert.equal(projectScope('D:\\work\\repo'), projectScope('D:\\work\\repo\\'), 'both spellings are one scope')
	assert.equal(projectScope(''), undefined)
	assert.equal(projectScope(undefined), undefined)
	assert.equal(projectDirectory(`project:${resolved}`), resolved)
	assert.equal(projectDirectory(GLOBAL_SCOPE), undefined)
	assert.equal(projectDirectory(sessionScope('s1')), undefined)
})

test('pathContains is a path comparison, not a string prefix', () => {
	assert.equal(pathContains('D:\\work\\repo', 'D:\\work\\repo'), true)
	assert.equal(pathContains('D:\\work\\repo', 'D:\\work\\repo\\packages\\app'), true)
	assert.equal(pathContains('D:\\work\\repo', 'D:\\work\\repository'), false, 'a sibling whose name merely starts the same way is outside')
	assert.equal(pathContains('D:\\work\\repo', 'D:\\work'), false)
})

test('scope overlap decides which pairs may share a variable name', () => {
	assert.equal(scopesOverlap(GLOBAL_SCOPE, sessionScope('s1')), true)
	assert.equal(scopesOverlap(GLOBAL_SCOPE, projectScope('D:\\work\\repo')), true)
	assert.equal(scopesOverlap(projectScope('D:\\work\\repo'), projectScope('D:\\work\\repo\\pkg')), true, 'a project overlaps its own subdirectory')
	assert.equal(scopesOverlap(projectScope('D:\\work\\one'), projectScope('D:\\work\\two')), false, 'siblings never apply together')
	assert.equal(scopesOverlap(projectScope('D:\\work\\repo'), sessionScope('s1')), true, 'a session may well be in that project')
	assert.equal(scopesOverlap(sessionScope('s1'), sessionScope('s2')), false)
})

test('project entries follow the working directory, and specificity decides who wins', async () => {
	const store = storeIn(tempDir())
	await store.set({ key: 'TOKEN', value: 'global', scope: GLOBAL_SCOPE })
	await store.set({ key: 'TOKEN', value: 'repo', scope: projectScope('D:\\work\\repo') })
	await store.set({ key: 'TOKEN', value: 'package', scope: projectScope('D:\\work\\repo\\packages\\app') })
	await store.set({ key: 'TOKEN', value: 'session', scope: sessionScope('s1') })
	await store.set({ key: 'ONLY_REPO', value: 'x', scope: projectScope('D:\\work\\repo') })

	const pick = (sessionId, cwd) => Object.fromEntries(store.effective(sessionId, cwd).map((entry) => [entry.key, entry.value]))
	assert.equal(pick(undefined, 'D:\\work\\repo').TOKEN, 'repo')
	assert.equal(pick(undefined, 'D:\\work\\repo\\packages\\app\\src').TOKEN, 'package', 'the deepest project wins')
	assert.equal(pick(undefined, 'D:\\work\\repo\\other').TOKEN, 'repo', 'a subdirectory still gets the repository key')
	assert.equal(pick(undefined, 'D:\\work\\elsewhere').TOKEN, 'global')
	assert.equal(pick('s1', 'D:\\work\\elsewhere').TOKEN, 'session', 'a session beats every project')
	assert.equal(pick(undefined, 'D:\\work\\repo').ONLY_REPO, 'x')
	assert.equal(pick(undefined, undefined).ONLY_REPO, undefined, 'no working directory means no project keys')
	assert.equal(pick(undefined, undefined).TOKEN, 'global')
})

test('a project key outlives the session that created it', async () => {
	const dir = tempDir()
	const first = storeIn(dir)
	await first.set({ key: 'TOKEN', value: 'v', scope: projectScope('D:\\work\\repo') })
	await first.ready
	// A brand-new session in the same directory sees it; no session id involved.
	const second = storeIn(dir)
	await second.ready
	assert.equal(second.effective('a-different-session', 'D:\\work\\repo').length, 1)
})

test('sibling projects may share a variable name; nested and session scopes may not', async () => {
	const store = storeIn(tempDir())
	await store.set({ key: 'A', value: '1', scope: projectScope('D:\\work\\one') })
	await store.set({ key: 'a', value: '2', scope: projectScope('D:\\work\\two') })
	assert.equal(store.all().length, 2, 'two projects that never apply together may collide')
	await assert.rejects(
		() => store.set({ key: 'a', value: '3', scope: projectScope('D:\\work\\one\\sub') }),
		/已被/,
		'a nested project overlaps its parent, so the flat namespace collides',
	)
	await assert.rejects(
		() => store.set({ key: 'a', value: '4', scope: sessionScope('s1') }),
		/已被/,
		'a session overlaps every project, so it collides too',
	)
})

test('set/get round trip, and session entries shadow globals of the same key', async () => {
	const store = storeIn(tempDir())
	await store.ready
	await store.set({ key: 'TOKEN', value: 'global-value', scope: GLOBAL_SCOPE, description: '默认' })
	await store.set({ key: 'TOKEN', value: 'session-value', scope: sessionScope('s1'), description: '本项目' })
	await store.set({ key: 'OTHER', value: 'other', scope: GLOBAL_SCOPE })

	const forS1 = store.effective('s1')
	assert.deepEqual(forS1.map((entry) => [entry.key, entry.value]), [['OTHER', 'other'], ['TOKEN', 'session-value']])
	const forS2 = store.effective('s2')
	assert.deepEqual(forS2.map((entry) => [entry.key, entry.value]), [['OTHER', 'other'], ['TOKEN', 'global-value']])
	assert.deepEqual(store.effective(undefined).map((entry) => entry.key), ['OTHER', 'TOKEN'], 'no session means globals only')
})

test('an entry is replaced in place rather than duplicated', async () => {
	const store = storeIn(tempDir())
	await store.set({ key: 'A', value: 'one', scope: GLOBAL_SCOPE, description: 'first' })
	const created = store.all()[0]
	await store.set({ key: 'A', value: 'two', scope: GLOBAL_SCOPE, description: 'second' })
	assert.equal(store.all().length, 1)
	const updated = store.all()[0]
	assert.equal(updated.value, 'two')
	assert.equal(updated.description, 'second')
	assert.equal(updated.createdAt, created.createdAt, 'creation time is preserved across an update')
})

test('the key grammar and an empty value are refused', async () => {
	const store = storeIn(tempDir())
	await assert.rejects(() => store.set({ key: '1BAD', value: 'x', scope: GLOBAL_SCOPE }), /密钥名/)
	await assert.rejects(() => store.set({ key: 'has space', value: 'x', scope: GLOBAL_SCOPE }), /密钥名/)
	await assert.rejects(() => store.set({ key: 'A', value: '', scope: GLOBAL_SCOPE }), /值不能为空/)
	await assert.rejects(() => store.set({ key: 'A', value: 'x', scope: 'nope' }), /作用域/)
	await assert.rejects(() => store.set({ key: 'A', value: 'x', scope: 'session:  ' }), /作用域/)
})

test('two different keys that fold to one variable name cannot coexist', async () => {
	const store = storeIn(tempDir())
	await store.set({ key: 'gh-token', value: 'a', scope: GLOBAL_SCOPE })
	await assert.rejects(() => store.set({ key: 'GH_TOKEN', value: 'b', scope: GLOBAL_SCOPE }), /已被/)
	await assert.rejects(
		() => store.set({ key: 'GH_TOKEN', value: 'b', scope: sessionScope('s1') }),
		/已被/,
		'a session scope overlaps the global one, so the flat namespace still collides',
	)
	// The same key in two overlapping scopes is shadowing, not a collision.
	await store.set({ key: 'gh-token', value: 'b', scope: sessionScope('s1') })
	assert.equal(store.effective('s1').length, 1, 'the session entry shadows the global one')
	assert.equal(store.effective('s1')[0].value, 'b')

	// Two different sessions never apply together, so their entries may collide
	// as long as no global entry already owns that variable name.
	await store.set({ key: 'B', value: 'one', scope: sessionScope('s1') })
	await store.set({ key: 'b', value: 'two', scope: sessionScope('s2') })
	assert.equal(store.effective('s2').find((entry) => entry.env === 'DSH_SECRET_B').value, 'two')
})

test('a scope is normalized to its canonical form', async () => {
	const store = storeIn(tempDir())
	await store.set({ key: 'A', value: 'x', scope: ' session:s1 ' })
	assert.equal(store.all()[0].scope, sessionScope('s1'))
	assert.equal(store.effective('s1')[0].value, 'x')
})

test('remove and promote', async () => {
	const store = storeIn(tempDir())
	await store.set({ key: 'A', value: 'x', scope: sessionScope('s1') })
	await store.set({ key: 'B', value: 'y', scope: sessionScope('s1') })
	assert.equal(await store.remove({ key: 'A', scope: sessionScope('s1') }), true)
	assert.equal(await store.remove({ key: 'A', scope: sessionScope('s1') }), false)

	await store.promote({ key: 'B', from: sessionScope('s1'), to: GLOBAL_SCOPE })
	assert.equal(store.all().length, 1)
	assert.equal(store.all()[0].scope, GLOBAL_SCOPE)

	await store.set({ key: 'B', value: 'z', scope: sessionScope('s1') })
	await store.promote({ key: 'B', from: sessionScope('s1'), to: GLOBAL_SCOPE })
	assert.equal(store.all().length, 1, 'promoting onto an existing key consumes it')
	assert.equal(store.all()[0].value, 'z')
	assert.equal(store.all()[0].scope, GLOBAL_SCOPE)
})

test('the declaration set is the union over every scope, with non-empty descriptions', async () => {
	const store = storeIn(tempDir())
	await store.set({ key: 'A', value: 'x', scope: GLOBAL_SCOPE })
	await store.set({ key: 'B', value: 'y', scope: sessionScope('s1') })
	const declarations = store.declarations()
	assert.deepEqual(Object.keys(declarations).sort(), ['DSH_SECRET_A', 'DSH_SECRET_B'])
	for (const variable of Object.values(declarations)) {
		assert.ok(variable.description.trim().length > 0, 'the registry requires a description')
	}
})

test('redaction pairs are ordered longest value first and follow the scope rules', async () => {
	const store = storeIn(tempDir())
	await store.set({ key: 'SHORT', value: 'abcdefgh', scope: GLOBAL_SCOPE })
	await store.set({ key: 'LONG', value: 'abcdefghijkl', scope: GLOBAL_SCOPE })
	const pairs = store.redactionPairs(undefined)
	assert.deepEqual(pairs.map(([, key]) => key), ['LONG', 'SHORT'])
})

test('entries survive a restart through the plaintext file', async () => {
	const dir = tempDir()
	const first = storeIn(dir)
	await first.set({ key: 'A', value: 'x', scope: GLOBAL_SCOPE, description: 'kept' })
	await first.ready
	const second = storeIn(dir)
	await second.ready
	assert.deepEqual(second.all().map((entry) => [entry.key, entry.value, entry.description]), [['A', 'x', 'kept']])
	assert.equal(second.locked, false)
})

test('a corrupt document is reported and leaves the store empty but writable', async () => {
	const dir = tempDir()
	fs.writeFileSync(path.join(dir, 'secrets.json'), '{ not json')
	const store = storeIn(dir)
	await store.ready
	assert.equal(store.all().length, 0)
	assert.equal(store.locked, false)
	assert.ok(store.warnings.some((warning) => warning.code === 'corrupt'))
})

test('invalid or duplicate records are dropped with a warning', async () => {
	const dir = tempDir()
	fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({
		version: 1,
		entries: [
			{ scope: 'global', key: 'GOOD', value: 'x' },
			{ scope: 'global', key: '1BAD', value: 'x' },
			{ scope: 'global', key: 'GOOD', value: 'y' },
			{ scope: 'nowhere', key: 'OTHER', value: 'z' },
		],
	}))
	const store = storeIn(dir)
	await store.ready
	assert.deepEqual(store.all().map((entry) => entry.key), ['GOOD'])
	assert.equal(store.warnings.filter((warning) => warning.code === 'entryDropped').length, 3)
})

test('a sealed document with no usable cipher locks the store instead of erasing it', async () => {
	const dir = tempDir()
	const sealed = path.join(dir, 'secrets.dpapi')
	fs.writeFileSync(sealed, Buffer.from('not really a dpapi blob'))
	const before = fs.readFileSync(sealed)
	const store = storeIn(dir, {
		encryption: 'dpapi',
		cipher: {
			available: false,
			reason: 'probe failed',
			ready: async () => false,
			protect: async () => { throw new Error('unavailable') },
			unprotect: async () => { throw new Error('unavailable') },
		},
	})
	await store.ready
	assert.equal(store.locked, true)
	assert.equal(store.writable, false)
	assert.equal(store.all().length, 0)
	assert.ok(store.warnings.some((warning) => warning.code === 'locked'))
	await assert.rejects(() => store.set({ key: 'A', value: 'x', scope: GLOBAL_SCOPE }), /只读/)
	assert.deepEqual(fs.readFileSync(sealed), before, 'the unreadable blob is left untouched')
})

test('a sealed document is opened through the cipher and re-sealed on write', async () => {
	const dir = tempDir()
	/** A trivial reversible "cipher" standing in for DPAPI. */
	const cipher = {
		available: true,
		ready: async () => true,
		protect: async (text) => Buffer.from(`sealed:${text}`, 'utf8'),
		unprotect: async (buffer) => buffer.toString('utf8').replace(/^sealed:/u, ''),
	}
	const first = storeIn(dir, { encryption: 'dpapi', cipher })
	await first.set({ key: 'A', value: 'x', scope: GLOBAL_SCOPE })
	assert.equal(first.sealed, true)
	const raw = fs.readFileSync(path.join(dir, 'secrets.dpapi'), 'utf8')
	assert.ok(raw.startsWith('sealed:{'), 'the document on disk is wrapped by the cipher')
	assert.ok(!fs.existsSync(path.join(dir, 'secrets.json')), 'nothing is written in the clear')

	const second = storeIn(dir, { encryption: 'dpapi', cipher })
	await second.ready
	assert.equal(second.locked, false)
	assert.deepEqual(second.all().map((entry) => entry.key), ['A'])
})

test('an existing plaintext document is not silently rewritten as sealed', async () => {
	const dir = tempDir()
	fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ version: 1, entries: [{ scope: 'global', key: 'A', value: 'x' }] }))
	const store = storeIn(dir, {
		encryption: 'dpapi',
		cipher: { available: true, ready: async () => true, protect: async (text) => Buffer.from(text), unprotect: async (buffer) => buffer.toString('utf8') },
	})
	await store.ready
	assert.equal(store.sealed, false)
	assert.deepEqual(store.all().map((entry) => entry.key), ['A'])
	assert.ok(store.warnings.some((warning) => warning.code === 'plaintextExisting'), 'the readable file is reported, not quietly replaced')
})

test('a write keeps a backup of the previous document and leaves no temp file', async () => {
	const dir = tempDir()
	const store = storeIn(dir)
	await store.set({ key: 'A', value: 'one', scope: GLOBAL_SCOPE })
	await store.set({ key: 'A', value: 'two', scope: GLOBAL_SCOPE })
	assert.ok(fs.existsSync(path.join(dir, 'secrets.json.bak')), 'the previous generation is kept')
	assert.ok(!fs.existsSync(path.join(dir, 'secrets.json.tmp')), 'the atomic write renamed its temp file away')
	assert.ok(!fs.existsSync(path.join(dir, '.lock')), 'the lock is released')
})

test('a stale lock is stolen and a fresh one makes the writer wait', async () => {
	const dir = tempDir()
	const lock = path.join(dir, '.lock')
	fs.writeFileSync(lock, 'someone else')
	const old = new Date(Date.now() - 60_000)
	fs.utimesSync(lock, old, old)
	const store = storeIn(dir)
	await store.set({ key: 'A', value: 'x', scope: GLOBAL_SCOPE })
	assert.equal(store.all().length, 1, 'a stale lock does not block a write forever')
})

test('the entry ceiling is enforced', async () => {
	const store = storeIn(tempDir(), { maxEntries: 2 })
	await store.set({ key: 'A', value: 'x', scope: GLOBAL_SCOPE })
	await store.set({ key: 'B', value: 'x', scope: GLOBAL_SCOPE })
	await assert.rejects(() => store.set({ key: 'C', value: 'x', scope: GLOBAL_SCOPE }), /上限/)
})

test('change listeners fire once per committed write', async () => {
	const store = storeIn(tempDir())
	let count = 0
	const off = store.onChange(() => { count += 1 })
	await store.set({ key: 'A', value: 'x', scope: GLOBAL_SCOPE })
	await store.set({ key: 'A', value: 'y', scope: GLOBAL_SCOPE })
	off()
	await store.set({ key: 'A', value: 'z', scope: GLOBAL_SCOPE })
	assert.equal(count, 2)
	assert.equal(store.generation, 3)
})
