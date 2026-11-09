/**
 * The search provider registered into ctx.web as "clinepass".
 *
 * It satisfies the seam's WebSearchProvider contract: a cheap local
 * availability check, then one search. Everything provider-specific - the
 * gateway tool id, the endpoint, the credential - is resolved per call, so a
 * model switch in the UI changes the next search without re-registering
 * anything.
 *
 * @module dsh-web-search-clinepass/provider
 */
import { WebError } from '@deepseek-ai/dsh-web';
import { PROVIDER_ID, normalizeConfig } from './config.js';
import { searchWithGateway } from './gateway.js';
import { resolveTarget } from './route.js';

/** Why a resolution attempt failed, in the user's terms. */
function unavailableMessage(config) {
	return 'clinepass web search cannot resolve a serviceable route: no model selection was available, or the selected route declares no OpenAI-compatible base URL and credential ref.'
		+ ' Expected an llm-pi-ai provider profile (baseURL, apiKeyEnv) for the session model, or an explicit provider/baseURL/apiKeyEnv (or routes entry) in the web-search-clinepass settings section.'
		+ (typeof config?.fallback?.provider === 'string' && typeof config?.fallback?.model === 'string' ? ' The configured fallback route "' + config.fallback.provider + '/' + config.fallback.model + '" could not be served either.' : '');
}

export class CurrentModelSearchProvider {
	/** Stable provider id; the bundle's web-row override names exactly this string. */
	id = PROVIDER_ID;

	/**
	 * @param ctx - the plugin context, used for the optional settings, credentials, agent, and launch-environment lookups.
	 * @param resolveConfig - thunk returning the currently authoritative section. A thunk rather than a value because the settings section can change between searches.
	 */
	constructor(ctx, resolveConfig) {
		this.ctx = ctx;
		this.resolveConfig = resolveConfig;
	}

	/**
	 * Cheap local usability check; never makes a network call.
	 * @returns whether a search could be attempted right now.
	 */
	available() {
		try {
			return resolveTarget(this.ctx, this.resolveConfig()) !== undefined;
		} catch {
			return false;
		}
	}

	/**
	 * Run one search through the session's currently selected model.
	 * @param request - the seam's request: one query and an optional result cap.
	 * @param signal - caller cancellation forwarded to the HTTP request.
	 * @returns the normalized search result.
	 * @throws {WebError} with a stable code when the route, the credential, or the endpoint fails.
	 */
	async search(request, signal) {
		const config = normalizeConfig(this.resolveConfig());
		const target = resolveTarget(this.ctx, config);
		if (target === undefined) throw new WebError(unavailableMessage(config), 'WEB_PROVIDER_UNAVAILABLE');
		const query = typeof request?.query === 'string' ? request.query.trim() : '';
		if (query.length === 0) throw new WebError('clinepass search needs a non-empty query', 'WEB_PROVIDER_ERROR');
		const configuredCap = Number.isInteger(config.maxSources) && config.maxSources > 0 ? config.maxSources : 10;
		const requestedCap = Number.isInteger(request?.maxResults) && request.maxResults > 0 ? request.maxResults : configuredCap;
		const result = await searchWithGateway({
			ctx: this.ctx,
			config,
			target,
			query,
			signal,
			maxSources: Math.min(configuredCap, requestedCap),
		});
		// No session event is written on purpose. DSH persists the session log
		// fail-closed: the read path refuses any event type outside
		// KNOWN_SESSION_EVENT_TYPES unless its envelope carries ignorable:true, and
		// an out-of-repo plugin cannot set that marker because Session.append()
		// accepts only surface metadata as its third argument. Appending a custom
		// type here would make the session unloadable on its next resume, so a
		// search stays a pure read of the seam and writes nothing durable.
		return { content: result.content, sources: result.sources, truncated: false };
	}
}

export default CurrentModelSearchProvider;
