/**
 * Host-half tests for the settings wiring and the seam contract this plugin
 * implements on dsh 0.2.x.
 *
 * The plugin's own Config entry IS its settings section on that line, so
 * `apply()` only has to tell the settings service that the card is the plugin's
 * own page, and then keep reading the same live config object on every search.
 * The rest of this file pins the two seams that make the plugin visible or
 * silently idle: provider selection (`web.searchProvider`) and the per-step
 * `ready()` answer that decides whether `web_search` is admitted at all.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Config, normalizeConfig } from '../src/config.js';
import { apply, selectionWarning, selectedSearchProvider } from '../src/index.js';
import { CurrentModelSearchProvider } from '../src/provider.js';

/**
 * A context shaped like the Host context `apply()` receives.
 * @param options - `settings` (the service, or undefined), `searchProvider` (the
 *   value the web seam's config holds), and `logger` to capture warnings.
 */
function fakeCtx(options = {}) {
	const registered = [];
	const listeners = [];
	const warnings = [];
	return {
		registered,
		listeners,
		warnings,
		fiber: { id: 'fake-fiber' },
		logger: options.logger ?? { warn: (message) => warnings.push(message) },
		/** Cordis answers undefined for a service this context does not carry. */
		get: () => undefined,
		on: (name, listener) => {
			listeners.push({ name, listener });
			return () => {};
		},
		inject: (services, run) => {
			if (services.includes('settings') && options.settings !== undefined) run({ settings: options.settings });
		},
		web: {
			config: options.searchProvider === undefined ? {} : { searchProvider: { get: () => options.searchProvider } },
			registerSearchProvider: (provider) => { registered.push(provider); return () => {}; },
		},
	};
}

test('apply turns the automatic page off and keeps one provider on the live config', async () => {
	const configured = [];
	const ctx = fakeCtx({ settings: { configure: (presentation, owner) => { configured.push({ presentation, owner }); return () => {}; } } });
	const config = Config({ tool: 'vercel:exa_search' });
	apply(ctx, config);
	assert.deepEqual(configured, [{ presentation: { auto: false }, owner: ctx.fiber }], 'the plugin ships its own page');
	assert.equal(ctx.registered.length, 1);
	const section = ctx.registered[0].resolveConfig();
	assert.equal(section, config, 'the loader keeps the entry config live, so the provider reads the same object');
	assert.equal(normalizeConfig(section).tool, 'vercel:exa_search');
	assert.equal(normalizeConfig(section).maxTokens, 8192);
	assert.equal(normalizeConfig(section).enabled, true);
});

test('a deployment without a settings service still serves the composition entry', async () => {
	const ctx = fakeCtx({ settings: undefined });
	apply(ctx, Config({}));
	const section = normalizeConfig(ctx.registered[0].resolveConfig());
	assert.equal(section.tool, 'vercel:perplexity_search');
	assert.equal(section.enabled, true);
});

test('the provider reports readiness the same way it reports availability', async () => {
	const serviceable = new CurrentModelSearchProvider(fakeCtx(), () => ({ provider: 'clinepass', model: 'm', baseURL: 'https://api.cline.bot/api/v1', api: 'openai-completions', apiKeyEnv: 'CLINEPASS_API_KEY' }));
	assert.equal(await serviceable.ready('clinepass'), true, 'a resolvable route is admitted for the step');
	const dead = new CurrentModelSearchProvider(fakeCtx(), () => ({ enabled: true }));
	assert.equal(await dead.ready('clinepass'), false, 'an unresolvable route hides web_search instead of failing it');
	assert.equal(await new CurrentModelSearchProvider(fakeCtx(), () => undefined).ready(), false, 'a throwing section cannot escape as a promise rejection');
});

test('a selection that names another provider is explained, not left silent', async () => {
	const shadowed = fakeCtx({ searchProvider: 'deepseek-official' });
	assert.equal(selectedSearchProvider(shadowed), 'deepseek-official');
	const warning = selectionWarning(shadowed);
	assert.match(warning, /web\.searchProvider is "deepseek-official"/u);
	assert.match(warning, /registered but unused/u);
	assert.match(warning, /searchProvider: clinepass/u, 'the fix is named in the warning');
	assert.equal(selectionWarning(fakeCtx({ searchProvider: 'clinepass' })), undefined, 'the selected provider is not a diagnostic');
	assert.equal(selectionWarning(fakeCtx()), undefined, 'no configured id leaves the seam to its own selection rules');
});

test('apply reports the shadow at mount and again when the web entry changes', async () => {
	const ctx = fakeCtx({ searchProvider: 'deepseek-official' });
	apply(ctx, Config({}));
	assert.equal(ctx.warnings.length, 1, 'a working install that never runs has to say so');
	assert.match(ctx.warnings[0], /registered but unused/u);
	const web = ctx.listeners.find((entry) => entry.name === 'settings/updated');
	assert.ok(web !== undefined, 'the web entry stays live, so its updates are watched');
	web.listener('llm-pi-ai');
	assert.equal(ctx.warnings.length, 1, 'an unrelated namespace is not a selection change');
	web.listener('web');
	assert.equal(ctx.warnings.length, 2, 'toggling the built-in page re-checks the selection');
});

test('a correctly selected plugin is quiet', async () => {
	const ctx = fakeCtx({ searchProvider: 'clinepass' });
	apply(ctx, Config({}));
	assert.deepEqual(ctx.warnings, [], 'nothing to report when this provider is the selected one');
});

test('normalizeConfig unwraps live references and passes plain values through', async () => {
	const config = Config({ tool: 'vercel:parallel_search', maxTokens: 2048 });
	const plain = normalizeConfig(config);
	assert.equal(plain.tool, 'vercel:parallel_search');
	assert.equal(plain.maxTokens, 2048);
	assert.deepEqual(plain.headers, {}, 'an empty dict field parses to an empty object, not undefined');
	const bare = { enabled: false, tool: 'x' };
	assert.deepEqual(normalizeConfig(bare), bare);
	assert.deepEqual(normalizeConfig(undefined), {});
	assert.deepEqual(normalizeConfig(null), {});
});

test('the card fields are the volatile ones, and nothing else is', async () => {
	const fields = ['enabled', 'provider', 'model', 'tool', 'timeoutMs', 'maxTokens', 'maxSources', 'instructions'];
	const dict = Config.dict ?? {};
	assert.ok(dict.enabled !== undefined, 'the schema exposes its fields for this check');
	for (const field of fields) {
		assert.ok(dict[field] !== undefined, field + ' is part of the schema');
		assert.equal(dict[field].meta?.volatile, true, field + ' is editable through the settings card');
	}
	for (const field of ['baseURL', 'api', 'apiKeyEnv', 'apiKey', 'headers', 'routes', 'temperature']) {
		assert.notEqual(dict[field]?.meta?.volatile, true, field + ' stays ordinary configuration');
	}
});
