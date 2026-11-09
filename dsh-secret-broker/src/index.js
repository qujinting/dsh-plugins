/**
 * dsh-secret-broker — user-entered secrets that a session can *use* without
 * ever *seeing*.
 *
 * The problem is not "the agent cannot hold a token"; it is that every existing
 * way of giving it one puts the value somewhere permanent and readable — a
 * prompt, a config file, a `.env` in the workspace, a tool argument, a session
 * log. Once a value is in the transcript it has been sent to a model provider,
 * indexed by session search, and copied into every backup of the log.
 *
 * So this plugin never hands the model a value. It hands it a *name*, and turns
 * that name into a real environment variable inside the child process of a
 * shell call — at the one moment the value is actually needed, in the one place
 * that is not recorded:
 *
 * 1. `ctx.shellEnv` contributes `DSH_SECRET_<KEY>` to a shell execution, but
 *    only for keys the command text names, and only for scopes that apply to
 *    the executing session.
 * 2. `tools/post-execute` rewrites any known value that still reached a result
 *    into `«redacted:KEY»`, before the result is committed.
 * 3. The store is sealed with DPAPI for the current Windows user, so the file
 *    is worthless to a backup, a sync, another account, or another machine.
 * 4. The model discovers keys through a prompt section, a `secret_list` tool and
 *    an embedded skill — all of which carry metadata only.
 *
 * Everything is dependency-free: no `@deepseek-ai/*` import, because a
 * profile-installed plugin cannot resolve those without a build-time runtime
 * link, and this package is meant to survive a harness upgrade untouched.
 *
 * @module dsh-secret-broker
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DpapiCipher } from './crypto.js'
import { KEYS_VARIABLE, PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, promptSectionText, renderKeyList } from './prompt.js'
import { installRedaction } from './redact.js'
import { registerRoutes } from './route.js'
import { SECRET_BROKER_SKILL } from './skill.js'
import { ShellEnvBridge } from './shellenv.js'
import { SecretStore } from './store.js'
import { secretListTool } from './tool.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-secret-broker'

/**
 * The two services whose absence would make the plugin pointless: without
 * `tools` there is nothing for the model to call, without `systemPrompt` no
 * session would learn the convention.
 */
export const inject = ['tools', 'systemPrompt']

/** This package's own directory, resolved from the module URL. */
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The default environment variable prefix; the registry accepts `DSH_[A-Z0-9_]*`. */
const DEFAULT_KEY_PREFIX = 'DSH_SECRET_'

/** Bounds for the configurable numbers, so a typo cannot disable a safety net. */
const REDACT_MIN_LENGTH_FLOOR = 4
const REDACT_MIN_LENGTH_CEILING = 64
const MAX_ENTRIES_CEILING = 1000

/**
 * Project the loader-validated config onto plain values with defaults.
 *
 * A missing or partial config is the normal case, so every field is optional
 * and every default is the behaviour the docs promise. An unusable value falls
 * back to the default and is reported once, rather than throwing during `apply`
 * — a plugin that fails to load is a broken composition, and a bad `dataDir`
 * should cost the user a warning, not their harness.
 *
 * @param config - the composition entry's configuration.
 * @param warn - a sink for rejected values.
 * @returns resolved plugin options.
 */
export function readOptions(config, warn = () => {}) {
	const source = config !== null && typeof config === 'object' ? config : {}

	const rawDataDir = nonEmptyString(source.dataDir)
	const dataDir = rawDataDir === undefined ? path.join(PACKAGE_ROOT, 'data') : path.resolve(PACKAGE_ROOT, rawDataDir)

	let keyPrefix = nonEmptyString(source.keyPrefix) ?? DEFAULT_KEY_PREFIX
	if (!/^DSH_[A-Z0-9_]*$/u.test(keyPrefix)) {
		warn(`keyPrefix "${keyPrefix}" 不合法（须匹配 ^DSH_[A-Z0-9_]*$），已回落到 ${DEFAULT_KEY_PREFIX}`)
		keyPrefix = DEFAULT_KEY_PREFIX
	}

	let toolName = nonEmptyString(source.toolName) ?? 'secret_list'
	if (!/^[a-z][a-z0-9_]*$/u.test(toolName)) {
		warn(`toolName "${toolName}" 不合法（须匹配 ^[a-z][a-z0-9_]*$），已回落到 secret_list`)
		toolName = 'secret_list'
	}

	const redactMinLength = boundedInteger(source.redactMinLength, 8, REDACT_MIN_LENGTH_FLOOR, REDACT_MIN_LENGTH_CEILING, 'redactMinLength', warn)
	const maxEntries = boundedInteger(source.maxEntries, 200, 1, MAX_ENTRIES_CEILING, 'maxEntries', warn)

	let titleBarValues = 'masked'
	if (source.titleBarValues !== undefined) {
		if (source.titleBarValues === 'masked' || source.titleBarValues === 'plain') titleBarValues = source.titleBarValues
		else warn('titleBarValues 只能是 masked 或 plain，已回落到 masked')
	}

	return {
		dataDir,
		encryption: source.encryption === 'none' ? 'none' : 'dpapi',
		keyPrefix,
		toolName,
		allowReveal: source.allowReveal ?? true,
		redactResults: source.redactResults ?? true,
		redactMinLength,
		maxEntries,
		titleBarValues,
		registerSkill: source.registerSkill ?? true,
		registerPromptSection: source.registerPromptSection ?? true,
		dpapiTimeoutMs: boundedInteger(source.dpapiTimeoutMs, 20_000, 1000, 120_000, 'dpapiTimeoutMs', warn),
	}
}

/**
 * Wire the store, the shell-environment contributor, the tool, the prompt, the
 * skill, the routes and the redaction listeners.
 *
 * @param ctx - the plugin context.
 * @param config - the composition entry's validated configuration.
 */
export function apply(ctx, config) {
	const options = readOptions(config, (message) => ctx.logger?.warn?.(`secret-broker: ${message}`))

	// The cipher is always constructed: `encryption` only decides what happens
	// when nothing is on disk yet. An existing sealed document must stay
	// readable even if a deployment later flips the option to `none`.
	const cipher = new DpapiCipher({ timeoutMs: options.dpapiTimeoutMs })
	const store = new SecretStore({
		dataDir: options.dataDir,
		encryption: options.encryption,
		keyPrefix: options.keyPrefix,
		maxEntries: options.maxEntries,
		cipher,
		logger: ctx.logger,
	})

	attachShellEnv(ctx, store)
	attachPrompt(ctx, store, options)
	attachSkill(ctx, options)

	ctx.effect(() => ctx.tools.register(secretListTool({ toolName: options.toolName, keyPrefix: options.keyPrefix, store })), 'secret-broker.tool()')
	ctx.effect(() => installRedaction(ctx, store, options), 'secret-broker.redact()')

	ctx.inject(['webServer'], (webCtx) => {
		if (webCtx.webServer === undefined || webCtx.webServer === null) return
		webCtx.effect(() => registerRoutes(webCtx, store, options), 'secret-broker.routes()')
	})
	if (!serviceIsMounted(ctx, 'webServer')) {
		ctx.logger?.warn?.('secret-broker: 没有 ctx.webServer，设置界面不可用（工具与注入仍然可用）')
	}

	// One diagnosable line once disk has been read: which file, sealed or not,
	// and how many keys it holds.
	void store.ready.then(() => {
		const where = store.sealed ? 'DPAPI 加密' : '明文'
		ctx.logger?.info?.(
			`secret-broker: ${String(store.entries.length)} 个密钥，${where}存储于 ${options.dataDir}`
			+ (store.locked ? '（只读：解密失败）' : ''),
		)
	})
}

/**
 * Keep the `ctx.shellEnv` contributor in step with the store.
 *
 * Two sync points are needed and both matter: after the first load (the
 * contributor registered during `apply` saw an empty store) and after every
 * committed write (the registry validates declared names once, so a new key
 * only reaches shell calls after the contributor is replaced).
 *
 * @param ctx - the plugin context.
 * @param store - the secret store.
 */
function attachShellEnv(ctx, store) {
	if (!serviceIsMounted(ctx, 'shellEnv')) {
		// `inject` would simply never fire, and a silently inactive feature is
		// harder to diagnose than a log line.
		ctx.logger?.warn?.('secret-broker: 没有 ctx.shellEnv，值不会被注入 shell 调用（界面与工具仍然可用）')
	}
	ctx.inject(['shellEnv'], (shellCtx) => {
		if (shellCtx.shellEnv === undefined || shellCtx.shellEnv === null) {
			ctx.logger?.warn?.('secret-broker: 没有 ctx.shellEnv，值不会被注入 shell 调用（界面与工具仍然可用）')
			return
		}
		shellCtx.effect(() => {
			const bridge = new ShellEnvBridge(shellCtx.shellEnv, store)
			let live = true
			bridge.sync()
			const off = store.onChange(() => {
				if (live) bridge.sync()
			})
			void store.ready.then(() => {
				if (live) bridge.sync()
			})
			return () => {
				live = false
				off()
				bridge.release()
			}
		}, 'secret-broker.shellEnv()')
	})
}

/**
 * Contribute the routing section and the live key list.
 *
 * @param ctx - the plugin context.
 * @param store - the secret store.
 * @param options - resolved plugin options.
 */
function attachPrompt(ctx, store, options) {
	if (!options.registerPromptSection) return
	ctx.effect(
		() => ctx.systemPrompt.section({
			name: PROMPT_SECTION_NAME,
			order: PROMPT_SECTION_ORDER,
			text: promptSectionText(options),
		}),
		'secret-broker.promptSection()',
	)
	// The provider must answer for every assembly: a registered variable with no
	// value fails the whole prompt, so `renderKeyList` always returns a string.
	ctx.effect(
		() => ctx.systemPrompt.variable(KEYS_VARIABLE, (context) => {
			const header = context?.agent?.session?.header
			return renderKeyList(store, header?.id, header?.cwd)
		}),
		'secret-broker.promptVariable()',
	)
}

/**
 * Register the embedded skill, when a skill registry is mounted.
 *
 * @param ctx - the plugin context.
 * @param options - resolved plugin options.
 */
function attachSkill(ctx, options) {
	if (!options.registerSkill) return
	ctx.inject(['skills'], (skillCtx) => {
		if (skillCtx.skills === undefined || skillCtx.skills === null) return
		skillCtx.effect(() => skillCtx.skills.register(SECRET_BROKER_SKILL), 'secret-broker.skill()')
	})
}

/**
 * Whether a service is mounted right now.
 *
 * `ctx.inject` is the right way to *use* an optional service — it also fires
 * for one that arrives later — but it says nothing when the service never
 * arrives, and a feature that silently does nothing is the hardest kind to
 * diagnose.
 *
 * @param ctx - the plugin context.
 * @param name - the service name.
 * @returns whether the service resolves at this moment.
 */
function serviceIsMounted(ctx, name) {
	try {
		const service = ctx.get?.(name)
		return service !== undefined && service !== null
	} catch {
		return false
	}
}

/**
 * Read an optional non-empty string.
 * @param value - the raw config field.
 * @returns the trimmed string, or undefined when it is absent or blank.
 */
function nonEmptyString(value) {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Read an optional integer inside bounds, reporting a rejected value.
 * @param value - the raw config field.
 * @param fallback - the value used when absent or rejected.
 * @param minimum - the inclusive lower bound.
 * @param maximum - the inclusive upper bound.
 * @param label - the field name used in the warning.
 * @param warn - the warning sink.
 * @returns the resolved integer.
 */
function boundedInteger(value, fallback, minimum, maximum, label, warn) {
	if (value === undefined) return fallback
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		warn(`${label} 必须是 ${String(minimum)}–${String(maximum)} 之间的整数，已回落到 ${String(fallback)}`)
		return fallback
	}
	return value
}
