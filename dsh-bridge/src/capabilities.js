/**
 * The capability table: the only surface a caller of `dshBridge` can reach.
 *
 * Each entry answers three questions the caller can inspect before running it —
 * what it is (`name`), how dangerous it is (`risk`), and what it does
 * (`summary`) — and each one runs against the host context it was built with.
 * Nothing here is reachable by name alone: `index.js` looks the entry up,
 * applies confirmation and the breaker, and only then calls `run`.
 *
 * @module dsh-bridge/capabilities
 */

import { isDeepStrictEqual } from 'node:util'

import { coded, deniedBy, methodRulesFor } from './policy.js'
import { portableArgs, summarize } from './serialize.js'

/**
 * Build the capability table for one host context.
 * @param host - the plugin context, its options, the deferred-run helper, and the restarter.
 * @returns capability descriptors in listing order.
 */
export function createCapabilities(host) {
	const { ctx, options, defer, restarter } = host

	/**
	 * Decide whether a service may be reached through the bridge at all.
	 *
	 * Two independent gates, and the deny list always wins:
	 * - `serviceDeny` closes services that are destructive or hold credentials.
	 * - `serviceAllow`, when non-empty, is an allowlist: everything else is out,
	 *   so a deployment can shrink the surface to the three services it needs.
	 * @param serviceName - service name from the request.
	 */
	function enforceReachable(serviceName) {
		if (deniedBy(options.serviceDeny, serviceName)) {
			throw coded('service-denied', `service "${serviceName}" is denied by dsh-bridge`)
		}
		if (options.serviceAllow.length > 0 && !deniedBy(options.serviceAllow, serviceName)) {
			throw coded(
				'service-not-allowed',
				`service "${serviceName}" is not on dsh-bridge's allowlist`,
			)
		}
	}

	/**
	 * Reject a method the deployment closed by name.
	 *
	 * The service-level gate alone is not enough: un-denying `loader` for one
	 * deployment hands back `update`, `remove`, and `import` with it, and those
	 * are the calls that write the profile and load arbitrary modules.
	 * @param serviceName - service name from the request.
	 * @param method - method name from the request.
	 */
	function enforceMethod(serviceName, method) {
		if (methodRulesFor(options.methodDeny, serviceName).has(method)) {
			throw coded('method-denied', `method "${method}" on "${serviceName}" is denied by dsh-bridge`)
		}
	}

	/**
	 * Resolve a service, failing with a code instead of returning `undefined`.
	 * @param serviceName - service name from the request.
	 * @returns the live service value.
	 */
	function requireService(serviceName) {
		const value = ctx.get(serviceName)
		if (value === undefined) throw coded('service-unavailable', `service "${serviceName}" is not provided here`)
		return value
	}

	/**
	 * Walk a loader entry's fiber to decide whether the plugin is live.
	 * @param entry - a loader entry.
	 * @returns `true` when the fiber sits in cordis' settled state.
	 */
	function isActive(entry) {
		return entry.fiber?.state === 2
	}

	return [
		{
			name: 'service.list',
			risk: 'low',
			summary: 'List registered service names, whether each resolves, and whether the bridge will reach it.',
			run: () => {
				const props = ctx.reflect?.props ?? {}
				return Object.keys(props)
					.filter(key => props[key]?.type === 'service')
					.sort()
					.map(key => {
						const denied = deniedBy(options.serviceDeny, key)
						return {
							name: key,
							available: ctx.get(key) !== undefined,
							denied,
							allowed: !denied && (options.serviceAllow.length === 0 || deniedBy(options.serviceAllow, key)),
						}
					})
			},
		},
		{
			name: 'service.describe',
			risk: 'low',
			summary: 'List one service\'s own keys and the methods on its prototype chain.',
			run: params => {
				const serviceName = requireString(params, 'service')
				enforceReachable(serviceName)
				const value = requireService(serviceName)

				const keys = Object.keys(value)
				const methods = new Set(keys.filter(key => typeof value[key] === 'function'))
				let proto = Object.getPrototypeOf(value)
				while (proto !== null && proto !== Object.prototype) {
					for (const key of Object.getOwnPropertyNames(proto)) {
						if (key === 'constructor') continue
						const descriptor = Object.getOwnPropertyDescriptor(proto, key)
						if (typeof descriptor?.value === 'function') methods.add(key)
					}
					proto = Object.getPrototypeOf(proto)
				}

				return { service: serviceName, keys: keys.sort(), methods: [...methods].sort() }
			},
		},
		{
			name: 'service.call',
			risk: 'medium',
			summary: 'Call one method on one service and return a snapshot of its result; arguments must be plain data.',
			run: async params => {
				const serviceName = requireString(params, 'service')
				const method = requireString(params, 'method')
				enforceReachable(serviceName)
				enforceMethod(serviceName, method)
				const args = portableArgs(params.args)

				const target = requireService(serviceName)
				const fn = target[method]
				if (typeof fn !== 'function') {
					throw coded('no-such-method', `service "${serviceName}" has no method "${method}"`)
				}

				const value = await fn.apply(target, args)
				return { service: serviceName, method, value: summarize(value) }
			},
		},
		{
			name: 'plugin.list',
			risk: 'low',
			summary: 'List loader entries with their id, package name, and activation state.',
			run: () => {
				const loader = requireService('loader')
				if (typeof loader.entries !== 'function') {
					throw coded('service-unavailable', 'the loader service in this profile cannot enumerate entries')
				}
				const rows = []
				for (const entry of loader.entries()) {
					rows.push({
						id: entry.id,
						name: entry.options?.name ?? '',
						active: isActive(entry),
					})
				}
				return rows
			},
		},
		{
			name: 'config.edit',
			risk: 'high',
			summary: 'Persist one plugin\'s configuration into the active profile patch and apply it.',
			run: async params => {
				const target = requireString(params, 'plugin')
				if (target === host.selfName) {
					throw coded(
						'bad-request',
						'dsh-bridge cannot rewrite its own row: the reload it triggers would cut off this call',
					)
				}

				const editor = requireService('configEditor')
				if (typeof editor.edit !== 'function' || typeof editor.configuration !== 'function') {
					throw coded('service-unavailable', 'the configEditor service in this profile cannot edit configuration')
				}

				const mode = params.config !== undefined ? 'config' : params.patch !== undefined ? 'patch' : undefined
				if (mode === undefined) throw coded('bad-request', 'config.edit needs either { config } or { patch }')
				const source = mode === 'config' ? params.config : params.patch
				if (source === null || typeof source !== 'object' || Array.isArray(source)) {
					throw coded('bad-request', `${mode} must be a plain object`)
				}

				const row = findEditableRow(editor, target)
				if (row === undefined) {
					throw coded(
						'no-such-plugin',
						`"${target}" is not an editable profile row; only entries under the root include with a unique id can be edited`,
					)
				}

				// The editor recomputes both sides under its own lock, so the callback
				// reads them fresh instead of trusting this pre-flight snapshot.
				const derive = (current, inherited) =>
					mode === 'config' ? structuredClone(source) : mergePatch(current, source, inherited)
				const preview = derive(row.entry.options?.config ?? {}, row.inherited)

				if (params.dryRun === true) {
					return {
						plugin: row.entry.id,
						mode,
						dryRun: true,
						willWrite: preview,
						removesOverride: isDeepStrictEqual(preview, row.inherited),
					}
				}

				await editor.edit(row.entry, derive)

				const after = findEditableRow(editor, row.entry.id)
				const persisted = after?.override ?? {}
				return {
					plugin: row.entry.id,
					mode,
					saved: true,
					removesOverride: Object.keys(persisted).length === 0,
					persisted: summarize(persisted),
				}
			},
		},
		{
			name: 'plugin.restart',
			risk: 'high',
			summary: 'Dispose and reload a plugin with its current config; defaults to this plugin.',
			run: params => {
				const target = typeof params.plugin === 'string' ? params.plugin : undefined

				if (target === undefined || target === host.selfName) {
					return defer(() => ctx.fiber.restart(), 'plugin.restart:self')
				}

				const loader = requireService('loader')
				if (typeof loader.entries !== 'function') {
					throw coded('service-unavailable', 'the loader service in this profile cannot enumerate entries')
				}

				let hit
				for (const entry of loader.entries()) {
					if (entry.id === target || entry.options?.name === target) {
						hit = entry
						break
					}
				}
				if (hit === undefined) throw coded('no-such-plugin', `no plugin matches "${target}"`)
				if (hit.fiber === undefined) throw coded('no-such-plugin', `plugin "${target}" has no settled fiber`)

				const fiber = hit.fiber
				return defer(() => fiber.restart(), `plugin.restart:${target}`)
			},
		},
		{
			name: 'app.exit',
			risk: 'high',
			summary: 'Ask the launcher to shut the host down gracefully.',
			run: params => {
				const code = Number.isSafeInteger(params.code) ? params.code : 0
				const exit = requireService('appExit')
				return defer(() => exit(code), 'app.exit')
			},
		},
		{
			name: 'app.restart',
			risk: 'high',
			summary: 'Relaunch the whole host: arm a detached relay, answer this call, then take the current process down so the relay starts a fresh one.',
			run: params => {
				const reason = typeof params.reason === 'string' && params.reason.length > 0 ? params.reason : 'manual'
				if (restarter === undefined) throw coded('service-unavailable', 'this activation has no relaunch support')
				return restarter.begin({ trigger: reason })
			},
		},
		{
			name: 'app.restartState',
			risk: 'low',
			summary: 'Report how this host can be relaunched, how much restart budget is left, and what the last relays did.',
			run: () => {
				if (restarter === undefined) throw coded('service-unavailable', 'this activation has no relaunch support')
				return restarter.state()
			},
		},
	]
}

/**
 * Read a required non-empty string field.
 * @param params - the request parameters.
 * @param field - field name to read.
 * @returns the string value.
 */
function requireString(params, field) {
	const value = params?.[field]
	if (typeof value !== 'string' || value.length === 0) {
		throw coded('bad-request', `missing required string field "${field}"`)
	}
	return value
}

/**
 * Resolve one editable profile row by Loader id or package name.
 *
 * `configuration()` already applies the editor's own rules — root include only,
 * unique row id — so matching against its result is what keeps the bridge from
 * handing the editor an entry it would refuse.
 * @param editor - the configEditor service.
 * @param target - Loader id or package name from the request.
 * @returns the row, or `undefined` when nothing editable matches.
 */
function findEditableRow(editor, target) {
	const rows = editor.configuration()
	return rows.find(item => item.entry?.id === target || item.entry?.options?.name === target)
}

/**
 * Overlay a patch on the live config without pinning inherited defaults.
 *
 * The editor writes a *complete* config override, so naively spreading the
 * current config into it would copy every value the bundle layer already
 * supplies into the user's own patch — where later bundle upgrades can no
 * longer reach them. A field the caller did not touch and that still equals its
 * inherited value carries no information, so it is dropped and left to the
 * bundle layer. `undefined` in the patch means "remove this key".
 * @param current - the config as it currently resolves.
 * @param patch - the caller's changes.
 * @param inherited - the config without this profile's override.
 * @returns the config to persist.
 */
function mergePatch(current, patch, inherited) {
	const next = { ...current }
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) delete next[key]
		else next[key] = value
	}
	for (const key of Object.keys(next)) {
		if (Object.hasOwn(patch, key)) continue
		if (Object.hasOwn(inherited, key) && isDeepStrictEqual(inherited[key], next[key])) delete next[key]
	}
	return next
}
