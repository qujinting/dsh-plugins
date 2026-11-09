/**
 * The DPAPI bridge.
 *
 * The round trip is the only claim worth testing here, and it needs a real
 * Windows account — so the suite probes once and skips the value tests when the
 * facility is missing, reporting why through the skip message rather than
 * passing silently.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { DpapiCipher, MAX_SECRET_BYTES } from '../src/crypto.js'

const cipher = new DpapiCipher({ timeoutMs: 30_000 })
const available = await cipher.ready()

test('the probe is decisive: usable, or unusable with a reason', () => {
	if (available) {
		assert.equal(cipher.available, true)
		assert.equal(cipher.reason, undefined)
	} else {
		assert.equal(cipher.available, false)
		assert.equal(typeof cipher.reason, 'string')
		assert.ok(cipher.reason.length > 0)
	}
})

test('a sealed value round-trips through DPAPI', { skip: available ? false : `DPAPI 不可用：${cipher.reason}` }, async () => {
	const secret = 'sk-test-0123456789-中文-🔐'
	const sealed = await cipher.protect(secret)
	assert.ok(sealed.byteLength > 0)
	assert.ok(!sealed.toString('utf8').includes('sk-test'), 'the ciphertext does not carry the plaintext')
	assert.equal(await cipher.unprotect(sealed), secret)
})

test('two seals of the same plaintext differ', { skip: available ? false : `DPAPI 不可用：${cipher.reason}` }, async () => {
	// DPAPI mixes in a random session key, so a repeated seal is never a
	// deterministic function of the input — worth pinning, because a store that
	// rewrote an identical blob would not change `mtime` and would hide changes.
	const first = await cipher.protect('same')
	const second = await cipher.protect('same')
	assert.notDeepEqual(first, second)
})

test('opening garbage fails loudly', { skip: available ? false : `DPAPI 不可用：${cipher.reason}` }, async () => {
	await assert.rejects(() => cipher.unprotect(Buffer.from('definitely not a dpapi blob')))
})

test('the payload ceiling is enforced before a child is spawned', async () => {
	const oversized = 'x'.repeat(MAX_SECRET_BYTES + 1)
	await assert.rejects(() => cipher.protect(oversized), /at most|超过|refusing/u)
})
