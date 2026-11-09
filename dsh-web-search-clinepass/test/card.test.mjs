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

/** The baseline module the web shell seeds that the card draws its UI from. */
const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives';

/**
 * Every name the collapse chevron has shipped under, oldest first: dsh 0.1.5
 * exported it by size, 0.2.0 exports weight variants and dropped the sized name.
 */
const ICON_NAMES = ['IconChevronDownOutline14', 'IconChevronDownOutlineMedium', 'IconChevronDownOutlineRegular'];

/**
 * Stand in for the baseline primitives module. The shell always seeds the real
 * one; a stub keeps these tests hermetic (a browser-only React component tree
 * cannot be imported into Node) while still proving the card asks that module
 * for the parts it renders.
 * @param react - the module to build the stub components from.
 * @returns the stub exports.
 */
function primitivesStub(react, chevron = ICON_NAMES[0]) {
	if (react === undefined) return {};
	const el = react.createElement;
	// The icon family was renamed between harness generations; a stub serves
	// exactly one of the three names so the card's fallback chain is exercised.
	// `null` exports all three as empty, the worst shape a module can have.
	const icons = {};
	for (const name of chevron === null ? ICON_NAMES : [chevron]) {
		icons[name] = chevron === null
			? null
			: (props) => el('svg', { 'data-test-chevron': '', viewBox: '0 0 16 16', className: props.className });
	}
	return {
		Tag: (props) => el('span', { 'data-test-tag': props.tone ?? '', className: props.className }, props.children),
		...icons,
		Switch: (props) => el('button', {
			type: 'button',
			role: 'switch',
			'aria-checked': props.checked === true,
			disabled: props.disabled,
			className: props.className,
			onClick: () => props.onChange(props.checked !== true),
		}, props.label),
	};
}

/**
 * Load the bundle through the loader format it ships in.
 * @param react - the module the bundle's `require('react')` answers with.
 * @param primitives - an explicit primitives module, or the default stub.
 */
async function loadClientBundle(react, primitives) {
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
	assert.equal(entry.id, 'dsh-web-search-clinepass');
	const required = [];
	const exports = entry.factory((specifier) => {
		required.push(specifier);
		if (specifier === 'react') return react;
		if (specifier === PRIMITIVES) return primitives ?? primitivesStub(react);
		throw new Error('unexpected require: ' + specifier);
	});
	exports.__required = required;
	return exports;
}

function fakeScope(options = {}) {
	const snapshot = {
		status: options.status ?? 'ready',
		value: options.section ?? {},
		base: {},
		user: options.user ?? {},
		revision: options.revision ?? 7,
		writable: true,
		mode: 'host',
	};
	const writes = [];
	return {
		writes,
		snapshot,
		getSnapshot: () => snapshot,
		subscribe: () => () => {},
		mutate: async (ops, expected) => { writes.push({ ops, expected }); },
		set: async () => {},
		unset: async () => {},
	};
}

/**
 * A dsh 0.1.5 browser context: the settings client provides settingsScope and the
 * plugins tab declares settings.plugin.item.
 * @param bound - receives the bound scope specs.
 * @param registered - receives the slot registrations.
 * @param ledger - ledger read counter the test asserts on.
 */
function legacyContext(bound, registered, ledger) {
	const slots = {
		// The ledger is empty for the first reads, then carries the deployment's own
		// cards: registration must wait for it, so this card ranks after them.
		entries: (name) => {
			assert.equal(name, 'settings.plugin.item');
			ledger.reads += 1;
			return ledger.reads < 3 ? [] : [{ options: { key: 'shell' } }, { options: { key: 'web-search-deepseek' } }];
		},
		register: (entry, component) => {
			registered.push({ entry, component, ledgerReads: ledger.reads });
			return () => {};
		},
	};
	const settingsScope = { bind: (spec) => { bound.push(spec); return fakeScope(); } };
	return {
		slots,
		settingsScope,
		inject: (services, run) => { if (services.includes('settingsScope')) run({ slots, settingsScope }); },
	};
}

/**
 * A dsh 0.1.7 browser context: the settings client provides configForms and the
 * plugin manager page declares plugins.row.config.
 * @param registered - receives the slot registrations.
 */
function modernContext(registered) {
	const slots = {
		entries: () => [],
		inject: (name, run) => { assert.equal(name, 'plugins.row.config'); run(); },
		register: (entry, component) => { registered.push({ entry, component }); return () => {}; },
	};
	return {
		slots,
		inject: (services, run) => { if (services.includes('configForms')) run({ slots }); },
	};
}

test('dsh 0.1.7: the page hands the form over, so the row configuration just registers', async () => {
	const module = await loadClientBundle({});
	assert.equal(typeof module.apply, 'function');
	assert.deepEqual(module.inject, ['slots'], 'the form arrives as a prop, so no settings service is injected');
	const registered = [];
	module.apply(modernContext(registered));
	assert.equal(registered.length, 1, 'one registration, and none for the 0.1.5 tab');
	assert.equal(registered[0].entry.name, 'plugins.row.config');
	assert.equal(registered[0].entry.key, 'dsh-web-search-clinepass#web-search-clinepass', 'keyed by bundle and row, the way the page looks it up');
	assert.equal(typeof registered[0].component, 'function');
});

test('dsh 0.1.5: the card binds the section scope and waits for the deployment cards', async () => {
	const module = await loadClientBundle({});
	const bound = [];
	const registered = [];
	const ledger = { reads: 0 };
	module.apply(legacyContext(bound, registered, ledger));
	assert.equal(registered.length, 0, 'the ledger is empty, so nothing registers yet');
	await new Promise((resolve) => { setTimeout(resolve, 60); });
	assert.deepEqual(bound, [{ namespace: 'web-search-clinepass' }]);
	assert.equal(registered.length, 1, 'one registration, and none for the 0.1.7 page');
	assert.equal(registered[0].entry.name, 'settings.plugin.item');
	assert.equal(registered[0].entry.key, 'web-search-clinepass');
	assert.equal(registered[0].entry.inject().scope.snapshot.revision, 7);
	assert.equal(typeof registered[0].component, 'function');
	assert.ok(registered[0].ledgerReads >= 3, 'registration waits for the cards the deployment ships');
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

test('the card renders its controls against a fake scope', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const module = await loadClientBundle(React);
	const scope = fakeScope({ section: { tool: 'vercel:parallel_search' }, user: { tool: 'vercel:parallel_search' } });
	const markup = renderToStaticMarkup(React.createElement(module.__internals.WebSearchClinepassCard, { scope, defaultOpen: true }));
	assert.match(markup, /网页搜索（当前模型）/u);
	assert.match(markup, /web-search-clinepass-tool/u);
	assert.match(markup, /vercel:parallel_search/u);
	assert.match(markup, /vercel:exa_search/u, 'every gateway tool is offered');
});

test('the card starts collapsed and only its header is rendered', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const module = await loadClientBundle(React);
	const scope = fakeScope({ section: { tool: 'vercel:parallel_search' } });
	const markup = renderToStaticMarkup(React.createElement(module.__internals.WebSearchClinepassCard, { scope }));
	assert.match(markup, /<li /u, 'a card is a list item, like the ones the deployment ships');
	assert.match(markup, /aria-expanded="false"/u);
	assert.doesNotMatch(markup, /web-search-clinepass-tool/u, 'the body stays out of the DOM while collapsed');
	assert.match(markup, /网页搜索（当前模型）/u);
	assert.match(markup, /data-test-chevron/u, 'the header carries the chevron the baseline module provides');
});

test('a missing namespace renders the unavailable state instead of crashing', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const module = await loadClientBundle(React);
	const scope = fakeScope({ status: 'unavailable' });
	const markup = renderToStaticMarkup(React.createElement(module.__internals.WebSearchClinepassCard, { scope }));
	assert.match(markup, /本部署不对外暴露/u);
});

test('the card draws its chrome from the deployment instead of inventing one', async () => {
	const module = await loadClientBundle({});
	const { CSS, CSS_ID, C } = module.__internals;
	assert.ok(module.__required.includes(PRIMITIVES), 'the baseline primitives module is what the card styles itself with');
	assert.equal(CSS_ID, 'dsh-web-search-clinepass/card.css');
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
	assert.equal(C.card, 'dswwsc-card');
});

test('the card renders the baseline Tag, Switch, and chevron it was handed', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const module = await loadClientBundle(React);
	const scope = fakeScope({ section: { tool: 'vercel:parallel_search' } });
	const collapsed = renderToStaticMarkup(React.createElement(module.__internals.WebSearchClinepassCard, { scope }));
	assert.match(collapsed, /data-test-chevron/u, 'the header chevron comes from the baseline module');
	assert.doesNotMatch(collapsed, /data-test-tag/u, 'a clean card holds no unsaved marker');
	const expanded = renderToStaticMarkup(React.createElement(module.__internals.WebSearchClinepassCard, { scope, defaultOpen: true }));
	assert.match(expanded, /role="switch"/u, 'the boolean field is the baseline switch');
	assert.match(expanded, /class="dswwsc-input"/u, 'the other controls carry the card field class');
});

test('the boolean field is a toggle row with the switch on the right', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const module = await loadClientBundle(React);
	const scope = fakeScope({ section: { enabled: true } });
	const markup = renderToStaticMarkup(React.createElement(module.__internals.WebSearchClinepassCard, { scope, defaultOpen: true }));
	const start = markup.indexOf('dswwsc-toggleRow');
	assert.ok(start > -1, 'the boolean field renders the toggle row the shipped cards use');
	const row = markup.slice(start, markup.indexOf('</div>', start));
	assert.match(row, /class="dswwsc-label"[^>]*>启用本 provider/u, 'the row names the field');
	assert.ok(row.indexOf('role="switch"') > row.indexOf('dswwsc-label'), 'the switch sits at the right end of the row');
	assert.match(row, /aria-checked="true"/u, 'the switch shows the staged value');
});

test('the search tool is a single-choice radio list, not a select', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const module = await loadClientBundle(React);
	const scope = fakeScope({ section: { tool: 'vercel:exa_search' } });
	const markup = renderToStaticMarkup(React.createElement(module.__internals.WebSearchClinepassCard, { scope, defaultOpen: true }));
	assert.doesNotMatch(markup, /<select/u, 'no option list is hidden behind a control');
	assert.match(markup, /role="radiogroup"/u);
	const radios = [...markup.matchAll(/<input[^>]*type="radio"[^>]*>/gu)].map((match) => match[0]);
	assert.equal(radios.length, module.__internals.TOOLS.length, 'every gateway tool is offered');
	assert.equal(new Set(radios.map((radio) => /name="([^"]+)"/u.exec(radio)[1])).size, 1, 'one radio group');
	const selected = radios.filter((radio) => radio.includes('checked'));
	assert.equal(selected.length, 1, 'exactly one option is selected');
	assert.match(selected[0], /value="vercel:exa_search"/u, 'the staged value is the selected option');
});

/**
 * The form the 0.1.7 plugin manager page hands a row's configuration entry.
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

test('dsh 0.1.7: the page view renders the fields and leaves the chrome to the page', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const module = await loadClientBundle(React);
	const form = fakeForm({ tool: 'vercel:exa_search', enabled: true }, { tool: 'vercel:exa_search' });
	const markup = renderToStaticMarkup(React.createElement(module.__internals.ModernCard, { view: 'page', form }));
	assert.match(markup, /role="radiogroup"/u, 'the tool list is offered');
	assert.match(markup, /role="switch"/u, 'the boolean field is the baseline switch');
	assert.match(markup, /web-search-clinepass-maxTokens/u, 'every field renders');
	assert.doesNotMatch(markup, /dswwsc-header/u, 'the plugin page draws the title and crumb, not this card');
	assert.doesNotMatch(markup, /aria-expanded/u, 'nothing is collapsed on the page the user explicitly opened');
	assert.match(markup, /已保存|保存/u);
});

test('dsh 0.1.7: the listed row asks for a summary and gets one without a form', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const module = await loadClientBundle(React);
	const markup = renderToStaticMarkup(React.createElement(module.__internals.ModernCard, { view: 'summary' }));
	assert.match(markup, /用当前会话选中的模型/u, 'the row describes itself while collapsed');
	assert.doesNotMatch(markup, /radiogroup/u);
});

test('dsh 0.1.7: an unserved entry renders nothing, and a loading one says so', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const module = await loadClientBundle(React);
	assert.equal(renderToStaticMarkup(React.createElement(module.__internals.ModernCard, { view: 'page' })), '', 'no form means the Host serves no such entry');
	const loading = renderToStaticMarkup(React.createElement(module.__internals.ModernCard, { view: 'page', form: fakeForm(undefined, {}, { status: 'loading' }) }));
	assert.match(loading, /正在读取配置/u);
	const unavailable = renderToStaticMarkup(React.createElement(module.__internals.ModernCard, { view: 'page', form: fakeForm(undefined, {}, { status: 'unavailable' }) }));
	assert.match(unavailable, /本部署不对外暴露/u);
});

test('dsh 0.1.7: a read-only entry disables every control', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const module = await loadClientBundle(React);
	const form = fakeForm({ tool: 'vercel:parallel_search' }, {}, { writable: false });
	const markup = renderToStaticMarkup(React.createElement(module.__internals.ModernCard, { view: 'page', form }));
	assert.match(markup, /只读：本部署不允许写这个命名空间/u);
	assert.doesNotMatch(markup, /<button(?![^>]*disabled)/u, 'every button is disabled while the document refuses writes');
});

test('the collapse chevron resolves whichever name the primitives ship', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	const scope = fakeScope({ section: {}, user: {} });
	for (const name of ICON_NAMES) {
		const module = await loadClientBundle(React, primitivesStub(React, name));
		const markup = renderToStaticMarkup(React.createElement(module.__internals.WebSearchClinepassCard, { scope }));
		assert.match(markup, /data-test-chevron/u, name + ' must be the component the header renders');
	}
});

test('a primitives module without a usable chevron still renders the header', async (t) => {
	if (React === undefined || renderToStaticMarkup === undefined) { t.skip('react-dom is not available on this machine'); return; }
	// All three names exported as null: the worst shape, and the one that would
	// hand null to createElement if the guard were a bare === undefined check.
	const module = await loadClientBundle(React, primitivesStub(React, null));
	const scope = fakeScope({ section: {}, user: {} });
	const markup = renderToStaticMarkup(React.createElement(module.__internals.WebSearchClinepassCard, { scope }));
	assert.doesNotMatch(markup, /data-test-chevron/u, 'no icon is drawn when none is available');
	assert.match(markup, /网页搜索（当前模型）/u, 'the header still renders its title');
	assert.match(markup, /aria-expanded/u);
});
