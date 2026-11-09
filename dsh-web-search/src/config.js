/**
 * Configuration schema for the clinepass web-search provider.
 *
 * Every field is optional: with an empty section the provider follows the
 * session's currently selected model and resolves that model's endpoint and
 * credential from the llm-pi-ai settings namespace (which is what the Web
 * Models page writes). The remaining fields exist for deployments whose route
 * cannot be inferred that way, and for cost control.
 *
 * @module dsh-web-search/config
 */
import z from '@deepseek-ai/schemastery';

/** Provider id registered with ctx.web. Referenced by this bundle's web-row override. */
export const PROVIDER_ID = 'clinepass';

/**
 * Search tools a Vercel AI Gateway accepts in one tools[] entry on its
 * Chat Completions API. They are executed by the gateway, not by the model, so
 * the transcript stays one assistant turn instead of a tool-call round trip the
 * harness would have to answer itself.
 *
 * Vercel documents exactly these four server-tool types for this API format:
 * perplexity, exa, and tako take a query, parallel takes an objective, and
 * gateway.js fills that field in per search. Browserbase's search tools are
 * documented for the AI SDK surface only; a live probe against the ClinePass
 * gateway accepted the id but returned no citation list at roughly six times the
 * cost, so this provider does not offer it.
 */
export const GATEWAY_SEARCH_TOOLS = [
	'vercel:perplexity_search',
	'vercel:exa_search',
	'vercel:parallel_search',
	'vercel:tako_search',
];

/** Tool used when the section names none. */
export const DEFAULT_TOOL = 'vercel:perplexity_search';

/** Per-LLM-route endpoint and credential overrides, keyed by LLM provider route id. */
const RouteOverride = z.object({
	/** Wire protocol of this route, used to reject routes that cannot carry tools[]. */
	api: z.string(),
	/** Chat-completions base URL, including the version segment (for example https://api.cline.bot/api/v1). */
	baseURL: z.string(),
	/** Environment-variable name resolved through ctx.credentials per search. */
	apiKeyEnv: z.string().role('credential-ref'),
	/** Literal credential; takes precedence over apiKeyEnv. */
	apiKey: z.string().role('secret'),
	/** Extra request headers for this route. */
	headers: z.dict(z.string()),
	/** Provider-executed search tool id for this route. */
	tool: z.string(),
});

/**
 * A pinned provider/model pair used when the session's own selection cannot be
 * served, for example after the user switches to a model whose route is not an
 * OpenAI-compatible gateway.
 */
const Fallback = z.object({
	/** LLM provider route to fall back to; set together with model. */
	provider: z.string(),
	/** Model id to fall back to; set together with provider. */
	model: z.string(),
});

/**
 * Read one parsed config field.
 *
 * A field marked volatile parses into a stable reference whose live value comes
 * from `get()`; an ordinary field is its value. The loader mutates those
 * references in place when a settings write lands, so reading through them on
 * every search is what makes an edit take effect without a restart.
 * @param field - one parsed field.
 * @returns its current value.
 */
export function fieldValue(field) {
	return field !== null && typeof field === 'object' && typeof field.get === 'function' ? field.get() : field;
}

/**
 * Project a parsed Config onto plain values.
 *
 * Reads the fields through {@link fieldValue}, so the loader's volatile
 * references and a plain section (a test fixture, or a section handed in by
 * anything that predates them) both answer plain values. Every provider path
 * normalizes once at its boundary rather than unwrapping refs at each use.
 * @param config - the loader-validated Config, or a plain section.
 * @returns the same fields as plain values.
 */
export function normalizeConfig(config) {
	if (config === null || typeof config !== 'object') return {};
	const plain = {};
	for (const [key, value] of Object.entries(config)) plain[key] = fieldValue(value);
	return plain;
}

/**
 * The card edits the volatile fields. Every other field stays ordinary
 * configuration, editable through the profile's Cordis patch instead of a form.
 */
export const Config = z.object({
	/** Master switch. false makes the provider report itself unavailable. */
	enabled: z.boolean().default(true).volatile(),
	/** Force an LLM provider route instead of following the session. */
	provider: z.string().volatile(),
	/** Force a model id instead of following the session. */
	model: z.string().volatile(),
	/** Chat-completions base URL; overrides route and llm-pi-ai resolution. */
	baseURL: z.string(),
	/** Wire protocol guard for a forced baseURL. */
	api: z.string(),
	/** Credential ref for a forced baseURL. */
	apiKeyEnv: z.string().role('credential-ref'),
	/** Literal credential; takes precedence over apiKeyEnv. */
	apiKey: z.string().role('secret'),
	/** Extra request headers, merged over route and llm-pi-ai headers. */
	headers: z.dict(z.string()),
	/** Per-LLM-route overrides. */
	routes: z.dict(RouteOverride).default({}),
	/** Provider/model pair pinned for the fallback path. */
	fallback: Fallback,
	/** Provider-executed search tool id sent in tools[]. */
	tool: z.string().default(DEFAULT_TOOL).volatile(),
	/** Request timeout in milliseconds; one search is a full model turn. */
	timeoutMs: z.number().step(1).min(1000).default(90000).volatile(),
	/**
	 * Upper bound on generated tokens for the search turn. 8192 is twice what a
	 * dense answer with a source list actually needs (measured 3535 and 4176
	 * completion tokens for one quote/table question, reasoning included), which
	 * leaves room for a tabular answer without letting a runaway one bloat the
	 * calling agent's context - the answer becomes that agent's input on every
	 * later turn.
	 */
	maxTokens: z.number().step(1).min(1).default(8192).volatile(),
	/** Sampling temperature; omitted from the request while unset. */
	temperature: z.number(),
	/** Upper bound on sources returned to the seam (the seam caps again). */
	maxSources: z.number().step(1).min(1).default(10).volatile(),
	/** Extra guidance appended to the search instruction. */
	instructions: z.string().volatile(),
});

export default Config;
