/**
 * dsh-chrome-cdp — give every DSH session the ability to look at a real page,
 * without anyone having to ask for it.
 *
 * The problem this solves is not "the agent cannot use CDP"; it is that the
 * agent never reaches for it. A line in a global memory file saying "use the
 * chrome-cdp skill" only works if that skill actually reaches the session
 * catalog, and in a Web/Desktop profile the catalog comes from an agent preset
 * whose skill provider can fail or be reconfigured without anyone noticing —
 * leaving the instruction pointing at a skill the model cannot load. Nothing
 * errors; the agent simply never looks at the page.
 *
 * So the plugin ships the capability itself, in the three shapes a model
 * actually notices:
 *
 * 1. A real tool, `chrome_cdp`. Tools are in the request catalog every step;
 *    a skill is only consulted when the model decides to consult it. This is
 *    the part that makes the behaviour automatic.
 * 2. The `chrome-cdp` skill, registered into the skill registry's global layer
 *    so it lands in every session's catalog regardless of preset, root layout,
 *    or frontmatter parsing. It carries the long-form playbook.
 * 3. One short system-prompt section that states the routing rule, so the
 *    behaviour does not depend on the user's memory file surviving a move to
 *    another machine.
 *
 * Everything is dependency-free: the driver talks CDP over Node's built-in
 * `fetch` and `WebSocket`, and this package imports nothing from
 * `@deepseek-ai/*`, which a profile-installed plugin cannot resolve anyway.
 *
 * @module dsh-chrome-cdp
 */
import { resolveBrowserExecutable } from './cdp.js'
import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, promptSectionText } from './prompt.js'
import { CHROME_CDP_SKILL } from './skill.js'
import { chromeCdpTool } from './tool.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-chrome-cdp'

/**
 * The host-plane services this plugin contributes to. `skills` is deliberately
 * absent: it is reached through an optional `ctx.inject`, so a composition that
 * mounts no skill registry still gets the tool.
 */
export const inject = ['tools', 'systemPrompt']

/**
 * Project the loader-validated config onto plain values with defaults.
 *
 * A missing or partial config is the normal case, so every field is optional
 * and every default is the behaviour the tool description promises.
 * @param config - the composition entry's configuration, as validated by the loader.
 * @returns resolved plugin options.
 */
export function readOptions(config) {
	const source = config !== null && typeof config === 'object' ? config : {}
	return {
		toolName: nonEmptyString(source.toolName) ?? 'chrome_cdp',
		browserPath: nonEmptyString(source.browserPath),
		profileRoot: nonEmptyString(source.profileRoot),
		screenshotDir: nonEmptyString(source.screenshotDir),
		headless: source.headless ?? true,
		timeoutMs: Number.isSafeInteger(source.timeoutMs) && source.timeoutMs > 0 ? source.timeoutMs : 60_000,
		registerSkill: source.registerSkill ?? true,
		registerPromptSection: source.registerPromptSection ?? true,
	}
}

/**
 * Register the tool, the skill, and the routing section.
 * @param ctx - the plugin context.
 * @param config - the composition entry's validated configuration.
 */
export function apply(ctx, config) {
	const options = readOptions(config)

	if (options.registerPromptSection) {
		ctx.effect(
			() => ctx.systemPrompt.section({
				name: PROMPT_SECTION_NAME,
				order: PROMPT_SECTION_ORDER,
				text: promptSectionText(options),
			}),
			'chrome-cdp.promptSection()',
		)
	}

	ctx.effect(() => ctx.tools.register(chromeCdpTool(options)), 'chrome-cdp.tool()')

	if (options.registerSkill) {
		// Optional: a composition may mount the tool registry without a skill registry.
		ctx.inject(['skills'], (skillCtx) => {
			if (skillCtx.skills === undefined || skillCtx.skills === null) return
			skillCtx.effect(() => skillCtx.skills.register(CHROME_CDP_SKILL), 'chrome-cdp.skill()')
		})
	}

	// Resolving the browser at load time turns a silent no-op into a diagnosable
	// log line; the tool itself still resolves per call, so installing a browser
	// later needs no reload.
	try {
		ctx.logger?.info?.(`chrome-cdp: using browser ${resolveBrowserExecutable(options.browserPath)}`)
	} catch (error) {
		ctx.logger?.warn?.(`chrome-cdp: ${error.message}`)
	}
}

/**
 * Read an optional non-empty string.
 * @param value - the raw config field.
 * @returns the trimmed string, or `undefined` when it is absent or blank.
 */
function nonEmptyString(value) {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	return trimmed.length === 0 ? undefined : trimmed
}
