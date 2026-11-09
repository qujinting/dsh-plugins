/**
 * dsh-web-search-clinepass - a ctx.web search provider that searches with the
 * session's currently selected model instead of one hardcoded endpoint.
 *
 * Replaces the shipped deepseek-official search provider: instead of calling
 * DeepSeek's own Anthropic-compatible Messages endpoint with a fixed model, it
 * sends one OpenAI-compatible chat completion to whichever route the session
 * selected, attaching a provider-executed search tool (vercel:perplexity_search
 * and friends) that the gateway runs server-side. The search therefore rides
 * the user's selected provider and credential, and its own quota.
 *
 * Settings have two shapes, because the harness changed its own:
 *
 * - dsh 0.1.7: a plugin's Config entry IS its settings section. `configure({
 *   auto: false })` says this plugin ships its own page instead of letting a
 *   client generate one from the schema, and the fields marked volatile in
 *   config.js are the ones that page edits; the loader keeps their references
 *   live, so the provider reads fresh values on every search. dsh 0.2.0-rc.2
 *   keeps this model unchanged, so this branch serves it too.
 * - dsh 0.1.5: the settings service owns plugin sections, so the same schema is
 *   installed as a section under SETTINGS_NAMESPACE, and the section becomes the
 *   authoritative source while it exists.
 *
 * The two are told apart by which method the settings service has; neither
 * branch can run on the other harness, and the provider itself is identical.
 *
 * @module dsh-web-search-clinepass
 */
import { Config, PROVIDER_ID } from './config.js';
import { CurrentModelSearchProvider } from './provider.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-clinepass';
/** The web seam this provider registers into. */
export const inject = ['web'];
/** Settings namespace this plugin's card edits, on either harness. */
export const SETTINGS_NAMESPACE = 'web-search-clinepass';
export { Config, CurrentModelSearchProvider, PROVIDER_ID };

/**
 * Read one config field.
 *
 * A field marked volatile (see config.js) parses into a stable reference whose
 * live value comes from `get()`; an ordinary field is its value. Once the
 * loader commits a volatile update it mutates the running fiber's config, so
 * reading through the same object on every search is what makes a settings edit
 * take effect without a restart.
 * @param field - the parsed config field.
 * @returns its current value.
 */
export function fieldValue(field) {
	return field !== null && typeof field === 'object' && typeof field.get === 'function' ? field.get() : field;
}

/**
 * Project the entry's Config onto plain values.
 *
 * The 0.1.5 branch hands this object to installSection as the composition
 * fallback: the old service validates and stores what it is given, so it must
 * never receive volatile references, which only the 0.1.7 loader understands.
 * @param config - the loader-validated Config of this entry.
 * @returns the same fields as plain values.
 */
export function readConfig(config) {
	const source = config !== null && typeof config === 'object' ? config : {};
	return {
		enabled: fieldValue(source.enabled),
		provider: fieldValue(source.provider),
		model: fieldValue(source.model),
		tool: fieldValue(source.tool),
		timeoutMs: fieldValue(source.timeoutMs),
		maxTokens: fieldValue(source.maxTokens),
		maxSources: fieldValue(source.maxSources),
		instructions: fieldValue(source.instructions),
		baseURL: source.baseURL,
		api: source.api,
		apiKeyEnv: source.apiKeyEnv,
		apiKey: source.apiKey,
		headers: source.headers,
		routes: source.routes,
		fallback: source.fallback,
		temperature: source.temperature,
	};
}

/**
 * Register the clinepass search provider with ctx.web, and wire whichever
 * settings model the running harness has.
 *
 * The settings child is optional in both models: without a settings service the
 * provider still answers from the composition entry, which is exactly the
 * fallback path.
 * @param ctx - the plugin context.
 * @param config - the composition entry's validated configuration.
 */
export function apply(ctx, config) {
	/** Section resolved by the 0.1.5 settings service; absent on 0.1.7. */
	let section;
	const current = () => (section !== undefined ? section : readConfig(config));
	ctx.inject(['settings'], (settingsCtx) => {
		const settings = settingsCtx.settings;
		if (settings === null || settings === undefined) return;
		if (typeof settings.configure === 'function') {
			// 0.1.7: this entry's own Config is the section, and this plugin draws
			// its own page, so the automatic one stays off.
			settings.configure({ auto: false }, ctx.fiber);
			return;
		}
		if (typeof settings.installSection === 'function') {
			// 0.1.5: a plugin-owned section under this plugin's own namespace.
			settings.installSection(ctx, SETTINGS_NAMESPACE, Config, readConfig(config), {
				setSource(source) {
					section = source;
				},
				onChange() {},
			});
		}
	});
	ctx.web.registerSearchProvider(new CurrentModelSearchProvider(ctx, current));
}
