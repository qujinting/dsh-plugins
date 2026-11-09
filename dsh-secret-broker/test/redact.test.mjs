/**
 * Result redaction: the guarantee that a value echoed by a command still does
 * not reach the transcript.
 *
 * The interesting cases are the ones that decide whether this is a real net or
 * a nuisance: a value that contains another value, a decision that replaced the
 * whole value rather than the content, a session that must not see another
 * session's value, and the no-secrets path that must cost nothing.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { installRedaction, redactContent, redactText } from '../src/redact.js'
import { GLOBAL_SCOPE, SecretStore, sessionScope } from '../src/store.js'
import { createFakeContext, runWaterfall } from './helpers.mjs'

/** A loaded plaintext store with a few keys already in it. */
async function seededStore() {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-redact-'))
	const store = new SecretStore({ dataDir, encryption: 'none', keyPrefix: 'DSH_SECRET_', maxEntries: 200, logger: { warn() {} } })
	await store.set({ key: 'TOKEN', value: 'super-secret-value', scope: GLOBAL_SCOPE })
	await store.set({ key: 'OWN', value: 'session-only-value', scope: sessionScope('session-a') })
	return store
}

/** The options `installRedaction` reads. */
const OPTIONS = { redactResults: true, redactMinLength: 8 }

/** A text-block result as the waterfall sees it. */
function textResult(text) {
	return { content: [{ type: 'text', text }] }
}

/** A minimal tool execution. */
function execution(sessionId, name = 'pwsh') {
	return { name, arguments: { command: 'x' }, agent: { session: { header: { id: sessionId } } } }
}

test('redactText replaces every occurrence and reports whether it changed anything', () => {
	const pairs = [['super-secret-value', 'TOKEN']]
	assert.equal(redactText('nothing here', pairs), undefined)
	assert.equal(redactText('a super-secret-value b super-secret-value', pairs), 'a «redacted:TOKEN» b «redacted:TOKEN»')
})

test('a value containing another value is replaced as a whole', () => {
	// Longest first is what makes this deterministic: the store hands the pairs
	// over pre-sorted, and the shorter value must not chop up the longer one.
	const pairs = [['abcdefghijkl', 'LONG'], ['abcdefgh', 'SHORT']]
	assert.equal(redactText('x abcdefghijkl y', pairs), 'x «redacted:LONG» y')
})

test('only text blocks are touched, and untouched arrays are not copied', () => {
	const pairs = [['super-secret-value', 'TOKEN']]
	const content = [{ type: 'text', text: 'keep' }, { type: 'image', data: 'super-secret-value' }]
	assert.equal(redactContent(content, pairs), undefined)
	const mixed = [{ type: 'text', text: 'leak super-secret-value' }, { type: 'image', data: 'png' }]
	const redacted = redactContent(mixed, pairs)
	assert.equal(redacted[0].text, 'leak «redacted:TOKEN»')
	assert.equal(redacted[1], mixed[1], 'non-text blocks pass through by reference')
	assert.deepEqual(redactContent([], pairs), undefined)
	assert.deepEqual(redactContent(mixed, []), undefined)
})

test('the post-execute listener rewrites the accepted content', async () => {
	const store = await seededStore()
	const ctx = createFakeContext()
	installRedaction(ctx, store, OPTIONS)
	const decision = await runWaterfall(
		ctx,
		'tools/post-execute',
		[execution('session-a'), textResult('value is super-secret-value!')],
		() => ({ kind: 'accept' }),
	)
	assert.deepEqual(decision, { kind: 'accept', content: [{ type: 'text', text: 'value is «redacted:TOKEN»!' }] })
})

test('the listener falls back to the result content when the decision carries none', async () => {
	const store = await seededStore()
	const ctx = createFakeContext()
	installRedaction(ctx, store, OPTIONS)
	const decision = await runWaterfall(
		ctx,
		'tools/post-execute',
		[execution('session-a'), textResult('super-secret-value')],
		() => ({ kind: 'accept' }),
	)
	assert.deepEqual(decision.content, [{ type: 'text', text: '«redacted:TOKEN»' }])
})

test('an untouched result is passed through unchanged', async () => {
	const store = await seededStore()
	const ctx = createFakeContext()
	installRedaction(ctx, store, OPTIONS)
	const original = { kind: 'accept' }
	const decision = await runWaterfall(ctx, 'tools/post-execute', [execution('session-a'), textResult('clean')], () => original)
	assert.equal(decision, original, 'the same decision object is returned')
})

test('a value replacement and a block decision are left alone', async () => {
	const store = await seededStore()
	const ctx = createFakeContext()
	installRedaction(ctx, store, OPTIONS)
	const byValue = { kind: 'accept', value: { note: 'super-secret-value' } }
	assert.equal(await runWaterfall(ctx, 'tools/post-execute', [execution('session-a'), textResult('x')], () => byValue), byValue)
	const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'super-secret-value' }] }
	assert.equal(await runWaterfall(ctx, 'tools/post-execute', [execution('session-a'), textResult('x')], () => blocked), blocked)
})

test('another session\'s value is not redacted for this one, and vice versa', async () => {
	const store = await seededStore()
	const ctx = createFakeContext()
	installRedaction(ctx, store, OPTIONS)
	const leaked = await runWaterfall(
		ctx,
		'tools/post-execute',
		[execution('session-b'), textResult('session-only-value')],
		() => ({ kind: 'accept' }),
	)
	assert.equal(leaked.content, undefined, 'session-b cannot use session-a\'s key, so it is not redacted for it')
	const own = await runWaterfall(
		ctx,
		'tools/post-execute',
		[execution('session-a'), textResult('session-only-value')],
		() => ({ kind: 'accept' }),
	)
	assert.equal(own.content[0].text, '«redacted:OWN»')
})

test('short values are not scanned, and the switch turns the net off', async () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-redact-'))
	const store = new SecretStore({ dataDir, encryption: 'none', keyPrefix: 'DSH_SECRET_', maxEntries: 200, logger: { warn() {} } })
	await store.set({ key: 'PIN', value: '1234', scope: GLOBAL_SCOPE })
	const ctx = createFakeContext()
	installRedaction(ctx, store, OPTIONS)
	const untouched = await runWaterfall(ctx, 'tools/post-execute', [execution('s'), textResult('pin 1234')], () => ({ kind: 'accept' }))
	assert.equal(untouched.content, undefined)

	const off = createFakeContext()
	installRedaction(off, store, { ...OPTIONS, redactResults: false })
	await store.set({ key: 'LONG', value: 'long-enough-value', scope: GLOBAL_SCOPE })
	const decision = await runWaterfall(off, 'tools/post-execute', [execution('s'), textResult('long-enough-value')], () => ({ kind: 'accept' }))
	assert.equal(decision.content, undefined)
})

test('the ptc dispatch log is redacted too', async () => {
	const store = await seededStore()
	const ctx = createFakeContext()
	installRedaction(ctx, store, OPTIONS)
	const content = await runWaterfall(
		ctx,
		'tools/ptc-dispatch-log',
		[{ exec: execution('session-a'), name: 'pwsh', subCallId: 'c1' }],
		() => [{ type: 'text', text: 'logged super-secret-value' }],
	)
	assert.deepEqual(content, [{ type: 'text', text: 'logged «redacted:TOKEN»' }])
})

test('the returned disposer removes both listeners', async () => {
	const store = await seededStore()
	const ctx = createFakeContext()
	const dispose = installRedaction(ctx, store, OPTIONS)
	assert.equal(ctx.records.listeners.get('tools/post-execute').length, 1)
	assert.equal(ctx.records.listeners.get('tools/ptc-dispatch-log').length, 1)
	dispose()
	assert.equal(ctx.records.listeners.get('tools/post-execute').length, 0)
	assert.equal(ctx.records.listeners.get('tools/ptc-dispatch-log').length, 0)
})
