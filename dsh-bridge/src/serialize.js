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

/** Maximum nesting depth before a value is reported as opaque. */
const MAX_DEPTH = 3

/** Maximum array items and object fields carried in one snapshot. */
const MAX_ITEMS = 32

/**
 * Field names whose *values* never cross the boundary.
 *
 * A bridge that can call any service will eventually call one whose config
 * carries an API key, and a caller that receives it has already leaked it into
 * its own state. The pattern is deliberately key-name based and conservative:
 * a renamed field slips through, but nothing is redacted by accident.
 */
const REDACT_PATTERN = /(api[-_]?key|secret|token|password|passwd|credential|authorization)/i

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
	if (type === 'string' || type === 'number' || type === 'boolean') return value
	if (type === 'bigint') return { kind: 'bigint', value: value.toString() }
	if (type === 'function') return { kind: 'function', name: value.name || 'anonymous' }
	if (type === 'symbol') return { kind: 'symbol', value: String(value) }
	if (depth >= MAX_DEPTH) return { kind: 'object', truncated: true }

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
