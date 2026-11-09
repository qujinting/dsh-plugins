/**
 * Turn arbitrary host values into snapshots that are safe to hand across a
 * plugin boundary.
 *
 * A capability that returned the live service object would hand every caller a
 * mutable handle on host internals, which is the exact coupling this plugin
 * exists to prevent. Callers get plain data: functions become their names,
 * cycles stop at a depth bound, and long collections are truncated with an
 * explicit marker instead of being silently cut.
 *
 * @module dsh-bridge/serialize
 */

import { coded } from './policy.js'

/** Maximum nesting depth before a value is reported as opaque. */
const MAX_DEPTH = 3

/** Maximum array items and object fields carried in one snapshot. */
const MAX_ITEMS = 32

/** Maximum values a caller may hand to one `service.call`. */
const MAX_ARG_VALUES = 256

/** Maximum nesting depth of caller-supplied arguments. */
const MAX_ARG_DEPTH = 6

/** Maximum characters in one caller-supplied string. */
const MAX_ARG_STRING = 8192

/**
 * Field names whose *values* never cross the boundary.
 *
 * A bridge that can call any service will eventually call one whose config
 * carries an API key, and a caller that receives it has already leaked it into
 * its own state. The pattern is deliberately key-name based and conservative:
 * a renamed field slips through, but nothing is redacted by accident.
 */
const REDACT_PATTERN = /(api[-_]?key|secret|token|password|passwd|credential|authorization)/i

/**
 * Values that look like a credential even when the field name says nothing.
 *
 * Key-name redaction alone misses the case that matters most: a method that
 * returns a bare string — `credentials.get()` shaped APIs, connection strings,
 * a token echoed from a config row — arrives as `value: "sk-…"` with no field
 * name to inspect. These prefixes are the ones a leaked host process would show
 * first, and a false positive costs one replaced string, not a broken call.
 */
const SECRET_VALUE =
	/(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/

/** What a redacted value is replaced with. */
export const REDACTED = '«redacted»'

/**
 * Summarize one value.
 * @param value - anything a service method returned.
 * @param depth - current nesting depth.
 * @returns a JSON-safe snapshot.
 */
export function summarize(value, depth = 0) {
	if (value === undefined) return { kind: 'undefined' }
	if (value === null) return null

	const type = typeof value
	if (type === 'string') return SECRET_VALUE.test(value) ? REDACTED : value
	if (type === 'number' || type === 'boolean') return value
	if (type === 'bigint') return { kind: 'bigint', value: value.toString() }
	if (type === 'function') return { kind: 'function', name: value.name || 'anonymous' }
	if (type === 'symbol') return { kind: 'symbol', value: String(value) }
	if (depth >= MAX_DEPTH) {
		// Naming the keys costs little and keeps the snapshot useful: a caller can
		// still see the shape of what it is not allowed to read.
		if (Array.isArray(value)) return { kind: 'array', truncated: true, length: value.length }
		return { kind: 'object', truncated: true, keys: Object.keys(value).slice(0, MAX_ITEMS) }
	}

	if (value instanceof Error) return { kind: 'error', name: value.name, message: value.message }

	if (Array.isArray(value)) {
		return {
			kind: 'array',
			length: value.length,
			items: value.slice(0, MAX_ITEMS).map(item => summarize(item, depth + 1)),
			truncated: value.length > MAX_ITEMS,
		}
	}

	const fields = {}
	const keys = Object.keys(value)
	for (const key of keys.slice(0, MAX_ITEMS)) {
		fields[key] = REDACT_PATTERN.test(key) ? REDACTED : summarize(value[key], depth + 1)
	}
	return { kind: 'object', fields, truncated: keys.length > MAX_ITEMS }
}

/**
 * Read the argument list of a `service.call` request.
 *
 * Arguments cross the boundary *into* the host, so they get the mirror-image
 * rule of `summarize`: the caller may pass data, never behaviour. A function
 * argument is how a caller smuggles a callback past every method-level check —
 * `loader.import(name, getOuterStack)` takes one — and a live object argument is
 * how it keeps a handle on host state after the call returns.
 * @param args - raw `params.args`.
 * @returns the validated argument array, defaulting to empty.
 */
export function portableArgs(args) {
	if (args === undefined) return []
	if (!Array.isArray(args)) throw coded('bad-request', 'args must be an array')
	assertPortable(args)
	return args
}

/**
 * Reject values that are not plain cloneable data.
 * @param value - the value to check.
 * @param depth - current nesting depth.
 * @param seen - values on the current branch, used to reject cycles.
 * @param count - running total of visited values.
 * @returns nothing; throws `bad-request` on the first violation.
 */
export function assertPortable(value, depth = 0, seen = new Set(), count = { values: 0 }) {
	count.values += 1
	if (count.values > MAX_ARG_VALUES) {
		throw coded('bad-request', `args carry more than ${MAX_ARG_VALUES} values`)
	}
	if (depth > MAX_ARG_DEPTH) throw coded('bad-request', `args nest deeper than ${MAX_ARG_DEPTH} levels`)

	if (value === null || value === undefined) return
	const type = typeof value
	if (type === 'string') {
		if (value.length > MAX_ARG_STRING) throw coded('bad-request', `args carry a string longer than ${MAX_ARG_STRING} characters`)
		return
	}
	if (type === 'number' || type === 'boolean' || type === 'bigint') return
	if (type === 'function') throw coded('bad-request', 'args cannot carry a function: pass data, not behaviour')
	if (type === 'symbol') throw coded('bad-request', 'args cannot carry a symbol')
	if (type !== 'object') throw coded('bad-request', `args cannot carry a ${type}`)

	if (seen.has(value)) throw coded('bad-request', 'args cannot be circular')
	seen.add(value)
	try {
		if (Array.isArray(value)) {
			for (const item of value) assertPortable(item, depth + 1, seen, count)
			return
		}
		const proto = Object.getPrototypeOf(value)
		if (proto !== Object.prototype && proto !== null) {
			const name = value?.constructor?.name ?? 'non-plain object'
			throw coded('bad-request', `args must be plain data, not a ${name}`)
		}
		for (const key of Object.keys(value)) assertPortable(value[key], depth + 1, seen, count)
	} finally {
		seen.delete(value)
	}
}
