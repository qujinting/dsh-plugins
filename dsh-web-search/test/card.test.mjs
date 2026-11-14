/**
 * Browser-half tests: load the hand-written client bundle exactly the way the
 * module loader does, then assert the slot registration, the write planner, and
 * (when react-dom is available) a static render of the card.
 *
 * React is resolved from the Harness web profile: the client baseline module
 * table is seeded by the shell, so this repository never depends on it. The
 * registration and planner tests need no real React at all - the module body
 * only touches React when it renders - so they run anywhere.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');

/** Bumped per load so each evaluation gets its own module URL. */
let loadCount = 0;

/**
 * Resolve one bare module from the first anchor that can answer.
 * @param specifier - the bare module to resolve.
 * @returns the module, or undefined when no anchor can answer.
 */
function resolveFromHarness(specifier) {
	const external = process.env.DSH_CARD_TEST_MODULES;
	const anchors = [
		// DSH_CARD_TEST_MODULES lets a developer point these tests at any module
		// directory that carries react plus react-dom (for example a scratch
		// `npm install --prefix <dir> react react-dom`).
		...(typeof external === 'string' && external.length > 0 ? [join(external, 'resolve-from.js')] : []),
		// The repository's own scratch directory for exactly that install, which
		// .gitignore keeps out of the tree.
		join(process.cwd(), '.card-test-modules', 'resolve-from.js'),
		join(dshHome, 'profiles', 'web', 'package.json'),
		join(dshHome, 'profiles', 'package.json'),
		join(process.cwd(), 'package.json'),
	];
	for (const anchor of anchors) {
		try {
			// createRequire only needs a base path, so an anchor need not exist:
			// CJS resolution walks up from it either way.
			return createRequire(anchor)(specifier);
		} catch {
			/* try the next anchor */
		}
	}
	return undefined;
}

const React = resolveFromHarness('react');
const renderToStaticMarkup = resolveFromHarness('react-dom/server')?.renderToStaticMarkup;

/**
 * Load the bundle through the loader format it ships in.
 * @param react - the module the bundle's `require('react')` answers with.
 */
async function loadClientBundle(react) {
	const source = readFileSync(join(process.cwd(), 'lib', 'client.js'), 'utf8');
	let entry;
	const previous = globalThis.window;
	globalThis.window = { __ModuleLoader__: { load(registration) { entry = registration; } } };
	try {
		const dataUrl = 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64') + '#load' + String((loadCount += 1));
		await import(dataUrl);
	} finally {
		if (previous === undefined) delete globalThis.window;
		else globalThis.window = previous;
	}
	assert.ok(entry, 'the bundle must register one module');
	assert.equal(entry.id, 'dsh-web-search');
	const required = [];
	const exports = entry.factory((specifier) => {
		required.push(specifier);
		if (specifier === 'react') return react;
		// Anything else - above all a Harness Client package - is a defect: the
		// plugin guide forbids loading those as modules.
		throw new Error('unexpected require: ' + specifier);
	});
	exports.__required = required;
	return exports;
}

/**
 * A dsh 0.2.x browser context: the settings client provides configForms and the
 * plugin manager page declares plugins.row.config. Any other service request is
 * recorded, so a test can prove the bundle asks for nothing else.
 * @param registered - receives the slot registrations.
 */
function modernContext(registered, injected = []) {
	const slots = {
		entries: () => [],
		inject: (name, run) => { assert.equal(name, 'plugins.row.config'); run(); },
		register: (entry, component) => { registered.push({ entry, component }); return () => {}; },
	};
	return {
		slots,
		services: injected,
		inject: (services, run) => {
			injected.push(services);
			if (services.includes('configForms')) run({ slots });
		},
	};
}

test('the page hands the form over, so the row configuration just registers', async () => {
	const module = await loadClientBundle({});
	assert.equal(typeof module.apply, 'function');
	assert.deepEqual(module.inject, ['slots'], 'the form arrives as a prop, so no settings service is injected');
	const registered = [];
	const injected = [];
	module.apply(modernContext(registered, injected));
	assert.deepEqual(injected, [['configForms']], 'configForms is the only service this half waits for');
	assert.equal(registered.length, 1, 'one registration, keyed the way the page looks it up');
	assert.equal(registered[0].entry.name, 'plugins.row.config');
	assert.equal(registered[0].entry.key, 'dsh-web-search#dsh-web-search');
	assert.equal(typeof registered[0].component, 'function');
});

test('the write planner stores only real changes and clears defaults', async () => {
	const module = await loadClientBundle({});
	const { buildOps, readDraft, clearOps, FIELDS } = module.__internals;
	const defaults = readDraft(undefined);
	assert.equal(defaults.tool, 'vercel:perplexity_search');
	assert.equal(defaults.maxTokens, 8192);
	assert.equal(defaults.enabled, true);
	assert.deepEqual(buildOps(defaults, {}, {}), [], 'an untouched default section writes nothing');
	const changed = Object.assign({}, defaults, { tool: 'vercel:parallel_search', maxSources: 4 });
	assert.deepEqual(buildOps(changed, { tool: 'vercel:perplexity_search' }, {}), [
		{ op: 'set', path: ['tool'], value: 'vercel:parallel_search' },
		{ op: 'set', path: ['maxSources'], value: 4 },
	]);
	assert.deepEqual(buildOps(defaults, { tool: 'vercel:exa_search' }, { tool: 'vercel:exa_search' }), [
		{ op: 'unset', path: ['tool'] },
	], 'returning a field to its default clears the override');
	assert.deepEqual(clearOps({ maxSources: 4, enabled: false }), [
		{ op: 'unset', path: ['enabled'] },
		{ op: 'unset', path: ['maxSources'] },
	]);
	assert.equal(FIELDS.length, 8);
});

test('the card offers exactly the four tools this API format documents', async () => {
	const module = await loadClientBundle({});
	assert.deepEqual(module.__internals.TOOLS, [
		'vercel:perplexity_search',
		'vercel:exa_search',
		'vercel:parallel_search',
		'vercel:tako_search',
	], 'browserbase tools are not offered: undocumented here and measured at six times the cost with no citations');
	assert.deepEqual(module.__internals.FIELDS.find((field) => field.key === 'tool').options, module.__internals.TOOLS);
	assert.equal(module.__internals.FIELDS.find((field) => field.key === 'maxTokens').def, 8192);
});

test('the card discloses that the search-count cap is only advice', async () => {
	const module = await loadClientBundle({});
	const hint = module.__internals.FIELDS.find((field) => field.key === 'tool').hint;
	assert.match(hint, /只是建议/u, 'a user cannot see the system prompt, so the setting has to say it');
	assert.match(hint, /没有硬上限/u);
	assert.match(hint, /费用随次数累加/u);
});

test('a section that already matches the defaults writes nothing', async () => {
	const module = await loadClientBundle({});
	const { buildOps, readDraft } = module.__internals;
	const draft = readDraft({ tool: 'vercel:perplexity_search', maxSources: 10, timeoutMs: 90000, maxTokens: 8192, enabled: true });
	assert.deepEqual(buildOps(draft, { tool: 'vercel:perplexity_search' }, {}), []);
});

test('the card draws its chrome from the deployment instead of inventing one', async () => {
	const module = await loadClientBundle({});
	const { CSS, CSS_ID, C } = module.__internals;
	assert.deepEqual(module.__required, ['react'], 'react is the only module the card takes from the baseline table');
	assert.ok(module.__required.every((specifier) => !specifier.startsWith('@deepseek-ai/')), 'no Harness Client package is loaded as a module: their ids change without notice');
	assert.equal(CSS_ID, 'dsh-web-search/card.css');
	assert.ok(CSS.includes('var(--dsw-alias-'), 'the chrome reads deployment theme tokens');
	assert.doesNotMatch(CSS, /#[0-9a-fA-F]{3,8}\b/u, 'no literal colour of its own');
	assert.doesNotMatch(CSS, /rgba?\(/u, 'no literal colour of its own');
	// Every rule is namespaced, so the card cannot leak styles into the page or
	// collide with the shipped card sheets.
	for (const [, selector] of CSS.matchAll(/(?:^|[}])([^@{}]+)[{]/gu)) {
		for (const one of selector.split(',')) {
			assert.ok(one.trim().startsWith('.dswwsc-'), 'rule ' + one.trim() + ' is namespaced to this card');
		}
	}
	assert.equal(C.readOnly, 'dswwsc-readOnly');
});

/**
 * The form the plugin manager page hands a row's configuration entry.
 * @param section - accepted values the page read.
 * @param user - raw user layer, whose field presence marks an override.
 * @param options - snapshot status, writability, and the mutate action to observe.
 */
function fakeForm(section, user = {}, options = {}) {
	return {
		state: {
			status: options.status ?? 'ready',
			value: section,
			base: {},
			user,
			revision: options.revision ?? 11,
			writable: options.writable ?? true,
			mode: 'host',
		},
		mutate: (ops, revision) => {
			if (options.mutate !== undefined) return options.mutate(ops, revision);
			return Promise.resolve(true);
		},
	};
}

test('the page view renders the fields and leaves the chrome to the page', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const module = await loadClientBundle(React);
	const form = fakeForm({ tool: 'vercel:exa_search', enabled: true }, { tool: 'vercel:exa_search' });
	const markup = renderToStaticMarkup(React.createElement(module.__internals.ModernCard, { view: 'page', form }));
	assert.match(markup, /role="radiogroup"/u, 'the tool list is offered');
	assert.match(markup, /role="switch"/u, 'the boolean field is a switch');
	assert.match(markup, /class="dswwsc-switchThumb"/u, 'the switch draws its own thumb instead of a Harness Client control');
	assert.match(markup, /dsh-web-search-maxTokens/u, 'every field renders');
	assert.doesNotMatch(markup, /dswwsc-header/u, 'the plugin page draws the title and crumb, not this card');
	assert.doesNotMatch(markup, /aria-expanded/u, 'nothing is collapsed on the page the user explicitly opened');
	assert.match(markup, /保存/u);
});

test('the listed row asks for a summary and gets one without a form', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const module = await loadClientBundle(React);
	const markup = renderToStaticMarkup(React.createElement(module.__internals.ModernCard, { view: 'summary' }));
	assert.match(markup, /用当前会话选中的模型/u, 'the row describes itself while collapsed');
	assert.doesNotMatch(markup, /radiogroup/u);
});

test('an unserved entry renders nothing, and a loading one says so', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const module = await loadClientBundle(React);
	assert.equal(renderToStaticMarkup(React.createElement(module.__internals.ModernCard, { view: 'page' })), '', 'no form means the Host serves no such entry');
	const loading = renderToStaticMarkup(React.createElement(module.__internals.ModernCard, { view: 'page', form: fakeForm(undefined, {}, { status: 'loading' }) }));
	assert.match(loading, /正在读取配置/u);
	const unavailable = renderToStaticMarkup(React.createElement(module.__internals.ModernCard, { view: 'page', form: fakeForm(undefined, {}, { status: 'unavailable' }) }));
	assert.match(unavailable, /本部署不对外暴露/u);
});

test('a read-only entry disables every control', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const module = await loadClientBundle(React);
	const form = fakeForm({ tool: 'vercel:parallel_search' }, {}, { writable: false });
	const markup = renderToStaticMarkup(React.createElement(module.__internals.ModernCard, { view: 'page', form }));
	assert.match(markup, /只读：本部署不允许写这个命名空间/u);
	assert.doesNotMatch(markup, /<button(?![^>]*disabled)/u, 'every button is disabled while the document refuses writes');
});

test('the boolean field is a toggle row with the switch on the right', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const module = await loadClientBundle(React);
	const form = fakeForm({ enabled: true });
	const markup = renderToStaticMarkup(React.createElement(module.__internals.ModernCard, { view: 'page', form }));
	const start = markup.indexOf('dswwsc-toggleRow');
	assert.ok(start > -1, 'the boolean field renders the toggle row the shipped cards use');
	const row = markup.slice(start, markup.indexOf('</div>', start));
	assert.match(row, /class="dswwsc-label"[^>]*>启用本 provider/u, 'the row names the field');
	assert.ok(row.indexOf('role="switch"') > row.indexOf('dswwsc-label'), 'the switch sits at the right end of the row');
	assert.match(row, /aria-checked="true"/u, 'the switch shows the staged value');
	assert.equal(module.__internals.C.switch, 'dswwsc-switch');
	assert.equal(module.__internals.C.badge, 'dswwsc-badge');
});

test('the search tool is a single-choice radio list, not a select', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const module = await loadClientBundle(React);
	const form = fakeForm({ tool: 'vercel:exa_search' });
	const markup = renderToStaticMarkup(React.createElement(module.__internals.ModernCard, { view: 'page', form }));
	assert.doesNotMatch(markup, /<select/u, 'no option list is hidden behind a control');
	assert.match(markup, /role="radiogroup"/u);
	const radios = [...markup.matchAll(/<input[^>]*type="radio"[^>]*>/gu)].map((match) => match[0]);
	assert.equal(radios.length, module.__internals.TOOLS.length, 'every gateway tool is offered');
	assert.equal(new Set(radios.map((radio) => /name="([^"]+)"/u.exec(radio)[1])).size, 1, 'one radio group');
	const selected = radios.filter((radio) => radio.includes('checked'));
	assert.equal(selected.length, 1, 'exactly one option is selected');
	assert.match(selected[0], /value="vercel:exa_search"/u, 'the staged value is the selected option');
});

test('an overridden field is marked and offers a reset action', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const module = await loadClientBundle(React);
	const form = fakeForm({ maxSources: 4 }, { maxSources: 4 });
	const markup = renderToStaticMarkup(React.createElement(module.__internals.ModernCard, { view: 'page', form }));
	assert.match(markup, /class="dswwsc-badge"[^>]*>已覆盖/u, 'the override badge is the card\'s own control');
	assert.match(markup, /恢复默认/u);
});
