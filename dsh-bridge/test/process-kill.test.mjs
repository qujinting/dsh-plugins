/**
 * Tests for the one function that actually ends a process.
 *
 * `taskkill` failing silently is the failure mode that produced a spinner with
 * no window close, so the contract here is narrow and explicit: report whether
 * the kill happened, and prove it on a real child process rather than a mock.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

import { decodeConsole, decodeConsoleOutput, forceKill, isAlive } from '../src/process-kill.js'

test('a localized console message is decoded as GBK instead of turning into noise', () => {
	// "成功" in GBK — exactly what taskkill writes on a zh-CN Windows.
	const gbk = Buffer.from([0xb3, 0xc9, 0xb9, 0xa6])
	assert.equal(decodeConsole(gbk), '成功')

	// Valid UTF-8 must win outright: a GBK decoder would also "succeed" here.
	assert.equal(decodeConsole(Buffer.from('done', 'utf8')), 'done')
	assert.equal(decodeConsole(Buffer.from([0xe6, 0x88, 0x90, 0xe5, 0x8a, 0x9f])), '成功')

	assert.equal(decodeConsole(null), '')
	assert.equal(decodeConsole(undefined), '')
	assert.equal(decodeConsole(Buffer.alloc(0)), '')
	assert.equal(decodeConsoleOutput(Buffer.from('a', 'utf8'), null, Buffer.from('b', 'utf8')), 'a b')
})

test('an invalid pid is refused instead of being passed to taskkill', () => {
	for (const pid of [0, -1, 1.5, Number.NaN, undefined, null]) {
		const result = forceKill(pid)
		assert.equal(result.ok, false, `pid ${String(pid)} must be refused`)
		assert.equal(result.reason, 'invalid-pid')
	}
})

test('forceKill ends a real child process and reports success', async () => {
	const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
	try {
		await new Promise(resolve => victim.once('spawn', resolve))
		assert.equal(isAlive(victim.pid), true)

		const result = forceKill(victim.pid)
		assert.equal(result.ok, true, `forceKill said: ${result.message ?? result.reason}`)

		const deadline = Date.now() + 3000
		while (Date.now() < deadline && isAlive(victim.pid)) await new Promise(resolve => setTimeout(resolve, 50))
		assert.equal(isAlive(victim.pid), false, 'the victim must be gone')
	} finally {
		if (isAlive(victim.pid)) victim.kill()
	}
})
