/**
 * Host-half tests for the settings wiring that the harness changed under us.
 *
 * dsh 0.1.7 made a plugin's own Config entry its settings section and expects
 * configure({ auto: false }) for a plugin that ships its own page; dsh 0.1.5
 * installs a plugin-owned section through installSection. Both are exercised
 * here against fakes shaped exactly like each service, because a repository can
 * only run one harness at a time.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Config, normalizeConfig } from '../src/config.js';
import { apply, readConfig } from '../src/index.js';

/** A context that runs an injected child whenever the settings service is asked for. */
function fakeCtx(settings) {
	const registered = [];
	return {
		registered,
		fiber: { id: 'fake-fiber' },
		inject: (services, run) => {
			if (services.includes('settings') && settings !== undefined) run({ settings });
		},
		web: { registerSearchProvider: (provider) => { registered.push(provider); return () => {}; } },
	};
}

test('dsh 0.1.7: apply turns the automatic page off and reads the live entry config', async () => {
	const configured = [];
	const ctx = fakeCtx({ configure: (presentation, owner) => { configured.push({ presentation, owner }); return () => {}; } });
	const config = Config({ tool: 'vercel:exa_search' });
	apply(ctx, config);
	assert.deepEqual(configured, [{ presentation: { auto: false }, owner: ctx.fiber }], 'the plugin ships its own page');
	assert.equal(ctx.registered.length, 1);
	const section = ctx.registered[0].resolveConfig();
	assert.equal(section.tool, 'vercel:exa_search', 'the live reference is read, not the schema wrapper');
	assert.equal(section.maxTokens, 8192);
	assert.equal(section.enabled, true);
	assert.equal(typeof section.tool, 'string', 'every field arrives as a plain value');
});

test('dsh 0.1.5: apply installs a section and prefers it over the composition entry', async () => {
	const installed = [];
	const ctx = fakeCtx({
		installSection: (owner, ns, schema, config, hooks) => {
			installed.push({ owner, ns, schema, config, hooks });
			hooks.setSource({ tool: 'vercel:tako_search', maxTokens: 4096 });
		},
	});
	apply(ctx, Config({ tool: 'vercel:exa_search' }));
	assert.equal(installed.length, 1);
	assert.equal(installed[0].ns, 'web-search-clinepass');
	assert.equal(installed[0].schema, Config);
	assert.equal(installed[0].config.tool, 'vercel:exa_search', 'the old service is handed plain values, never volatile references');
	assert.equal(typeof installed[0].config.tool, 'string');
	const section = ctx.registered[0].resolveConfig();
	assert.deepEqual(section, { tool: 'vercel:tako_search', maxTokens: 4096 }, 'the resolved section wins over the entry');
});

test('a harness with neither settings model still serves the composition entry', async () => {
	const ctx = fakeCtx(undefined);
	apply(ctx, Config({}));
	const section = ctx.registered[0].resolveConfig();
	assert.equal(section.tool, 'vercel:perplexity_search');
	assert.equal(section.enabled, true);
});

test('normalizeConfig unwraps live references and passes plain values through', async () => {
	const config = Config({ tool: 'vercel:parallel_search', maxTokens: 2048 });
	const plain = normalizeConfig(config);
	assert.equal(plain.tool, 'vercel:parallel_search');
	assert.equal(plain.maxTokens, 2048);
	assert.deepEqual(plain.headers, {}, 'an empty dict field parses to an empty object, not undefined');
	assert.deepEqual(readConfig({ tool: 'plain', routes: { a: {} } }), {
		enabled: undefined, provider: undefined, model: undefined, tool: 'plain',
		timeoutMs: undefined, maxTokens: undefined, maxSources: undefined, instructions: undefined,
		baseURL: undefined, api: undefined, apiKeyEnv: undefined, apiKey: undefined,
		headers: undefined, routes: { a: {} }, fallback: undefined, temperature: undefined,
	}, 'a plain section is read field by field, with unknown keys dropped');
	const bare = { enabled: false, tool: 'x' };
	assert.deepEqual(normalizeConfig(bare), bare);
	assert.deepEqual(normalizeConfig(undefined), {});
	assert.deepEqual(normalizeConfig(null), {});
});

test('the editable fields are marked volatile wherever the schema supports it', async () => {
	const fields = ['enabled', 'provider', 'model', 'tool', 'timeoutMs', 'maxTokens', 'maxSources', 'instructions'];
	const supports = typeof Config.dict?.enabled?.volatile === 'function';
	const dict = Config.dict ?? {};
	for (const field of fields) {
		const schema = dict[field];
		assert.ok(schema !== undefined, field + ' is part of the schema');
		if (supports) assert.equal(schema.meta?.volatile, true, field + ' is editable through the settings form');
	}
	for (const field of ['baseURL', 'apiKey', 'apiKeyEnv', 'headers', 'routes']) {
		const schema = dict[field];
		if (supports && schema !== undefined) assert.notEqual(schema.meta?.volatile, true, field + ' stays ordinary configuration');
	}
});
