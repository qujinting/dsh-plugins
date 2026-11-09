/**
 * Unit tests for the policy layer: config projection, error shaping, timeouts,
 * and the breaker's state machine.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Breaker, DEFAULTS, coded, describeError, readOptions, withTimeout } from '../src/policy.js'

test('an absent config resolves to the documented defaults', () => {
	assert.deepEqual(readOptions(undefined), DEFAULTS)
	assert.deepEqual(readOptions(null), DEFAULTS)
	assert.deepEqual(readOptions({}), DEFAULTS)
})

test('unusable config values fall back instead of throwing during activation', () => {
	const options = readOptions({
		timeoutMs: -5,
		auditLimit: 'many',
		confirm: 'plugin.restart',
		serviceDeny: ['ok', 42],
		breakerThreshold: 0,
		breakerCooldownMs: 1.5,
	})
	assert.equal(options.timeoutMs, DEFAULTS.timeoutMs)
	assert.equal(options.auditLimit, DEFAULTS.auditLimit)
	assert.deepEqual(options.confirm, DEFAULTS.confirm)
	assert.deepEqual(options.serviceDeny, DEFAULTS.serviceDeny)
	assert.equal(options.breakerThreshold, DEFAULTS.breakerThreshold)
	assert.equal(options.breakerCooldownMs, DEFAULTS.breakerCooldownMs)
})

test('a partial config keeps the fields it sets', () => {
	const options = readOptions({ auditLimit: 10, confirm: [] })
	assert.equal(options.auditLimit, 10)
	assert.deepEqual(options.confirm, [], 'an explicit empty list must survive: it disables the gate')
	assert.equal(options.timeoutMs, DEFAULTS.timeoutMs)
})

test('defaults are copied, so mutating one instance cannot change the next', () => {
	const first = readOptions({})
	first.confirm.push('service.call')
	const second = readOptions({})
	assert.equal(second.confirm.includes('service.call'), false)
})

test('coded errors carry their code through describeError', () => {
	const described = describeError(coded('breaker-open', 'shut'))
	assert.deepEqual(described, { code: 'breaker-open', message: 'shut' })
})

test('describeError survives non-Error throws', () => {
	assert.deepEqual(describeError('plain string'), { code: 'failed', message: 'plain string' })
	assert.deepEqual(describeError(undefined), { code: 'failed', message: 'undefined' })
})

test('withTimeout passes a fast result through', async () => {
	assert.equal(await withTimeout(Promise.resolve(7), 50, 'fast'), 7)
})

test('withTimeout rejects a slow result with the timeout code', async () => {
	await assert.rejects(() => withTimeout(new Promise(() => {}), 10, 'slow'), error => {
		assert.equal(error.code, 'timeout')
		return true
	})
})

test('withTimeout forwards the original rejection', async () => {
	await assert.rejects(() => withTimeout(Promise.reject(coded('boom', 'x')), 50, 'fails'), error => {
		assert.equal(error.code, 'boom')
		return true
	})
})

test('a non-positive timeout disables the bound rather than rejecting', async () => {
	assert.equal(await withTimeout(Promise.resolve(1), 0, 'unbounded'), 1)
})

test('the breaker stays closed below its threshold', () => {
	const breaker = new Breaker({ threshold: 3, cooldownMs: 1000 })
	breaker.noteFailure('cap')
	breaker.noteFailure('cap')
	assert.doesNotThrow(() => breaker.assertClosed('cap'))
})

test('the breaker opens at its threshold and names the capability', () => {
	const breaker = new Breaker({ threshold: 2, cooldownMs: 1000 })
	breaker.noteFailure('cap')
	breaker.noteFailure('cap')
	assert.throws(() => breaker.assertClosed('cap'), error => {
		assert.equal(error.code, 'breaker-open')
		assert.match(error.message, /cap/)
		return true
	})
})

test('the breaker reopens after the cooldown and closes on success', async () => {
	const breaker = new Breaker({ threshold: 1, cooldownMs: 20 })
	breaker.noteFailure('cap')
	assert.throws(() => breaker.assertClosed('cap'))

	await new Promise(resolve => setTimeout(resolve, 30))
	assert.doesNotThrow(() => breaker.assertClosed('cap'), 'the cooldown grants one probe')

	breaker.noteFailure('cap')
	breaker.noteSuccess('cap')
	assert.doesNotThrow(() => breaker.assertClosed('cap'))
})

test('breakers are independent per capability', () => {
	const breaker = new Breaker({ threshold: 1, cooldownMs: 1000 })
	breaker.noteFailure('a')
	assert.throws(() => breaker.assertClosed('a'))
	assert.doesNotThrow(() => breaker.assertClosed('b'))
})
