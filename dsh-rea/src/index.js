/**
 * dsh-rea — REA's reverse-engineering capability as one plugin, not one mode.
 *
 * REA ships an MCP server with 229 tools. Wiring it through the generic MCP
 * bridge is correct and complete, but it makes every session in the profile
 * carry 229 tool schemas in every request: the exact shape that makes a fast
 * model slow. The earlier answer to that was an agent preset that mounts the
 * bridge only for reverse-engineering sessions — a second mode the user has to
 * remember to switch into, and forgets to switch out of.
 *
 * This plugin keeps the capability in every session and the cost out of it:
 *
 * 1. It owns the MCP server process itself, starting it on the first call and
 *    stopping it after an idle period, so a profile that never reverse
 *    engineers anything pays nothing.
 * 2. It exposes two tools — a catalog search and one dispatcher — instead of
 *    229. The catalog is discovered from the server at run time, so a REA
 *    upgrade needs no change here.
 * 3. It adds one prompt section stating that shape, because a capability the
 *    model cannot see needs a sentence telling it where the door is.
 * 4. It answers the question a bundle cannot assume away: **where is REA?** A
 *    settings page can point at a local `rea.mjs` or install REA from the public
 *    registry into the plugin's own data directory, so a user who never ran
 *    `npx rea-agents` still gets a working tool.
 *
 * Nothing is imported from `@deepseek-ai/*`: a profile-installed bundle cannot
 * resolve the Harness packages, so the transport is plain Node.
 *
 * @module dsh-rea
 */

import fs from 'node:fs'
import path from 'node:path'
import { McpStdioClient } from './client.js'
import { Installer, candidates, isEntryPoint, readState, resolveDataDir, resolveLaunch, writeState } from './install.js'
import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, promptSectionText } from './prompt.js'
import { ROUTE_BASE, registerRoutes } from './route.js'
import { reaCallTool, reaToolsTool } from './tools.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-rea'

/** Host-plane services this plugin contributes to. */
export const inject = ['tools', 'systemPrompt']

/** Launch line for the published REA package, mirroring its documented `mcp` entry point. */
const DEFAULT_ARGS = ['-y', 'rea-agents@6.8.0', 'mcp']

/**
 * Project the loader-validated config onto plain values with defaults.
 *
 * @param config - the composition entry's configuration, as validated by the loader.
 * @returns resolved plugin options.
 */
export function readOptions(config) {
	const source = config !== null && typeof config === 'object' ? config : {}
	const args = Array.isArray(source.args) && source.args.every((value) => typeof value === 'string') && source.args.length > 0
		? [...source.args]
		: [...DEFAULT_ARGS]
	return {
		toolsToolName: nonEmptyString(source.toolsToolName) ?? 'rea_tools',
		callToolName: nonEmptyString(source.callToolName) ?? 'rea_call',
		command: nonEmptyString(source.command) ?? 'npx',
		args,
		cwd: nonEmptyString(source.cwd),
		dataDir: nonEmptyString(source.dataDir),
		startupTimeoutMs: positiveInteger(source.startupTimeoutMs) ?? 180_000,
		callTimeoutMs: positiveInteger(source.callTimeoutMs) ?? 600_000,
		idleTimeoutMs: nonNegativeInteger(source.idleTimeoutMs) ?? 600_000,
		registerPromptSection: source.registerPromptSection ?? true,
		warmup: source.warmup ?? false,
	}
}

/**
 * Register the tools, the routing section, the process lifetime, and the
 * settings surface.
 *
 * @param ctx - the plugin context.
 * @param config - the composition entry's validated configuration.
 */
export function apply(ctx, config) {
	const options = readOptions(config)
	// The profile directory comes from the Host service, not from the environment:
	// `DSH_PROFILE_DIR` is injected into shell-tool children only, so reading it
	// here would silently pick the user-level data directory instead.
	const profileDir = readProfileDir(ctx)
	const dataDir = resolveDataDir(options, profileDir)
	const logger = (message) => ctx.logger?.warn?.(message)

	const client = new McpStdioClient({
		resolveLaunch: () => resolveLaunch(dataDir, readState(dataDir), options),
		startupTimeoutMs: options.startupTimeoutMs,
		callTimeoutMs: options.callTimeoutMs,
		logger,
	})

	const installer = new Installer({ dataDir, logger })

	const surface = {
		dataDir,
		/** Everything the settings page renders. */
		status() {
			const state = readState(dataDir)
			const launch = resolveLaunch(dataDir, state, options)
			return {
				dataDir,
				launch,
				candidates: candidates(dataDir, state, options),
				install: installer.status,
				route: ROUTE_BASE,
			}
		},
		/** Point the plugin at a specific `rea.mjs`. */
		setScript(raw) {
			if (typeof raw !== 'string' || raw.trim().length === 0) {
				return { ok: false, error: '请填写 rea.mjs 的绝对路径' }
			}
			const trimmed = raw.trim().replace(/^["']|["']$/gu, '')
			if (!path.isAbsolute(trimmed)) {
				return { ok: false, error: '请填写绝对路径（例如 C:\\...\\rea-agents\\scripts\\rea.mjs）' }
			}
			const resolved = path.resolve(trimmed)
			if (!isEntryPoint(resolved)) return { ok: false, error: `这个路径下没有文件：${resolved}` }
			const state = readState(dataDir)
			writeState(dataDir, { ...state, reaScript: resolved, reaVersion: versionNear(resolved) })
			void client.stop('was stopped because the REA path changed')
			return { ok: true }
		},
		/** Forget the explicit path and fall back to the vendor install. */
		clearScript() {
			const state = readState(dataDir)
			delete state.reaScript
			delete state.reaVersion
			writeState(dataDir, state)
			void client.stop('was stopped because the REA path changed')
		},
		/** Start installing REA from the public registry. */
		install(version) {
			return installer.start(version)
		},
		/** Stop an install in progress. */
		cancelInstall() {
			return installer.cancel()
		},
		/** Prove the current launch line actually reaches a server. */
		async probe() {
			await client.stop('was stopped before a connection test')
			const catalog = await client.start()
			return catalog.length
		},
	}

	let idleTimer = null
	const scheduleIdleStop = () => {
		if (options.idleTimeoutMs <= 0) return
		if (idleTimer !== null) clearTimeout(idleTimer)
		idleTimer = setTimeout(() => {
			idleTimer = null
			void client.stop('was stopped after being idle')
		}, options.idleTimeoutMs)
		idleTimer.unref?.()
	}

	ctx.effect(() => {
		const disposeTools = ctx.tools.register(reaToolsTool(options, client, scheduleIdleStop))
		const disposeCall = ctx.tools.register(reaCallTool(options, client, scheduleIdleStop))
		return () => {
			disposeCall()
			disposeTools()
		}
	}, 'rea.tools()')

	if (options.registerPromptSection) {
		ctx.effect(
			() => ctx.systemPrompt.section({
				name: PROMPT_SECTION_NAME,
				order: PROMPT_SECTION_ORDER,
				text: promptSectionText(options),
			}),
			'rea.promptSection()',
		)
	}

	// The settings page is optional: a composition without a web server still gets
	// the tools, and the user still gets a diagnosable line instead of silence.
	ctx.inject(['webServer'], (webCtx) => {
		if (webCtx.webServer === undefined || webCtx.webServer === null) return
		webCtx.effect(() => registerRoutes(webCtx, surface), 'rea.routes()')
	})

	// Own the child lifetime: unloading the plugin must not leave an orphaned
	// REA server holding a target open.
	ctx.effect(() => () => {
		if (idleTimer !== null) clearTimeout(idleTimer)
		idleTimer = null
		installer.dispose()
		void client.dispose()
	}, 'rea.client()')

	ctx.logger?.info?.(`dsh-rea: REA 从 ${describeOrigin(surface.status().launch.origin)} 启动；数据目录 ${dataDir}`)

	if (options.warmup) {
		void client.start().then(
			(catalog) => ctx.logger?.info?.(`rea: ${catalog.length} tools available`),
			(error) => ctx.logger?.warn?.(`rea: warmup failed: ${error.message}`),
		)
	}
}

/**
 * Read the live profile directory from the Host service.
 *
 * `ctx.profileContext.dir` is the directory the profile's `package.json` lives in;
 * a bare `dsh` boot has no profile, and then there is nothing to read.
 *
 * @param ctx - the plugin context.
 * @returns the directory, or undefined when no profile is mounted.
 */
function readProfileDir(ctx) {
	try {
		const profile = ctx.get?.('profileContext')
		const dir = profile?.dir
		return typeof dir === 'string' && dir.trim().length > 0 ? dir : undefined
	} catch {
		return undefined
	}
}

/**
 * Read the package version above a `scripts/rea.mjs` path.
 * @param script - the entry point.
 * @returns the version, or undefined.
 */
function versionNear(script) {
	let directory = path.dirname(script)
	for (let depth = 0; depth < 3; depth += 1) {
		const manifestPath = path.join(directory, 'package.json')
		try {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
			if (typeof manifest.name === 'string' && manifest.name === 'rea-agents' && typeof manifest.version === 'string') {
				return manifest.version
			}
		} catch {
			// Keep walking.
		}
		directory = path.dirname(directory)
	}
	return undefined
}

/**
 * A short human label for a launch origin.
 * @param origin - `configured`, `vendor`, or `command`.
 * @returns the label.
 */
function describeOrigin(origin) {
	if (origin === 'configured') return '手动指定的 rea.mjs'
	if (origin === 'vendor') return '插件目录内置安装'
	return '默认启动命令'
}

/**
 * Read an optional non-empty string.
 * @param value - the raw config field.
 * @returns the trimmed string, or `undefined` when absent or blank.
 */
function nonEmptyString(value) {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Read an optional positive integer.
 * @param value - the raw config field.
 * @returns the integer, or `undefined` when absent or not positive.
 */
function positiveInteger(value) {
	return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Read an optional non-negative integer, where 0 means "never".
 * @param value - the raw config field.
 * @returns the integer, or `undefined` when absent or negative.
 */
function nonNegativeInteger(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
