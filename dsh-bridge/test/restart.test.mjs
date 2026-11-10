/**
 * Tests for the post-install restart hook and the relay it arms.
 *
 * The relay is a separate process by design, so this file tests it twice: the
 * decision logic in isolation (pure), and one real relay run in dry-run mode,
 * which exercises the heartbeat, the wait loop and the log without starting an
 * application.
 *
 * `DSH_HOME` is redirected to a temporary directory before anything else: the
 * bridge writes plans and a ledger under it, and a test must never touch the
 * operator's real profile.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-bridge-restart-'))

const { readOptions } = await import('../src/policy.js')
const {
	createRestarter,
	describeHost,
	planFor,
	readLedger,
	writeLedger,
	bridgeHome,
} = await import('../src/relaunch.js')

const RELAY = fileURLToPath(new URL('../src/relay.js', import.meta.url))

/** Resolve after a short delay, so a scheduled shutdown has run. */
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Point `DSH_HOME` at a fresh directory.
 *
 * Plans and the restart ledger live under it, and most assertions here count
 * ledger rows, so each test that touches them needs its own home.
 * @returns the new home.
 */
function isolate() {
	process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-bridge-case-'))
	return process.env.DSH_HOME
}

/**
 * Options with restart fields resolved from a partial config.
 * @param config - bridge config overrides.
 * @returns resolved options.
 */
function options(config = {}) {
	return readOptions(config)
}

/**
 * A host context that records what the restarter asks of it.
 * @returns the fake context and the recorded services.
 */
function fakeCtx() {
	const calls = { exit: [], provided: new Map() }
	const ctx = {
		get(serviceName) {
			if (serviceName === 'appExit') {
				return code => {
					calls.exit.push(code)
				}
			}
			return undefined
		},
		provide(serviceName, value) {
			calls.provided.set(serviceName, value)
		},
		logger: { info() {} },
	}
	return { ctx, calls }
}

test('the host is described as a process, or as the Desktop app whose parent owns the window', () => {
	const plain = describeHost({})
	assert.equal(plain.kind, 'process')
	assert.equal(plain.exe, process.execPath)
	assert.deepEqual(plain.args, process.argv.slice(1))
	assert.equal(plain.waitedPid, process.pid)
	assert.equal(plain.graceful, true)
	assert.deepEqual(plain.scrub, ['ELECTRON_RUN_AS_NODE'])

	const originalSend = process.send
	process.send = () => true
	try {
		const desktop = describeHost({ ELECTRON_RUN_AS_NODE: '1' })
		assert.equal(desktop.kind, 'desktop-app')
		assert.deepEqual(desktop.args, [], 'the Desktop app is started with no arguments')
		assert.equal(desktop.waitedPid, process.ppid, 'the relay must wait for the process that owns the window')
		assert.equal(desktop.graceful, false)
		assert.deepEqual(desktop.scrub, ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'])
	} finally {
		if (originalSend === undefined) delete process.send
		else process.send = originalSend
	}
})

test('the plan carries what the relay needs and nothing secret', () => {
	const opts = options({ restartDryRun: true })
	const plan = planFor({ host: describeHost({}), options: opts, trigger: 'test' })
	assert.equal(plan.trigger, 'test')
	assert.equal(plan.dryRun, true)
	assert.equal(plan.waitedPid, process.pid)
	assert.equal(plan.log, join(bridgeHome(), 'relay.log'))
	assert.ok(!('env' in plan), 'the child inherits its environment; secrets never land in a plan file')
	assert.ok(plan.settleMs >= 0)
})

test('the ledger allows the budget, then refuses, then re-opens after the window', () => {
	isolate()
	const opts = options({ restartBudget: 2, restartWindowMs: 1000 })
	const now = Date.now()
	let ledger = readLedger(opts, now)
	assert.equal(ledger.left, 2)

	writeLedger(ledger, { phase: 'armed', trigger: 'a' }, opts, now)
	ledger = readLedger(opts, now + 10)
	assert.equal(ledger.used, 1)
	assert.equal(ledger.left, 1)

	writeLedger(ledger, { phase: 'armed', trigger: 'b' }, opts, now + 20)
	ledger = readLedger(opts, now + 30)
	assert.equal(ledger.left, 0)

	const later = readLedger(opts, now + 5000)
	assert.equal(later.used, 0, 'a new window starts from zero')
	assert.equal(later.left, 2)
})

test('a dry run writes a plan and reports it without starting or killing anything', async () => {
	isolate()
	const { ctx, calls } = fakeCtx()
	const restarter = createRestarter({
		ctx,
		options: options({ restartDryRun: true, restartDelayMs: 1 }),
		spawnImpl() {
			throw new Error('a dry run must not spawn the relay')
		},
	})

	const receipt = await restarter.begin({ trigger: 'test-dry' })
	await tick()
	assert.equal(receipt.dryRun, true)
	assert.equal(receipt.accepted, true)
	assert.equal(receipt.deferred, false)
	assert.equal(receipt.trigger, 'test-dry')
	assert.match(receipt.plan, /\.plan\.json$/)
	assert.deepEqual(calls.exit, [], 'a dry run never takes the host down')

	const state = restarter.state()
	assert.equal(state.host.kind, 'process')
	assert.equal(state.budget.used, 0, 'a dry run is not counted against the budget')
	assert.equal(state.recent.at(-1).phase, 'dry-run')
})

test('the receipt reaches the caller before the host goes down', async () => {
	isolate()
	const { ctx, calls } = fakeCtx()
	const opts = options({ restartDelayMs: 5, relayHeartbeatMs: 2000 })
	let heartbeatPath

	const restarter = createRestarter({
		ctx,
		options: opts,
		spawnImpl(exe, argv) {
			assert.equal(exe, process.execPath)
			heartbeatPath = `${argv[1]}.hb.json`
			// Stand in for the relay: prove liveness the way the real one does.
			writeFileSync(heartbeatPath, JSON.stringify({ phase: 'started', pid: 4242 }), 'utf8')
			return { pid: 4242, unref() {} }
		},
	})

	const receipt = await restarter.begin({ trigger: 'unit' })
	assert.equal(receipt.accepted, true)
	assert.equal(receipt.deferred, true)
	assert.equal(receipt.relayPid, 4242)
	assert.equal(receipt.relayPhase, 'started')
	assert.deepEqual(calls.exit, [], 'the caller gets its answer first')

	await tick(30)
	assert.deepEqual(calls.exit, [0], 'then the host exits gracefully')
	assert.ok(heartbeatPath !== undefined)
})

test('a silent relay cancels the restart and leaves the host running', async () => {
	isolate()
	const { ctx, calls } = fakeCtx()
	const restarter = createRestarter({
		ctx,
		options: options({ relayHeartbeatMs: 120, restartDelayMs: 1 }),
		spawnImpl() {
			return { pid: 7, unref() {}, kill() {} }
		},
	})

	await assert.rejects(() => restarter.begin({ trigger: 'silent' }), error => error.code === 'relay-unavailable')
	await tick(30)
	assert.deepEqual(calls.exit, [], 'the worst case is "nothing happened", never "the app disappeared"')
	assert.equal(restarter.state().budget.used, 0, 'a relay that never started costs no budget')
})

test('the budget stops a restart loop across activations', async () => {
	isolate()
	const { ctx } = fakeCtx()
	const restarter = createRestarter({
		ctx,
		options: options({ restartBudget: 1, restartWindowMs: 60_000, restartDelayMs: 5 }),
		spawnImpl(_exe, argv) {
			writeFileSync(`${argv[1]}.hb.json`, JSON.stringify({ phase: 'started', pid: 99 }), 'utf8')
			return { pid: 99, unref() {} }
		},
	})
	await restarter.begin({ trigger: 'first' })
	await assert.rejects(() => restarter.begin({ trigger: 'second' }), error => error.code === 'restart-budget')
})

test('the relay reports its phases and, in dry-run, starts nothing', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-relay-'))
	const planPath = join(dir, 'plan.json')
	writeFileSync(
		planPath,
		JSON.stringify({
			version: 1,
			kind: 'process',
			exe: process.execPath,
			args: [],
			cwd: dir,
			waitedPid: process.pid,
			scrub: [],
			deadlineMs: 150,
			settleMs: 0,
			retry: 1,
			retryDelayMs: 10,
			dryRun: true,
			log: join(dir, 'relay.log'),
		}),
		'utf8',
	)

	const child = spawn(process.execPath, [RELAY, planPath], { stdio: 'ignore' })
	const exitCode = await new Promise(resolve => child.once('exit', resolve))
	assert.equal(exitCode, 0)

	const beat = JSON.parse(readFileSync(`${planPath}.hb.json`, 'utf8'))
	assert.equal(beat.phase, 'relaunched')
	assert.equal(beat.dryRun, true)

	const log = readFileSync(join(dir, 'relay.log'), 'utf8')
	assert.match(log, /\[relay:started\]/)
	assert.match(log, /\[relay:parent-still-running\]/, 'a pid that outlives the deadline is reported, then the launch proceeds')
	assert.match(log, /\[relay:relaunched\]/)
})

test('the resolved defaults keep the capability available and the budget finite', () => {
	const opts = options()
	assert.ok(opts.confirm.includes('app.restart'), 'the caller must confirm a restart explicitly')
	assert.ok(opts.restartBudget > 0 && opts.restartBudget <= 5)
	assert.ok(opts.restartWindowMs >= 60_000)
	assert.equal('restartOnInstall' in opts, false, 'the bridge no longer decides when to restart')
	assert.equal('restartOnInstallReasons' in opts, false)
})
