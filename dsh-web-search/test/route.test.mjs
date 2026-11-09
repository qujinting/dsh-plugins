/** Unit tests for route resolution: which model, which endpoint, which credential. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Config } from '../src/config.js';
import { chatCompletionsUrl, isOpenAiChatApi, resolveTarget, sessionModelSelection } from '../src/route.js';

const CLINEPASS_PI_AI = {
	providers: {
		clinepass: {
			api: 'openai-completions',
			baseURL: 'https://api.cline.bot/api/v1',
			apiKeyEnv: 'CLINEPASS_API_KEY',
			headers: { 'x-route': 'pi-ai' },
		},
		qwen: { api: 'anthropic-messages', baseURL: 'https://qwen.example/v1', apiKeyEnv: 'QWEN_API_KEY' },
	},
};

function fakeCtx(options = {}) {
	const settings = options.settings ?? {};
	return {
		get(name) {
			if (name === 'settings') return { get: (ns) => settings[ns] };
			if (name === 'credentials') return options.credentials;
			if (name === 'agents') {
				const agent = options.agent;
				return { currentInitiator: () => agent };
			}
			return undefined;
		},
	};
}

function agentWith(header, agentOptions) {
	return {
		session: { requestHeader: () => (header === undefined ? undefined : { config: header }) },
		options: agentOptions,
	};
}

/**
 * A context whose settings service looks like dsh 0.1.7's: no get(ns) at all,
 * only the describe() projection, which returns `{ ns, value }` rows. This is the
 * shape the running harness mounts, so the route has to resolve through it.
 */
function formsCtx(options = {}) {
	const rows = options.rows ?? [];
	return {
		get(name) {
			if (name === 'settings') return { describe: () => rows };
			if (name === 'credentials') return options.credentials;
			if (name === 'agents') return { currentInitiator: () => options.agent };
			return undefined;
		},
	};
}

const resolve = (raw) => Config(raw ?? {});

test('joins the chat-completions path once', () => {
	assert.equal(chatCompletionsUrl('https://api.cline.bot/api/v1'), 'https://api.cline.bot/api/v1/chat/completions');
	assert.equal(chatCompletionsUrl('https://api.cline.bot/api/v1/'), 'https://api.cline.bot/api/v1/chat/completions');
	assert.equal(chatCompletionsUrl('https://api.cline.bot/api/v1/chat/completions'), 'https://api.cline.bot/api/v1/chat/completions');
});

test('classifies declared wire protocols', () => {
	assert.equal(isOpenAiChatApi('openai-completions'), true);
	assert.equal(isOpenAiChatApi('OpenAI-Completions'), true);
	assert.equal(isOpenAiChatApi('anthropic-messages'), false);
	assert.equal(isOpenAiChatApi(undefined), undefined);
});

test('follows the session request header and resolves the route from llm-pi-ai', () => {
	const config = resolve({});
	const ctx = fakeCtx({
		settings: { 'llm-pi-ai': CLINEPASS_PI_AI },
		agent: agentWith({ provider: 'clinepass', model: 'cline-pass/deepseek-v4.1-flash' }),
	});
	const target = resolveTarget(ctx, config);
	assert.equal(target.provider, 'clinepass');
	assert.equal(target.model, 'cline-pass/deepseek-v4.1-flash');
	assert.equal(target.endpoint, 'https://api.cline.bot/api/v1/chat/completions');
	assert.equal(target.apiKeyEnv, 'CLINEPASS_API_KEY');
	assert.equal(target.tool, 'vercel:perplexity_search');
	assert.equal(target.headers['x-route'], 'pi-ai');
	assert.equal(target.source, 'session request header');
});

test('a model switch is picked up on the next search', () => {
	const config = resolve({});
	const settings = { 'llm-pi-ai': CLINEPASS_PI_AI };
	const first = resolveTarget(fakeCtx({ settings, agent: agentWith({ provider: 'clinepass', model: 'a' }) }), config);
	const second = resolveTarget(fakeCtx({ settings, agent: agentWith({ provider: 'clinepass', model: 'b' }) }), config);
	assert.equal(first.model, 'a');
	assert.equal(second.model, 'b');
});

test('falls back to agent options, then to the agent-default-model setting', () => {
	const config = resolve({});
	const settings = { 'llm-pi-ai': CLINEPASS_PI_AI };
	const fromOptions = sessionModelSelection(fakeCtx({ agent: agentWith(undefined, { provider: 'clinepass', model: 'm1' }) }));
	assert.deepEqual(fromOptions, { provider: 'clinepass', model: 'm1', source: 'agent options' });
	const defaultSettings = { ...settings, 'agent-default-model': { provider: 'clinepass', model: 'm2' } };
	const fromDefault = resolveTarget(fakeCtx({ settings: defaultSettings }), config);
	assert.equal(fromDefault.model, 'm2');
	assert.equal(fromDefault.source, 'agent-default-model setting');
});

test('an explicitly incompatible route protocol disables the provider', () => {
	const config = resolve({});
	const ctx = fakeCtx({ settings: { 'llm-pi-ai': CLINEPASS_PI_AI }, agent: agentWith({ provider: 'qwen', model: 'q' }) });
	assert.equal(resolveTarget(ctx, config), undefined);
});

test('config pins win over the session and per-route overrides fold in', () => {
	const config = resolve({ provider: 'clinepass', model: 'pinned-model', tool: 'vercel:exa_search', headers: { 'x-global': '1' } });
	const ctx = fakeCtx({
		settings: { 'llm-pi-ai': CLINEPASS_PI_AI },
		agent: agentWith({ provider: 'clinepass', model: 'session-model' }),
	});
	const target = resolveTarget(ctx, config);
	assert.equal(target.model, 'pinned-model');
	assert.equal(target.source, 'configuration');
	assert.equal(target.tool, 'vercel:exa_search');
	assert.equal(target.headers['x-global'], '1');
	assert.equal(target.headers['x-route'], 'pi-ai');
});

test('an explicit routes entry can serve a route llm-pi-ai does not describe', () => {
	const config = resolve({ routes: { other: { api: 'openai-completions', baseURL: 'https://gw.example/v1', apiKeyEnv: 'OTHER_KEY' } } });
	const ctx = fakeCtx({ agent: agentWith({ provider: 'other', model: 'm' }) });
	const target = resolveTarget(ctx, config);
	assert.equal(target.endpoint, 'https://gw.example/v1/chat/completions');
	assert.equal(target.apiKeyEnv, 'OTHER_KEY');
});

test('a pinned fallback serves a search when the session selection cannot', () => {
	const config = resolve({ fallback: { provider: 'clinepass', model: 'fallback-model' } });
	const ctx = fakeCtx({ settings: { 'llm-pi-ai': CLINEPASS_PI_AI }, agent: agentWith({ provider: 'qwen', model: 'q' }) });
	const target = resolveTarget(ctx, config);
	assert.equal(target.model, 'fallback-model');
	assert.equal(target.source, 'configured fallback');
});

test('no resolvable route means unavailable, and enabled:false short-circuits', () => {
	const ctx = fakeCtx({ agent: agentWith({ provider: 'clinepass', model: 'm' }) });
	assert.equal(resolveTarget(ctx, resolve({})), undefined);
	const settings = { 'llm-pi-ai': CLINEPASS_PI_AI };
	const serviceable = fakeCtx({ settings, agent: agentWith({ provider: 'clinepass', model: 'm' }) });
	assert.notEqual(resolveTarget(serviceable, resolve({})), undefined);
	assert.equal(resolveTarget(serviceable, resolve({ enabled: false })), undefined);
});

test('a malformed base URL is rejected instead of throwing', () => {
	const config = resolve({ baseURL: 'not-a-url', apiKeyEnv: 'X_KEY' });
	const ctx = fakeCtx({ agent: agentWith({ provider: 'clinepass', model: 'm' }) });
	assert.equal(resolveTarget(ctx, config), undefined);
});

test('the 0.1.7 settings projection serves the route when get(ns) does not exist', () => {
	const config = resolve({});
	const ctx = formsCtx({
		rows: [{ ns: 'llm-pi-ai', value: CLINEPASS_PI_AI }],
		agent: agentWith({ provider: 'clinepass', model: 'cline-pass/deepseek-v4.1-flash' }),
	});
	const target = resolveTarget(ctx, config);
	assert.notEqual(target, undefined, 'a settings service without get(ns) must still resolve the route');
	assert.equal(target.endpoint, 'https://api.cline.bot/api/v1/chat/completions');
	assert.equal(target.apiKeyEnv, 'CLINEPASS_API_KEY');
	assert.equal(target.headers['x-route'], 'pi-ai');
	assert.equal(target.source, 'session request header');
});

test('the 0.1.7 projection also serves the agent-default-model fallback', () => {
	const ctx = formsCtx({
		rows: [
			{ ns: 'other-entry', value: { ignored: true } },
			{ ns: 'llm-pi-ai', value: CLINEPASS_PI_AI },
			{ ns: 'agent-default-model', value: { provider: 'clinepass', model: 'm2', reasoningEffort: 'high' } },
		],
	});
	const target = resolveTarget(ctx, resolve({}));
	assert.equal(target.model, 'm2');
	assert.equal(target.source, 'agent-default-model setting');
});

test('a namespace the 0.1.7 projection does not serve leaves the route unresolved', () => {
	const ctx = formsCtx({ rows: [{ ns: 'something-else', value: CLINEPASS_PI_AI }], agent: agentWith({ provider: 'clinepass', model: 'm' }) });
	assert.equal(resolveTarget(ctx, resolve({})), undefined);
});
