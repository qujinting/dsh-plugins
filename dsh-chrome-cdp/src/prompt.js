/**
 * The routing rule this plugin adds to every session's system prompt.
 *
 * The user's global `AGENTS.md` already says "when you need to see a page, use
 * chrome-cdp" — but a global memory file is one line among many, and it points
 * at a skill whose availability depends on the profile's skill provider. A
 * short section owned by the plugin that *ships* the capability makes the route
 * survive a different machine, a different preset, or a missing memory file.
 *
 * @module dsh-chrome-cdp/prompt
 */

/** Stable section name; unique in the global layer so nothing shadows it. */
export const PROMPT_SECTION_NAME = 'chrome-cdp:routing'

/**
 * Placement, chosen to sit with the other tool-owned sections (LSP is 2200,
 * session query 2300) rather than at either end of the prompt.
 */
export const PROMPT_SECTION_ORDER = 2250

/**
 * Build the section text.
 * @param options - resolved plugin options.
 * @param options.toolName - the registered tool name, quoted back to the model.
 * @returns the prompt section body.
 */
export function promptSectionText(options) {
	return [
		'## Seeing a real page',
		'',
		`When an answer depends on what a page actually renders — visual acceptance of a front-end change (layout, spacing, dark mode, responsive breakpoints), a "look at it yourself" request, or any rendering claim you would otherwise have to guess at — call the \`${options.toolName}\` tool.`,
		`It drives this machine's own Chrome over the DevTools Protocol: it opens the URL, runs your \`script\` inside the page for real box-model measurements, and writes a PNG. Follow it with \`read_image\` on the returned path — measurements alone do not show that a layout looks wrong.`,
		'',
		'Rules that matter:',
		'',
		'- Do not ask the user to paste a screenshot when you can take one yourself.',
		'- Do not install Playwright, Puppeteer, or any browser-automation dependency to look at a page.',
		`- Prefer \`${options.toolName}\` over a hand-written CDP probe; reach for a probe only when one call cannot express what you need. Load the \`chrome-cdp\` skill for the full playbook, including login flows, dark-mode switching, and the failure modes already hit in practice.`,
	].join('\n')
}
