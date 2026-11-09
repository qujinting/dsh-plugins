/**
 * The client bundle, executed.
 *
 * `node --check` proves a file *parses*; it cannot prove the module the shell
 * actually loads *runs*. The failure that motivated this file is exactly that
 * gap: a stray backtick inside the stylesheet's template literal ended the
 * string early, and what followed parsed as a subtraction between two
 * identifiers — so every syntax check passed while the bundle threw
 * `ReferenceError: sb is not defined` at import time and took the whole web
 * boot down with it.
 *
 * So the bundle is loaded here the way the module system loads it — a stub
 * `window.__ModuleLoader__` captures the registration, the factory runs against
 * a stub `require`, and `apply` is driven against a stub slots service. A
 * render of each surface is attempted too, because a component that throws on
 * its first render is just as broken as one that throws on import.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SOURCE = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')

/**
 * Enough React for a factory body and a first render, and nothing more.
 *
 * The hooks return usable values rather than throwing, so a component's
 * top-level code path runs for real: `useMemo` calls its factory, `useCallback`
 * hands back the function, and `createElement` returns a marker the assertions
 * can count.
 */
const REACT_STUB = {
	createElement: (type, props, ...children) => ({ type, props, children }),
	useState: (initial) => [initial, () => {}],
	useRef: (initial) => ({ current: initial ?? null }),
	useCallback: (fn) => fn,
	useEffect: () => {},
	useMemo: (fn) => fn(),
	Fragment: Symbol('Fragment'),
}

/** The one module request the bundle is allowed to make. */
function stubRequire(specifier) {
	if (specifier === 'react') return REACT_STUB
	throw new Error(`unregistered module request: ${specifier}`)
}

/**
 * Load the bundle against a stub facade.
 * @returns the registration the bundle handed to `window.__ModuleLoader__.load`.
 */
function loadBundle() {
	let registration
	const fakeWindow = { __ModuleLoader__: { load: (value) => { registration = value } } }
	// The bundle is a plain script that only calls into the facade; evaluating it
	// with a `window` parameter is what the module system does, minus the graph.
	new Function('window', SOURCE)(fakeWindow)
	assert.ok(registration !== undefined, 'the bundle registered itself')
	return registration
}

/** A minimal `document`, for the stylesheet installer. */
function withDocument(run) {
	const previous = globalThis.document
	const appended = []
	globalThis.document = {
		getElementById: () => null,
		createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
		head: { appendChild: (node) => appended.push(node) },
	}
	try {
		return run(appended)
	} finally {
		if (previous === undefined) delete globalThis.document
		else globalThis.document = previous
	}
}

test('the bundle registers one factory, and the factory runs', () => {
	const registration = loadBundle()
	assert.equal(registration.id, 'dsh-secret-broker')
	assert.equal(typeof registration.factory, 'function')
	const exported = registration.factory(stubRequire)
	assert.equal(exported.name, 'secret-broker')
	assert.deepEqual(exported.inject, ['slots'])
	assert.equal(typeof exported.apply, 'function')
	assert.equal(typeof exported.SecretsSection, 'function')
	assert.equal(typeof exported.HeaderSecretsAction, 'function')
})

test('the factory asks for react and nothing else', () => {
	const registration = loadBundle()
	const requested = []
	const exported = registration.factory((specifier) => {
		requested.push(specifier)
		return stubRequire(specifier)
	})
	assert.deepEqual(requested, ['react'], 'a request the module system cannot answer fails the whole row')
	assert.equal(typeof exported.apply, 'function')
})

test('apply mounts both surfaces, one registration each', () => {
	const exported = loadBundle().factory(stubRequire)
	withDocument(() => {
		const events = []
		const ctx = {
			logger: { warn: (message) => events.push(`warn:${message}`) },
			slots: {
				inject: (name, run) => { events.push(`inject:${name}`); run() },
				register: (options) => { events.push(`register:${options.name}#${options.id}`); return () => {} },
			},
		}
		exported.apply(ctx)
		assert.deepEqual(events, [
			'inject:conversation.session.header.utilities',
			'register:conversation.session.header.utilities#secret-broker',
			'inject:settings.section',
			'register:settings.section#secrets',
		])
	})
})

test('a missing slots service leaves apply harmless', () => {
	const exported = loadBundle().factory(stubRequire)
	withDocument(() => {
		const warnings = []
		exported.apply({ logger: { warn: (message) => warnings.push(message) } })
		assert.deepEqual(warnings, [])
	})
})

test('a registration that throws is reported, not propagated', () => {
	const exported = loadBundle().factory(stubRequire)
	withDocument(() => {
		const warnings = []
		exported.apply({
			logger: { warn: (message) => warnings.push(message) },
			slots: {
				inject: () => { throw new Error('no such seat') },
				register: () => () => {},
			},
		})
		assert.equal(warnings.length, 2, 'each surface reports its own failure')
		assert.match(warnings[0], /no such seat/)
	})
})

test('a reloaded bundle refreshes the mounted stylesheet instead of keeping the old one', () => {
	const exported = loadBundle().factory(stubRequire)
	const previous = globalThis.document
	const created = []
	// A stylesheet from the previous revision is already on the page — the state
	// a plugin reload leaves behind.
	const mounted = { id: 'dsh-secret-broker-style', textContent: '/* revision N */', setAttribute() {}, appendChild() {} }
	globalThis.document = {
		getElementById: () => mounted,
		createElement: () => {
			const element = { style: {}, setAttribute() {}, appendChild() {} }
			created.push(element)
			return element
		},
		head: { appendChild() {} },
	}
	try {
		exported.apply({
			logger: { warn: () => {} },
			slots: { inject: (name, run) => run(), register: () => () => {} },
		})
		assert.ok(mounted.textContent.includes('.dsh-sb-backdrop'), 'the mounted stylesheet is brought up to date')
		assert.ok(mounted.textContent.includes('.dsh-sb-dialog'), 'and carries this revision\'s class names')
		assert.equal(created.length, 0, 'no second stylesheet element is appended')
	} finally {
		if (previous === undefined) delete globalThis.document
		else globalThis.document = previous
	}
})

test('a fresh page gets one stylesheet', () => {
	const exported = loadBundle().factory(stubRequire)
	const previous = globalThis.document
	const created = []
	globalThis.document = {
		getElementById: () => null,
		createElement: () => {
			const element = { style: {}, setAttribute() {}, appendChild() {} }
			created.push(element)
			return element
		},
		head: { appendChild() {} },
	}
	try {
		exported.apply({
			logger: { warn: () => {} },
			slots: { inject: (name, run) => run(), register: () => () => {} },
		})
		assert.equal(created.length, 1)
		assert.ok(created[0].textContent.includes('.dsh-sb-iconbtn'))
	} finally {
		if (previous === undefined) delete globalThis.document
		else globalThis.document = previous
	}
})

test('the modal geometry is inline, so a missing stylesheet cannot stretch the header', () => {
	// The component's `open` state is internal, so the open branch cannot be
	// reached by rendering; the source assertion is what pins the guarantee that
	// the backdrop's geometry does not depend on the stylesheet at all.
	const source = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
	assert.ok(source.includes("className: 'dsh-sb-backdrop'"), 'the backdrop is identifiable')
	assert.ok(source.includes("position: 'fixed'"), 'fixed positioning does not depend on the stylesheet')
	assert.ok(source.includes("inset: '0'"), 'the backdrop covers the viewport without the stylesheet')
	assert.ok(source.includes("alignItems: 'center'"), 'and centres the dialog without the stylesheet')
})

test('both surfaces survive their first render', () => {
	const exported = loadBundle().factory(stubRequire)
	const settings = exported.SecretsSection({})
	assert.equal(settings.type, 'div', 'the settings page renders its loading state')

	// The header entry is a fragment of [icon button, dialog?]: the button is
	// what the header row lays out, and it has to match the row it sits in.
	const closed = exported.HeaderSecretsAction({ sessionId: 'session-abc' })
	assert.equal(closed.type, REACT_STUB.Fragment)
	const button = closed.children[0]
	assert.equal(button.type, 'button')
	assert.equal(button.props.className, 'dsh-sb-iconbtn')
	assert.equal(button.props['aria-label'], '密钥')
	assert.equal(button.props['aria-haspopup'], 'dialog')
	assert.equal(button.props['aria-expanded'], false)
	assert.equal(closed.children[1], undefined, 'no dialog while closed')
	// The icon is inline SVG in the header's own language, not an emoji.
	const icon = button.children[0]
	assert.equal(icon.type, 'svg')
	assert.equal(icon.props.width, 14)
	assert.equal(icon.props.viewBox, '0 0 16 16')
	assert.equal(icon.props.strokeWidth, 1)

	// No session id is a legitimate state (the seat is Session-scoped, but a
	// defensive render must not throw when the prop is absent).
	assert.equal(exported.HeaderSecretsAction({}).type, REACT_STUB.Fragment)
})
