// Windows title-bar hand-off checks for the boot controller.
//
// The controller cannot run against a real shell here, so this suite installs
// the smallest DOM it actually touches and asserts the contract the DSH preload
// relies on: while the veil plays it must write `--dsw-specific-sidebar-fill`
// and `--dsw-alias-label-primary` into <body>'s inline style (with !important),
// because that is the only place the preload's MutationObserver re-measures
// from. The two values are released in two steps — glyphs when the reveal
// begins, plate when the veil is gone — so no transparent title bar is left
// behind on any exit path.
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

const FILL = '--dsw-specific-sidebar-fill'
const SYMBOL = '--dsw-alias-label-primary'
const bootSource = readFileSync(join(ROOT, 'theme/boot.js'), 'utf8')

function createStyle() {
	const values = new Map()
	return {
		setProperty(name, value, priority) {
			values.set(name, { value: String(value), priority: priority ?? '' })
		},
		removeProperty(name) {
			const previous = values.get(name)
			values.delete(name)
			return previous === undefined ? '' : previous.value
		},
		getPropertyValue(name) {
			return values.has(name) ? values.get(name).value : ''
		},
		getPropertyPriority(name) {
			return values.has(name) ? values.get(name).priority : ''
		},
		has(name) {
			return values.has(name)
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
			if (child.parentNode !== element) return child
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

/** Run the controller with `config` and hand back the fake document plus helpers. */
function play(config, backdrop = 'rgb(4, 8, 15)') {
	const body = createElement('body')
	const root = createElement('html')
	const veil = createElement('div')
	const holder = {
		removeChild(node) {
			if (node.parentNode === holder) node.parentNode = null
		},
	}
	veil.parentNode = holder

	const document = {
		body,
		documentElement: root,
		readyState: 'complete',
		getElementById(id) {
			return id === 'dsh-theme-veil' && veil.parentNode !== null ? veil : null
		},
		createElement(tag) {
			return createElement(tag)
		},
		querySelector(selector) {
			if (selector === '[data-dsh-boot]') return null
			if (selector === '[data-shell-overlay]') return {}
			return null
		},
	}

	let timers = []
	let nextTimerId = 1
	const globalListeners = new Map()
	const storage = () => {
		const values = new Map()
		return {
			getItem: (key) => (values.has(key) ? values.get(key) : null),
			setItem: (key, value) => values.set(key, String(value)),
			removeItem: (key) => values.delete(key),
		}
	}

	const sandbox = {
		console,
		document,
		getComputedStyle: () => ({ backgroundColor: backdrop }),
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
			timers.push({ id, callback, delay })
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
		timers,
		/** Fire the controller's "click anywhere to skip" handler. */
		skip() {
			const entry = globalListeners.get('pointerdown')
			if (entry === undefined) throw new Error('no pointerdown skip handler')
			if (entry.once) globalListeners.delete('pointerdown')
			entry.handler()
		},
		/** Run every queued timer once, repeating for timers queued by callbacks. */
		runTimers() {
			for (let round = 0; round < 8 && timers.length > 0; round += 1) {
				const batch = timers.slice().sort((left, right) => left.delay - right.delay)
				timers = []
				for (const timer of batch) timer.callback()
			}
		},
	}
}

const baseConfig = {
	enabled: true,
	animation: 'hud',
	playOn: 'always',
	durationMs: 800,
	holdMs: 0,
	titleBar: 'hide',
	introSrc: null,
	backgroundScope: 'always',
}

// --- hide -------------------------------------------------------------------

{
	const run = play({ ...baseConfig, titleBar: 'hide' })
	check('hide turns the caption plate transparent', run.body.style.getPropertyValue(FILL) === 'transparent')
	check('hide marks the plate override important', run.body.style.getPropertyPriority(FILL) === 'important')
	check('hide paints the glyphs with the veil backdrop', run.body.style.getPropertyValue(SYMBOL) === 'rgb(4, 8, 15)')
	check('hide marks the glyph override important', run.body.style.getPropertyPriority(SYMBOL) === 'important')

	run.skip()
	check('reveal restores the glyph colour', run.body.style.has(SYMBOL) === false)
	check('reveal keeps the plate transparent while the veil fades', run.body.style.getPropertyValue(FILL) === 'transparent')

	run.runTimers()
	check('removing the veil restores the plate colour', run.body.style.has(FILL) === false)
	check('binding removed the veil markup', run.veil.parentNode === null)
	check('hide leaves no title-bar override behind', run.body.style.has(FILL) === false && run.body.style.has(SYMBOL) === false)
}

// --- blend ------------------------------------------------------------------

{
	const run = play({ ...baseConfig, titleBar: 'blend' })
	check('blend turns the caption plate transparent', run.body.style.getPropertyValue(FILL) === 'transparent')
	check('blend lifts the glyphs against a dark film', run.body.style.getPropertyValue(SYMBOL) === '#e6f1ff')
	run.skip()
	run.runTimers()
	check('blend restores every override', run.body.style.has(FILL) === false && run.body.style.has(SYMBOL) === false)
}

{
	const run = play({ ...baseConfig, animation: 'fade', titleBar: 'blend' }, 'rgb(245, 248, 252)')
	check('blend uses dark glyphs on a light veil', run.body.style.getPropertyValue(SYMBOL) === '#071525')
	run.skip()
	run.runTimers()
}

{
	const run = play({ ...baseConfig, animation: 'fade', titleBar: 'hide' }, 'rgb(245, 248, 252)')
	check('hide follows a light veil backdrop', run.body.style.getPropertyValue(SYMBOL) === 'rgb(245, 248, 252)')
	run.skip()
	run.runTimers()
}

// --- off / missing ----------------------------------------------------------

for (const mode of ['off', undefined]) {
	const run = play({ ...baseConfig, titleBar: mode })
	check(`titleBar ${String(mode)} leaves the shell variables alone`, run.body.style.has(FILL) === false && run.body.style.has(SYMBOL) === false)
	run.skip()
	run.runTimers()
	check(`titleBar ${String(mode)} still removes the veil`, run.veil.parentNode === null)
}

// --- controller stays parseable / safe -------------------------------------

check('controller still exposes the replay entry point', bootSource.includes('__dshThemePlayVeil'))
check('controller cannot close a script tag', !/<\/script/iu.test(bootSource))
check('controller restores the title bar on its failure path', bootSource.includes('restoreTitleBar()'))

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURE(S): ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
