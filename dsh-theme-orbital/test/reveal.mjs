// Reveal-hand-off checks for the boot controller.
//
// The shipped intro films end on ~1.5 s of nearly still frames, so waiting for
// `ended` means freezing on the last frame and only then fading — the "film
// stops, nothing happens, then the UI pops in" complaint. The controller now
// starts the cross-fade `introTailMs` before the film's end and skips the
// `holdMs` freeze on that path. This suite drives the real controller against a
// stubbed video element and a virtual clock, and asserts:
//   - nothing is revealed while the film is still before the cut point;
//   - the cross-fade starts at `duration - introTailMs` without any `ended`;
//   - it does so immediately (no holdMs pause) and the veil is then removed;
//   - `introTailMs: 0` keeps the old "wait for ended, then hold" contract;
//   - short films are never cut earlier than their halfway point.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) failures.push(label)
}

const bootSource = readFileSync(join(ROOT, 'theme/boot.js'), 'utf8')

function createStyle() {
	const values = new Map()
	return {
		setProperty(name, value, priority) {
			values.set(name, { value: String(value), priority: priority ?? '' })
		},
		removeProperty(name) {
			values.delete(name)
		},
		getPropertyValue(name) {
			return values.has(name) ? values.get(name).value : ''
		},
	}
}

function createElement(tag) {
	const attributes = new Map()
	const listeners = new Map()
	const element = {
		tagName: String(tag).toUpperCase(),
		style: createStyle(),
		parentNode: null,
		children: [],
		appendChild(child) {
			child.parentNode = element
			element.children.push(child)
			return child
		},
		removeChild(child) {
			child.parentNode = null
			element.children = element.children.filter((entry) => entry !== child)
			return child
		},
		remove() {
			if (element.parentNode !== null) element.parentNode.removeChild(element)
		},
		setAttribute(name, value) {
			attributes.set(name, String(value))
		},
		getAttribute(name) {
			return attributes.has(name) ? attributes.get(name) : null
		},
		removeAttribute(name) {
			attributes.delete(name)
		},
		addEventListener(type, handler, options) {
			listeners.set(type, { handler, once: options?.once === true })
		},
		dispatch(type) {
			const entry = listeners.get(type)
			if (entry === undefined) return
			if (entry.once) listeners.delete(type)
			entry.handler()
		},
		querySelector() {
			return null
		},
	}
	return element
}

function createVideo() {
	const video = createElement('video')
	video.duration = 7
	video.currentTime = 0
	video.readyState = 4
	video.ended = false
	video.play = () => Promise.resolve()
	video.pause = () => {}
	video.load = () => {}
	return video
}

/**
 * Run the controller with a virtual clock and a 7 s (by default) film stub.
 * @param {object} config boot config overrides.
 * @param {number} duration film length in seconds.
 */
function play(config, duration = 7) {
	const body = createElement('body')
	const root = createElement('html')
	const veil = createElement('div')
	const holder = {
		removeChild(node) {
			if (node.parentNode === holder) node.parentNode = null
		},
	}
	veil.parentNode = holder

	let clock = 0
	let nextTimerId = 1
	let timers = []
	let video = null
	const globalListeners = new Map()
	const storage = () => {
		const values = new Map()
		return {
			getItem: (key) => (values.has(key) ? values.get(key) : null),
			setItem: (key, value) => values.set(key, String(value)),
			removeItem: (key) => values.delete(key),
		}
	}

	const document = {
		body,
		documentElement: root,
		readyState: 'complete',
		getElementById(id) {
			return id === 'dsh-theme-veil' && veil.parentNode !== null ? veil : null
		},
		createElement(tag) {
			if (tag === 'video') {
				video = createVideo()
				video.duration = duration
				return video
			}
			return createElement(tag)
		},
		querySelector(selector) {
			if (selector === '[data-dsh-boot]') return null
			if (selector === '[data-shell-overlay]') return {}
			return null
		},
	}

	const sandbox = {
		console,
		document,
		getComputedStyle: () => ({ backgroundColor: 'rgb(4, 8, 15)' }),
		matchMedia: () => ({ matches: false }),
		localStorage: storage(),
		sessionStorage: storage(),
		performance: { now: () => 0 },
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		setTimeout: (callback, delay) => {
			const id = nextTimerId
			nextTimerId += 1
			timers.push({ id, due: clock + Number(delay ?? 0), callback })
			return id
		},
		clearTimeout: (id) => {
			timers = timers.filter((timer) => timer.id !== id)
		},
		addEventListener: (type, handler, options) => {
			globalListeners.set(type, { handler, once: options?.once === true })
		},
		removeEventListener: (type) => {
			globalListeners.delete(type)
		},
		__DSH_THEME_BOOT__: config,
	}
	vm.createContext(sandbox)
	vm.runInContext(bootSource, sandbox, { filename: 'theme/boot.js' })

	return {
		body,
		veil,
		root,
		get video() {
			return video
		},
		/** Advance the virtual clock, running every timer due inside the window. */
		advance(ms) {
			const target = clock + ms
			for (let guard = 0; guard < 2000; guard += 1) {
				let next = null
				for (const timer of timers) {
					if (timer.due <= target && (next === null || timer.due < next.due)) next = timer
				}
				if (next === null) break
				timers = timers.filter((timer) => timer !== next)
				clock = next.due
				next.callback()
			}
			clock = target
		},
		/** Pretend the browser started presenting frames. */
		startPlaying() {
			video.currentTime = 0.04
			video.dispatch('playing')
		},
		pendingTimers() {
			return timers.length
		},
	}
}

const base = {
	enabled: true,
	animation: 'hud',
	playOn: 'always',
	durationMs: 800,
	holdMs: 350,
	introTailMs: 1500,
	titleBar: 'off',
	introSrc: '/api/dsh-theme/video/intro',
	backgroundSrc: null,
	backgroundScope: 'always',
}

const revealed = (run) => run.veil.getAttribute('data-phase') === 'reveal'
const removed = (run) => run.veil.parentNode === null

// --- cross-fade before the still tail ---------------------------------------

{
	const run = play(base)
	check('the film is wired up', run.video !== null)
	run.startPlaying()
	check('playing marks the veil as film mode', run.veil.getAttribute('data-media') === 'video')

	run.video.currentTime = 3
	run.advance(1200)
	check('a film before its cut point is not revealed', revealed(run) === false && run.veil.getAttribute('data-phase') === null)
	check('the shell still shows the boot phase', run.root.getAttribute('data-dsh-theme-phase') === 'boot')

	run.video.currentTime = 5.6
	run.advance(200)
	check('the cross-fade starts at duration − introTailMs', revealed(run) === true)
	check('the cross-fade does not wait for holdMs', run.veil.getAttribute('data-phase') === 'reveal')
	check('the app reveal phase is raised with it', run.root.getAttribute('data-dsh-theme-phase') === 'reveal')

	run.advance(3000)
	check('the veil is removed after the fade', removed(run))
	check('the reveal phase is cleared after removal', run.root.getAttribute('data-dsh-theme-phase') === null)
	check('the ended event was never needed', run.video.ended === false)
}

// --- the early hand-off is a preference, not a hard cut ---------------------

{
	const run = play({ ...base, introTailMs: 0 })
	run.startPlaying()
	run.video.currentTime = 6.9
	run.advance(1200)
	check('introTailMs: 0 keeps the film until its real end', revealed(run) === false)

	run.video.ended = true
	run.video.dispatch('ended')
	run.advance(500)
	check('the ended film still reveals', revealed(run) === true)
	run.advance(3000)
	check('the veil still comes off', removed(run))
}

// --- never cut a short film before its halfway point ------------------------

{
	const run = play({ ...base, introTailMs: 1500 }, 2)
	run.startPlaying()
	run.video.currentTime = 0.6
	run.advance(1200)
	check('a short film is not cut before half its length', revealed(run) === false)

	run.video.currentTime = 1.05
	run.advance(200)
	check('the short film hands off at its halfway point', revealed(run) === true)
	run.advance(3000)
}

// --- controller hygiene -----------------------------------------------------

check('the controller parses', (() => {
	try {
		new vm.Script(bootSource)
		return true
	} catch {
		return false
	}
})())
check('the controller clears its hand-off timer on removal', bootSource.includes('stopHandoffWatch()'))
check('the controller still honours reduced motion', bootSource.includes('prefers-reduced-motion'))

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURE(S): ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
