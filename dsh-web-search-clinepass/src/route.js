/**
 * Resolving one search request to an endpoint, a credential, and a model.
 *
 * The provider deliberately answers "which model?" from the live session
 * rather than from its own configuration, and "which endpoint?" from the
 * settings section that owns that route, so a search always follows the model
 * the user has selected in the UI. The lookup order is:
 *
 *   1. this plugin's own section (explicit pins win),
 *   2. the session's current request header, then the agent's creation options,
 *      then the agent-default-model setting,
 *   3. the llm-pi-ai settings namespace for that route's endpoint and key ref.
 *
 * Steps 2 and 3 read namespaces this plugin does not own, through whichever read
 * path the mounted settings service has (0.1.5's get(ns) or 0.1.7's describe()
 * projection) - see {@link readSettings}.
 *
 * @module dsh-web-search-clinepass/route
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { DEFAULT_TOOL, normalizeConfig } from './config.js';

/** Wire protocols that speak OpenAI chat completions, the only shape this provider sends. */
const OPENAI_CHAT_APIS = new Set([
	'openai-completions',
	'openai-chat-completions',
	'openai-compatible',
	'openai',
	'chat-completions',
]);

/** First argument that is a non-empty string. */
function firstText(...values) {
	for (const value of values) if (typeof value === 'string' && value.trim().length > 0) return value.trim();
	return undefined;
}

/**
 * Whether a declared wire protocol can carry an OpenAI chat-completions body.
 * @param api - the route's declared protocol, if any.
 * @returns true for a compatible protocol, false for a declared incompatible one, undefined when nothing is declared.
 */
export function isOpenAiChatApi(api) {
	if (typeof api !== 'string' || api.trim().length === 0) return undefined;
	return OPENAI_CHAT_APIS.has(api.trim().toLowerCase());
}

/**
 * Read one namespace out of the dsh 0.1.7 settings projection.
 *
 * There the service owns no per-namespace accessor: a section IS a plugin Config
 * entry, and `describe()` is the only read path - the same call the settings page
 * makes. Each row carries the entry id as `ns` and its live value as `value`, with
 * volatile references already flattened, so a plain object type check is enough.
 *
 * @param settings - the settings service.
 * @param ns - the entry id to look for.
 * @returns the namespace's current value, or undefined.
 */
function describedSettings(settings, ns) {
	if (typeof settings.describe !== 'function') return undefined;
	const rows = settings.describe();
	if (!Array.isArray(rows)) return undefined;
	const value = rows.find((row) => row?.ns === ns)?.value;
	return value === null || typeof value !== 'object' ? undefined : value;
}

/**
 * Read one registered settings namespace, tolerating an absent settings service
 * or namespace.
 *
 * The two harness settings models expose different read paths, so this asks
 * whichever one is mounted, exactly like `apply()` does for the write side:
 * 0.1.5 served `get(ns)` for every installed section, 0.1.7 replaced it with the
 * `describe()` projection and has no `get` at all. Missing this is not a graceful
 * degradation: `llm-pi-ai` supplies the route's `baseURL` and `apiKeyEnv`, so a
 * read that always fails makes the provider report itself unavailable and every
 * `web_search` fails with WEB_PROVIDER_CONFIGURED_UNAVAILABLE.
 *
 * @param ctx - the plugin context.
 * @param ns - the settings namespace (the owning profile entry id on 0.1.7).
 * @returns the namespace's current value, or undefined when nothing serves it.
 */
export function readSettings(ctx, ns) {
	const settings = ctx.get('settings');
	if (settings === undefined || settings === null) return undefined;
	try {
		if (typeof settings.get === 'function') {
			const value = settings.get(ns);
			if (value !== null && typeof value === 'object') return value;
		}
		return describedSettings(settings, ns);
	} catch {
		return undefined;
	}
}

/**
 * The provider/model the current session is actually using.
 *
 * The request header is the strongest signal: it is the header committed for
 * the step that issued this tool call, so a mid-session model switch is already
 * reflected. The agent's own creation options come next, and the deployment
 * default last.
 *
 * @param ctx - the plugin context, used only for optional lookups.
 * @returns the selection and where it came from, or undefined.
 */
export function sessionModelSelection(ctx) {
	let agent;
	try {
		agent = ctx.get('agents')?.currentInitiator?.();
	} catch {
		agent = undefined;
	}
	let header;
	try {
		header = agent?.session?.requestHeader?.()?.config;
	} catch {
		header = undefined;
	}
	if (typeof header?.provider === 'string' && typeof header?.model === 'string') {
		return { provider: header.provider, model: header.model, source: 'session request header' };
	}
	const options = agent?.options;
	if (typeof options?.provider === 'string' && typeof options?.model === 'string') {
		return { provider: options.provider, model: options.model, source: 'agent options' };
	}
	const fallback = readSettings(ctx, 'agent-default-model');
	if (typeof fallback?.provider === 'string' && typeof fallback?.model === 'string') {
		return { provider: fallback.provider, model: fallback.model, source: 'agent-default-model setting' };
	}
	return undefined;
}

/** Join a configured base URL with the chat-completions path without doubling it. */
export function chatCompletionsUrl(baseURL) {
	const trimmed = String(baseURL).trim().replace(/\/+$/u, '');
	if (/\/chat\/completions$/iu.test(trimmed)) return trimmed;
	return trimmed + '/chat/completions';
}

/**
 * Build the usable target for one provider/model pair.
 * @param ctx - context for the settings and launch-environment lookups.
 * @param config - the resolved plugin section.
 * @param selection - the provider/model pair to resolve.
 * @returns a target, or undefined when the pair cannot be served.
 */
function targetFor(ctx, config, selection) {
	const provider = selection.provider;
	const routeOverride = (config.routes ?? {})[provider] ?? {};
	const piAi = readSettings(ctx, 'llm-pi-ai')?.providers?.[provider];
	const baseURL = firstText(config.baseURL, routeOverride.baseURL, piAi?.baseURL);
	const api = firstText(config.api, routeOverride.api, piAi?.api);
	const apiKeyEnv = firstText(config.apiKeyEnv, routeOverride.apiKeyEnv, piAi?.apiKeyEnv);
	const apiKey = firstText(config.apiKey, routeOverride.apiKey);
	const tool = firstText(config.tool, routeOverride.tool) ?? DEFAULT_TOOL;
	if (isOpenAiChatApi(api) === false) return undefined;
	if (baseURL === undefined) return undefined;
	try {
		if (!URL.canParse(baseURL)) return undefined;
	} catch {
		return undefined;
	}
	if (apiKey === undefined && apiKeyEnv === undefined) return undefined;
	const headers = {};
	for (const source of [piAi?.headers, routeOverride.headers, config.headers]) {
		if (source === null || typeof source !== 'object') continue;
		for (const [key, value] of Object.entries(source)) if (typeof value === 'string') headers[key] = value;
	}
	return {
		provider,
		model: selection.model,
		api,
		baseURL,
		endpoint: chatCompletionsUrl(baseURL),
		apiKey,
		apiKeyEnv,
		tool,
		headers,
		source: selection.source,
	};
}

/**
 * Resolve the search target: the configured or session-selected route first, then
 * the pinned fallback route when that pair cannot be served.
 *
 * @param ctx - plugin context.
 * @param config - the resolved plugin section.
 * @returns the target to search with, or undefined when nothing is serviceable.
 */
export function resolveTarget(ctx, config) {
	// One boundary for the two config shapes: 0.1.7 parses editable fields into
	// live references, 0.1.5 leaves them plain, and a plain object passes through.
	const section = normalizeConfig(config);
	if (section.enabled === false) return undefined;
	const selected = sessionModelSelection(ctx);
	const pinned = firstText(section.provider, section.model) !== undefined;
	const provider = firstText(section.provider, selected?.provider);
	const model = firstText(section.model, selected?.model);
	if (provider !== undefined && model !== undefined) {
		const target = targetFor(ctx, section, { provider, model, source: pinned ? 'configuration' : (selected?.source ?? 'session') });
		if (target !== undefined) return target;
	}
	const fallback = section.fallback;
	if (typeof fallback?.provider === 'string' && typeof fallback?.model === 'string') {
		return targetFor(ctx, section, { provider: fallback.provider, model: fallback.model, source: 'configured fallback' });
	}
	return undefined;
}

/**
 * Resolve the credential for one target: the literal from configuration, then the
 * credentials service, then the launching environment.
 *
 * @param ctx - plugin context.
 * @param target - the resolved target naming apiKey or apiKeyEnv.
 * @returns the credential value, or undefined when nothing is configured.
 */
export async function resolveApiKey(ctx, target) {
	if (typeof target.apiKey === 'string' && target.apiKey.length > 0) return target.apiKey;
	const name = target.apiKeyEnv;
	if (typeof name !== 'string' || name.length === 0) return undefined;
	let ref;
	try {
		ref = credentialRef(name);
	} catch {
		return undefined;
	}
	try {
		const resolved = await ctx.get('credentials')?.resolve?.(ref);
		if (typeof resolved?.value === 'string' && resolved.value.length > 0) return resolved.value;
	} catch {
		/* fall through to the launching environment */
	}
	try {
		const ambient = launchEnvironmentOf(ctx).get(name);
		if (typeof ambient?.value === 'string' && ambient.value.length > 0) return ambient.value;
	} catch {
		/* nothing ambient to read */
	}
	return undefined;
}
