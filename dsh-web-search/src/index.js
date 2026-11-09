/**
 * dsh-web-search - a ctx.web search provider that searches with the
 * session's currently selected model instead of one hardcoded endpoint.
 *
 * Replaces the shipped deepseek-official search provider: instead of calling
 * DeepSeek's own Anthropic-compatible Messages endpoint with a fixed model, it
 * sends one OpenAI-compatible chat completion to whichever route the session
 * selected, attaching a provider-executed search tool (vercel:perplexity_search
 * and friends) that the gateway runs server-side. The search therefore rides
 * the user's selected provider and credential, and its own quota.
 *
 * Requires dsh 0.2.x; see `engines.dsh` in package.json. Settings ARE the
 * plugin's own Config entry on that line: the loader parses the fields marked
 * volatile() in config.js into stable references, mutates them in place when a
 * settings write lands, and the provider reads through them on every search -
 * so an edit takes effect without a restart.
 *
 * `configure({ auto: false }, fiber)` says this plugin ships its own card
 * (lib/client.js) instead of letting the client generate one from the schema.
 *
 * A search writes nothing durable; provider.js records why no session event may
 * be appended from here.
 *
 * @module dsh-web-search
 */
import { Config, PROVIDER_ID } from './config.js';
import { CurrentModelSearchProvider } from './provider.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-web-search';
/** The web seam this provider registers into. */
export const inject = ['web'];
export { Config, CurrentModelSearchProvider, PROVIDER_ID };

/**
 * The provider id the web seam would select right now.
 *
 * The seam reads `web.searchProvider` (a volatile reference the loader keeps
 * live) and falls back to `$DSH_WEB_SEARCH_PROVIDER`; with neither, it selects
 * the only usable provider and refuses to guess when several are usable.
 *
 * @param ctx - the plugin context.
 * @returns the configured id, or undefined when nothing names one.
 */
export function selectedSearchProvider(ctx) {
	let field;
	try {
		field = ctx?.web?.config?.searchProvider;
	} catch {
		return undefined;
	}
	let configured;
	if (typeof field === 'string') configured = field;
	else if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
		try {
			configured = field.get();
		} catch {
			configured = undefined;
		}
	}
	if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim();
	const fromEnv = typeof process === 'object' ? process.env?.DSH_WEB_SEARCH_PROVIDER : undefined;
	return typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv.trim() : undefined;
}

/**
 * Explain why this provider is registered but unused, if that is the case.
 *
 * Provider selection is explicit-id-first, so a `web.searchProvider` that names
 * another provider wins over this one's registration without any error: searches
 * silently succeed through that other provider. The built-in web-search settings
 * page writes exactly that field when its Search API switch is toggled, which is
 * the way this plugin gets shadowed in practice - so say so in the log instead
 * of leaving a working install that never runs.
 *
 * @param ctx - the plugin context.
 * @returns the warning text, or undefined when this provider is the selected one.
 */
export function selectionWarning(ctx) {
	const selected = selectedSearchProvider(ctx);
	if (selected === undefined || selected === PROVIDER_ID) return undefined;
	return 'web.searchProvider is "' + selected + '", so web_search is served by that provider and "' + PROVIDER_ID + '" is registered but unused.'
		+ ' The built-in web-search settings page writes this field; point it back at "' + PROVIDER_ID + '"'
		+ ' (profile cordis.patch.yml: `- id: web` / `searchProvider: ' + PROVIDER_ID + '`) to search through this plugin.';
}

/** Report a shadowed selection once per configuration change. */
function reportSelection(ctx) {
	const warning = selectionWarning(ctx);
	if (warning !== undefined) ctx.logger?.warn?.(warning);
}

/**
 * Register the clinepass search provider with ctx.web, and tell the settings
 * service that this plugin draws its own card.
 *
 * The settings child is optional: without a settings service the provider still
 * answers from the composition entry, which is the same object the loader keeps
 * live once a write lands.
 * @param ctx - the plugin context.
 * @param config - the composition entry's validated configuration.
 */
export function apply(ctx, config) {
	ctx.inject(['settings'], (settingsCtx) => {
		const settings = settingsCtx.settings;
		if (settings === null || settings === undefined) return;
		if (typeof settings.configure !== 'function') return;
		settings.configure({ auto: false }, ctx.fiber);
	});
	ctx.web.registerSearchProvider(new CurrentModelSearchProvider(ctx, () => config));
	reportSelection(ctx);
	// `web` is a volatile Config entry, so a settings write mutates the live
	// reference instead of remounting this row: re-read it on every update to
	// catch the built-in page taking the selection away mid-session. Cordis
	// contexts always expose `on`; the guard keeps a bare test double working.
	if (typeof ctx.on === 'function') {
		ctx.on('settings/updated', (ns) => {
			if (ns === 'web') reportSelection(ctx);
		});
	}
}
