/**
 * Live end-to-end check: the real ctx.web seam, the real plugin entry, the real
 * ClinePass gateway. It reads the machine's own profile patch and credential
 * store, so it exercises exactly the resolution path a running dsh uses.
 *
 * The settings service is stubbed at the seam it exposes on dsh 0.2.x: the
 * `describe()` projection, whose rows carry `{ ns, value }`. Both namespaces the
 * route reads are composed in the profile patch, so this script builds those
 * rows from the same patch the launcher reads.
 *
 * Costs the configured provider a small amount of quota (one search turn),
 * which is why it is not part of `node --test test/`.
 *
 * Run: node test/live-gateway.mjs [query]
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { Context } from '@deepseek-ai/cordis';
import { WebRuntime } from '@deepseek-ai/dsh-web';
import { apply as applyPlugin, Config, name as pluginName, inject as pluginInject } from '../src/index.js';

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profileDir = process.env.DSH_PROFILE_DIR ?? join(dshHome, 'profiles', process.env.DSH_PROFILE ?? 'desktop');

/** Every `config:` block one loader patch list declares, keyed by patch id. */
function sectionsOf(patchPath) {
	const sections = {};
	if (!existsSync(patchPath)) return sections;
	const entries = yaml.load(readFileSync(patchPath, 'utf8'));
	const visit = (list) => {
		if (!Array.isArray(list)) return;
		for (const entry of list) {
			if (entry?.insert !== undefined) visit(entry.insert);
			const id = entry?.id;
			if (typeof id !== 'string') continue;
			if (entry.config !== null && typeof entry.config === 'object' && !Array.isArray(entry.config)) sections[id] = entry.config;
			if (Array.isArray(entry.config)) visit(entry.config);
		}
	};
	visit(entries);
	return sections;
}

const settings = { ...sectionsOf(join(dshHome, 'settings.yaml')), ...sectionsOf(join(profileDir, 'cordis.patch.yml')) };
const credentials = yaml.load(readFileSync(join(dshHome, '.credentials.yaml'), 'utf8'));
const refs = credentials?.refs ?? {};
const selected = settings['agent-default-model'];

if (typeof selected?.provider !== 'string' || typeof selected?.model !== 'string') {
	throw new Error('the profile patch has no agent-default-model provider/model to follow');
}
const route = settings['llm-pi-ai']?.providers?.[selected.provider];
if (route === undefined) throw new Error('no llm-pi-ai profile for route ' + selected.provider);
const apiKeyEnv = route.apiKeyEnv;
const apiKey = refs[apiKeyEnv] ?? process.env[apiKeyEnv];
if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('no credential for ' + apiKeyEnv);

console.log('route        :', selected.provider, '/', selected.model);
console.log('endpoint     :', route.baseURL, '(api ' + route.api + ')');
console.log('credential   :', apiKeyEnv, '(resolved, ' + apiKey.length + ' chars)');

const ctx = new Context();
// The loader parses the seam's volatile fields into stable references, so a
// hand-built WebRuntime has to carry the same shape: `{ get() }`.
const volatile = (value) => ({ get: () => value });
const web = new WebRuntime(ctx, { searchProvider: volatile('clinepass'), fetchProvider: volatile('http') });

const agent = {
	session: { requestHeader: () => ({ config: { provider: selected.provider, model: selected.model } }) },
	options: { provider: selected.provider, model: selected.model },
};
// The plugin's own context: same real context, plus the lookups the provider
// performs. `settings` and `credentials` are stubbed at the seam they expose.
const pluginCtx = Object.create(ctx);
pluginCtx.get = (service) => {
	if (service === 'settings') return { describe: () => Object.entries(settings).map(([ns, value]) => ({ ns, value })) };
	if (service === 'credentials') return { resolve: async (ref) => (typeof refs[ref] === 'string' ? { value: refs[ref] } : undefined) };
	if (service === 'agents') return { currentInitiator: () => agent };
	return ctx.get(service);
};
pluginCtx.inject = () => {};


assert.equal(pluginName, 'dsh-web-search');
assert.deepEqual(pluginInject, ['web']);
assert.equal(typeof Config, 'function');

let registered;
applyPlugin({
	...pluginCtx,
	get: pluginCtx.get,
	inject: pluginCtx.inject,
	web: { registerSearchProvider: (provider) => { registered = provider; return () => {}; } },
}, Config({}));
assert.ok(registered, 'apply() must register one provider');
assert.equal(registered.id, 'clinepass');
console.log('registered   :', registered.id, '| available =', registered.available());
assert.equal(registered.available(), true);

// Register the same provider into the REAL seam and search through it, so
// selection, the availability gate, and maxResults truncation are all real.
web.registerSearchProvider(registered);
const query = process.argv.slice(2).join(' ') || '济南到扬州高铁票价，最近的班次和价格';
const started = Date.now();
const result = await web.search({ query, maxResults: 5 });
console.log('\n--- search took ' + (Date.now() - started) + ' ms ---');
console.log('sources (' + result.sources.length + '), truncated=' + result.truncated);
for (const source of result.sources) console.log('  - ' + (source.title ?? '') + '  ' + source.url);
console.log('\n--- answer ---\n' + result.content);

assert.ok(result.sources.length > 0, 'a live gateway search must return at least one source');
assert.ok(result.content.length > 0, 'a live gateway search must return answer text');
assert.ok(result.sources.length <= 5, 'the seam must honor maxResults');
for (const source of result.sources) assert.match(source.url, /^https?:\/\//u);
console.log('\nLIVE CHECK OK');
