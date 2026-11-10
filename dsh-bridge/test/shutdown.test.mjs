import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { readOptions } from '../src/policy.js'
import { createRestarter } from '../src/relaunch.js'

function isolateHome() {
	const previous = process.env.DSH_HOME
	const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-shutdown-'))
	process.env.DSH_HOME = dir
	return () => {
		if (previous === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = previous
		rmSync(dir, { recursive: true, force: true })
	}
}

const desktopHost = {
	kind: 'desktop-app',
	exe: 'D:/apps/DSH/DeepSeek Harness.exe',
	args: [],
	cwd: 'D:/apps/DSH',
	waitedPid: 4242,
	graceful: false,
	scrub: ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'],
}

const processHost = {
	kind: 'process',
	exe: process.execPath,
	args: ['server.js'],
	cwd: process.cwd(),
	waitedPid: 99,
	graceful: true,
	scrub: ['ELECTRON_RUN_AS_NODE'],
}

function harness(host, options = {}, seams = {}) {
	const appExitCalls = []
	const hostExitCalls = []
	const terminated = []
	const lines = []
	const restarter = createRestarter({
		ctx: {
			get: name => (name === 'appExit' ? code => appExitCalls.push(code) : undefined),
			logger: { info() {}, warn() {}, error() {} },
		},
		options: readOptions({ restartDelayMs: 1, relayHeartbeatMs: 2000, ...options }),
		describeHostImpl: () => host,
		spawnImpl(exe, argv) {
			writeFileSync(`${argv[1]}.hb.json`, JSON.stringify({ phase: 'started', pid: 4242 }), 'utf8')
			return { pid: 4242, unref() {} }
		},
		terminateImpl:
			seams.terminateImpl ??
			(pid => {
				terminated.push(pid)
				return { ok: true }
			}),
		aliveImpl: seams.aliveImpl ?? (() => false),
		terminateWaitMs: seams.terminateWaitMs ?? 250,
		exitImpl: code => hostExitCalls.push(code),
		log: line => lines.push(line),
	})
	return { restarter, appExitCalls, hostExitCalls, terminated, lines }
}

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))

test('the desktop host terminates the window owner, waits for it to go, then exits', async () => {
	const restore = isolateHome()
	try {
		const { restarter, appExitCalls, hostExitCalls, terminated } = harness(desktopHost)

		const receipt = await restarter.begin({ trigger: 'test' })
		assert.equal(receipt.accepted, true)
		assert.deepEqual(terminated, [], 'the caller is answered before anything dies')

		await tick(400)
		assert.deepEqual(terminated, [desktopHost.waitedPid], 'the window owner is what has to go')
		assert.deepEqual(appExitCalls, [], 'appExit would only stop the child and leave the window spinning')
		assert.deepEqual(hostExitCalls, [0], 'the host leaves once the owner is gone')
	} finally {
		restore()
	}
})

test('a window owner that survives is logged, and the host leaves anyway', async () => {
	const restore = isolateHome()
	try {
		const { restarter, hostExitCalls, lines } = harness(
			desktopHost,
			{},
			{ terminateImpl: () => ({ ok: false, message: 'Access is denied.' }), aliveImpl: () => true, terminateWaitMs: 150 },
		)

		await restarter.begin({ trigger: 'test' })
		await tick(500)

		assert.deepEqual(hostExitCalls, [0], 'the relay retries the kill; the host must not hang here')
		assert.ok(lines.some(line => line.includes('ok=false')), 'the failed kill is in the log')
		assert.ok(lines.some(line => line.includes('still alive')), 'and so is the timeout')
	} finally {
		restore()
	}
})

test('state() reports the path a restart would actually take', () => {
	const restore = isolateHome()
	try {
		const desktop = harness(desktopHost).restarter.state()
		assert.equal(desktop.host.shutdown, 'terminate-parent', 'an available appExit does not change this')

		const disabled = harness(desktopHost, { desktopTerminate: false }).restarter.state()
		assert.equal(disabled.host.shutdown, 'unavailable')

		const web = harness(processHost).restarter.state()
		assert.equal(web.host.shutdown, 'graceful')
	} finally {
		restore()
	}
})

test('desktopTerminate: false leaves the app running rather than half-killing it', async () => {
	const restore = isolateHome()
	try {
		const { restarter, appExitCalls, hostExitCalls, terminated } = harness(desktopHost, { desktopTerminate: false })

		await restarter.begin({ trigger: 'test' })
		await tick(400)

		assert.deepEqual(terminated, [])
		assert.deepEqual(hostExitCalls, [])
		assert.deepEqual(appExitCalls, [], 'stopping only the host is the failure mode this guards')
	} finally {
		restore()
	}
})

test('a non-desktop host still exits gracefully when appExit exists', async () => {
	const restore = isolateHome()
	try {
		const { restarter, appExitCalls, hostExitCalls, terminated } = harness(processHost)

		await restarter.begin({ trigger: 'test' })
		await tick()

		assert.deepEqual(appExitCalls, [0])
		assert.deepEqual(hostExitCalls, [], 'the host-provided exit is used, not process.exit')
		assert.deepEqual(terminated, [], 'there is no window owner to terminate here')
	} finally {
		restore()
	}
})
