// Deterministic test of the host's activity mirror: drive the real DSH event
// names through the plugin's listeners and read the phase back off the catalog
// route, so the phase logic is proven without needing a live agent turn.
import http from 'node:http'
import { apply } from '../lib/index.js'

const failures = []
const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) failures.push(label)
}

const listeners = new Map()
const registrations = []
const ctx = {
	logger: { info: () => {}, warn: () => {} },
	effect: (fn) => fn(),
	on: (event, handler) => {
		if (!listeners.has(event)) listeners.set(event, [])
		listeners.get(event).push(handler)
	},
	webServer: {
		register: (route) => {
			registrations.push(route)
			return () => {}
		},
	},
}

apply(ctx, {})
const route = registrations[0]
const server = http.createServer((req, res) => {
	Promise.resolve(route.handler(req, res)).catch((error) => res.writeHead(500).end(String(error)))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/api/dsh-pet`

const phase = async () => JSON.parse(await (await fetch(`${base}/catalog`)).text()).phase.phase
const fire = (event, ...args) => {
	const handlers = listeners.get(event)
	if (handlers === undefined || handlers.length === 0) throw new Error(`no listener registered for ${event}`)
	return handlers.map((handler) => handler(...args))
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

check('mirrors agent/status', listeners.has('agent/status'))
check('mirrors tools/result', listeners.has('tools/result'))
check('mirrors agent/error', listeners.has('agent/error'))
check('mirrors approval/request', listeners.has('approval/request'))
check('mirrors user-questions/request', listeners.has('user-questions/request'))
check('starts idle', (await phase()) === 'idle')

fire('agent/status', { status: 'running' })
check('running -> thinking', (await phase()) === 'thinking', await phase())

fire('tools/result', { name: 'read' })
check('tool result -> tool', (await phase()) === 'tool', await phase())

// A tool ping is transient: it settles back to the phase the turn is really in.
await sleep(1_700)
check('tool ping settles back to thinking', (await phase()) === 'thinking', await phase())

fire('agent/status', { status: 'idle' })
check('turn end -> done', (await phase()) === 'done', await phase())

// The celebration is held, then falls back on its own.
await sleep(3_800)
check('done celebration falls back to idle', (await phase()) === 'idle', await phase())

fire('agent/error', { error: new Error('boom') })
check('error -> failed', (await phase()) === 'failed', await phase())
await sleep(5_300)
check('failure falls back to idle', (await phase()) === 'idle', await phase())

// Waterfall observers must resume the chain no matter what the pet does.
let resumed = 0
const next = () => {
	resumed += 1
	return Promise.resolve({ kind: 'approve' })
}
fire('approval/request', { request: {} }, next)
check('approval observer resumes the waterfall', resumed === 1, String(resumed))
check('approval -> waiting', (await phase()) === 'waiting', await phase())

fire('user-questions/request', { request: {} }, next)
check('question observer resumes the waterfall', resumed === 2, String(resumed))

// A throwing observer must still resume: the pet can never stall a session.
const poison = listeners.get('approval/request')[0]
listeners.set('approval/request', [(...args) => {
	// simulate an internal failure inside the observation
	try {
		throw new Error('observer exploded')
	} finally {
		return poison(...args)
	}
}])
let survived = 0
const next2 = () => {
	survived += 1
	return Promise.resolve({ kind: 'approve' })
}
try {
	listeners.get('approval/request')[0]({ request: {} }, next2)
} catch {
	/* the plugin's own guard must have swallowed it */
}
check('a broken observer still resumes the waterfall', survived === 1, String(survived))

server.close()
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURE(S): ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
