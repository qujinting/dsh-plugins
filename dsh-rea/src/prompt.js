/**
 * The routing rule this plugin adds to every session's system prompt.
 *
 * REA's 229 tools are deliberately absent from the tool list; without a line
 * saying so, a model that needs them either never discovers them or spends the
 * turn speculating about what it cannot see. One short section is enough: what
 * the gateway is for, and the two-call shape that reaches it.
 *
 * @module dsh-rea/prompt
 */

/** Stable section name; unique in the global layer so nothing shadows it. */
export const PROMPT_SECTION_NAME = 'rea:routing'

/**
 * Placement, just after chrome-cdp's routing section (2250) and before the
 * remaining tool-owned sections, so capability routing reads together.
 */
export const PROMPT_SECTION_ORDER = 2260

/**
 * Build the section text.
 * @param options - resolved plugin options.
 * @param options.toolsToolName - the catalog tool's registered name.
 * @param options.callToolName - the dispatcher tool's registered name.
 * @returns the prompt section body.
 */
export function promptSectionText(options) {
	return [
		'## Reverse engineering with REA',
		'',
		`When the task is to explain what a shipped artifact actually does — a native binary, an Electron or packaged app, a web bundle, firmware, an APK/IPA, a protocol capture, or a live runtime — you have REA behind the \`${options.callToolName}\` tool.`,
		`Its catalog of 229 tools is intentionally not in this request's tool list, so that ordinary sessions do not pay for schemas they never use. Reach it in two calls: \`${options.toolsToolName}\` with a keyword to find the right tool and read its input schema, then \`${options.callToolName}\` with that exact name and arguments.`,
		'',
		'- Search before guessing: an invented tool name is rejected, and the catalog row carries the arguments the tool needs.',
		'- Give REA real absolute paths and real targets; it reports measured facts, and those are the only evidence worth reporting.',
		'- A decompile, provider startup, or runtime trace can take minutes. That is normal for one call — do not fan out parallel exploratory calls to compensate.',
	].join('\n')
}
