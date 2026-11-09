/**
 * The one HTTP call this provider makes: an OpenAI-compatible chat completion
 * carrying a provider-executed search tool.
 *
 * The wire format is gateway-private by design, exactly as the shipped
 * DeepSeek search provider's Anthropic Messages call is: the harness tool
 * contract stays provider-neutral, so the adapter that knows a gateway's
 * native tool ids owns them. A search is one assistant turn - the gateway runs
 * the search server-side and folds the results into that same message.
 *
 * @module dsh-web-search-clinepass/gateway
 */
import { WebError } from '@deepseek-ai/dsh-web';
import { buildSearchInstruction, SEARCH_SYSTEM_PROMPT } from './prompt.js';
import { parseSearchAnswer, cleanUrl } from './parse.js';
import { resolveApiKey } from './route.js';
import { normalizeConfig } from './config.js';

/** Attribution header sent on every request. */
const USER_AGENT = 'dsh-web-search-clinepass/0.3.2';

/** True for a fetch or AbortSignal abort. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === 'AbortError';
}

/** Flatten a provider error body into one readable sentence. */
function describeErrorBody(text, status) {
	const raw = typeof text === 'string' ? text.trim() : '';
	if (raw.length === 0) return 'HTTP ' + status;
	try {
		const parsed = JSON.parse(raw);
		const detail = parsed?.error;
		if (typeof detail === 'string' && detail.length > 0) return detail;
		if (typeof detail?.message === 'string' && detail.message.length > 0) return detail.message;
		if (typeof parsed?.message === 'string' && parsed.message.length > 0) return parsed.message;
	} catch {
		/* not JSON; fall through to the raw body */
	}
	return raw.length > 600 ? raw.slice(0, 600) + '...' : raw;
}

/** One request's endpoint guidance, appended to failures that reached the network. */
function endpointHint(target) {
	return 'The search request used endpoint ' + JSON.stringify(target.endpoint) + ' for model ' + JSON.stringify(target.model)
		+ ' (route "' + target.provider + '", model selected from the ' + target.source + ').'
		+ ' Search endpoint configuration is separate from chat; if that route or endpoint is not intended, pin provider/model/baseURL/apiKeyEnv in the web-search-clinepass settings section.';
}

/** Concatenate every text part of a message content value. */
function messageText(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	const parts = [];
	for (const part of content) {
		if (typeof part === 'string') parts.push(part);
		else if (typeof part?.text === 'string') parts.push(part.text);
	}
	return parts.join('\n');
}

/** Structured citation annotations, when a gateway supplies them instead of prose links. */
function annotationSources(message) {
	const annotations = Array.isArray(message?.annotations) ? message.annotations : [];
	const sources = [];
	for (const entry of annotations) {
		const citation = entry?.url_citation ?? entry;
		const url = cleanUrl(citation?.url);
		if (url === undefined) continue;
		const title = typeof citation?.title === 'string' && citation.title.length > 0 ? citation.title : undefined;
		sources.push(title === undefined ? { url } : { url, title });
	}
	return sources;
}

/** Merge annotation-backed sources ahead of text-parsed ones, deduplicated by URL. */
function mergeSources(primary, secondary, maxSources) {
	const merged = [];
	const seen = new Set();
	for (const source of [...primary, ...secondary]) {
		if (source === null || typeof source !== 'object') continue;
		const url = cleanUrl(source.url);
		if (url === undefined || seen.has(url)) continue;
		seen.add(url);
		merged.push({ ...source, url });
		if (merged.length >= maxSources) break;
	}
	return merged;
}

/**
 * Per-tool keys the gateway's Chat Completions server-tool format expects. The
 * first is the field the tool cannot run without - Vercel's own table requires
 * a query for perplexity, exa, and tako, and an objective for parallel - and the
 * second, where the tool has one, is how many results it may return.
 */
const TOOL_CONFIG = {
	'vercel:perplexity_search': { input: 'query', results: 'max_results' },
	'vercel:exa_search': { input: 'query', results: 'num_results' },
	'vercel:parallel_search': { input: 'objective', results: 'max_results' },
	'vercel:tako_search': { input: 'query' },
};

/**
 * Build the one tools[] entry for a search, carrying this search's own input as
 * the gateway's developer default.
 *
 * The gateway otherwise lets the model invent the search input, which turns one
 * question into several differently-worded searches; stating it here keeps the
 * retrieval anchored to the query the harness actually received. A tool id this
 * table does not describe is sent bare, exactly as before, because inventing a
 * config for an unknown schema is how a request starts failing.
 *
 * @param tool - the provider-executed tool id.
 * @param query - the query the model-facing tool received.
 * @param maxResults - result cap to ask the search backend for.
 * @returns the tools[] entry.
 */
export function toolEntry(tool, query, maxResults) {
	const spec = Object.prototype.hasOwnProperty.call(TOOL_CONFIG, tool) ? TOOL_CONFIG[tool] : undefined;
	if (spec === undefined) return { type: tool };
	const config = { [spec.input]: query };
	if (spec.results !== undefined && Number.isInteger(maxResults) && maxResults > 0) config[spec.results] = maxResults;
	return { type: tool, config };
}

/**
 * Run one search through the selected route's chat-completions endpoint.
 *
 * @param options - the plugin context, resolved section, target route, query, caller signal, and source cap.
 * @returns the answer prose, its sources, and the gateway's own telemetry for diagnostics.
 * @throws {WebError} with a stable code for every failure class.
 */
export async function searchWithGateway(options) {
	const { ctx, target, query, signal } = options;
	// The same boundary the route resolver uses: editable fields are live
	// references on 0.1.7 and plain values on 0.1.5.
	const config = normalizeConfig(options.config);
	const maxSources = Number.isInteger(options.maxSources) && options.maxSources > 0 ? options.maxSources : 10;
	const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 90000;
	const apiKey = await resolveApiKey(ctx, target);
	if (apiKey === undefined) {
		throw new WebError(
			'clinepass search has no credential for "' + (target.apiKeyEnv ?? target.endpoint) + '" on route "' + target.provider + '";'
				+ ' store it through the credentials service (the Web Models page writes it), export it in the launching environment, or set a literal apiKey in the web-search-clinepass config',
			'WEB_PROVIDER_CREDENTIAL_MISSING',
		);
	}
	const body = {
		model: target.model,
		messages: [
			{ role: 'system', content: SEARCH_SYSTEM_PROMPT },
			{ role: 'user', content: buildSearchInstruction(query, config.instructions) },
		],
		tools: [toolEntry(target.tool, query, maxSources)],
		max_tokens: Number.isInteger(config.maxTokens) && config.maxTokens > 0 ? config.maxTokens : 2048,
		stream: false,
	};
	if (typeof config.temperature === 'number') body.temperature = config.temperature;
	const headers = {
		'content-type': 'application/json',
		accept: 'application/json',
		authorization: 'Bearer ' + apiKey,
		'user-agent': USER_AGENT,
	};
	for (const [key, value] of Object.entries(target.headers ?? {})) {
		if (typeof value !== 'string') continue;
		if (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'content-type') continue;
		headers[key] = value;
	}
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
	const startedAt = Date.now();
	let response;
	try {
		response = await fetch(target.endpoint, {
			method: 'POST',
			redirect: 'error',
			headers,
			body: JSON.stringify(body),
			signal: requestSignal,
		});
	} catch (error) {
		if (signal?.aborted === true) throw new WebError('clinepass search aborted', 'WEB_ABORTED', { cause: error });
		if (timeoutSignal.aborted || isAbortError(error)) {
			throw new WebError('clinepass search timed out after ' + timeoutMs + ' ms.\n\n' + endpointHint(target), 'WEB_PROVIDER_ERROR', { cause: error });
		}
		throw new WebError('clinepass search request failed: ' + String(error) + '\n\n' + endpointHint(target), 'WEB_PROVIDER_ERROR', { cause: error });
	}
	const text = await response.text().catch((error) => {
		if (signal?.aborted === true) throw new WebError('clinepass search aborted', 'WEB_ABORTED', { cause: error });
		throw new WebError('clinepass search response could not be read: ' + String(error), 'WEB_PROVIDER_ERROR', { cause: error });
	});
	if (!response.ok) {
		throw new WebError('search endpoint error (HTTP ' + response.status + '): ' + describeErrorBody(text, response.status) + '\n\n' + endpointHint(target), 'WEB_PROVIDER_ERROR');
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new WebError('search endpoint returned a body that is not JSON: ' + String(error) + '\n\n' + endpointHint(target), 'WEB_PROVIDER_ERROR', { cause: error });
	}
	const payload = parsed?.data ?? parsed;
	if (payload?.error !== undefined && payload?.choices === undefined) {
		throw new WebError('search endpoint reported an error: ' + describeErrorBody(JSON.stringify(payload.error), 200) + '\n\n' + endpointHint(target), 'WEB_PROVIDER_ERROR');
	}
	const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined;
	const message = choice?.message ?? {};
	const gateway = message?.provider_metadata?.gateway ?? payload?.provider_metadata?.gateway;
	const rawText = messageText(message.content);
	const parsedAnswer = parseSearchAnswer(rawText, { maxSources });
	const sources = mergeSources(annotationSources(message), parsedAnswer.sources, maxSources);
	const toolCalls = gateway?.gatewayToolCalls;
	const executed = toolCalls === null || typeof toolCalls !== 'object'
		? undefined
		: Object.values(toolCalls).reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
	let content = parsedAnswer.content;
	if (content.length === 0 && sources.length === 0) {
		throw new WebError('search endpoint returned no answer and no sources' + (choice?.finish_reason === undefined ? '' : ' (finish reason: ' + choice.finish_reason + ')') + '\n\n' + endpointHint(target), 'WEB_PROVIDER_ERROR');
	}
	if (executed === 0) {
		content = content.length === 0
			? 'The gateway reported that no web search was executed for this query.'
			: content + '\n\n_(The gateway reported that no web search was executed for this query; treat this answer as unverified.)_'
	}
	if (choice?.finish_reason === 'length') {
		content += content.length === 0
			? 'The search answer hit the output token limit before producing a source list.'
			: '\n\n_(This answer hit the output token limit and may be incomplete, including its source list.)_'
	}
	return {
		content,
		sources,
		durationMs: Date.now() - startedAt,
		toolCalls: toolCalls ?? undefined,
		executed,
		cost: gateway?.gatewayCost ?? payload?.usage?.gateway_cost,
		generationId: gateway?.generationId,
		finishReason: choice?.finish_reason,
	};
}
