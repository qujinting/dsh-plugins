/**
 * dsh-web-search - browser half.
 *
 * The Host half exposes one settings entry; this half renders the page that
 * edits it. On dsh 0.2.x settings ARE the plugin's Config entry: the plugin
 * manager page declares `plugins.row.config`, hands the row's form (the entry's
 * accepted values, its user layer, and one mutate action) to whatever registered
 * for its key `<package>#<row id>`, and asks for a one-line summary while the
 * row is listed. So this half registers one card, keyed by this bundle and row,
 * and needs no service beyond slots and configForms.
 *
 * The card does not invent a look; it uses the deployment's own.
 *
 * There is no declarative card contract to opt into: the slot documentation is
 * explicit that a card draws its own internals and the page only decides which
 * keys to dispatch. `react` is the only module this bundle takes from the
 * baseline table, because the plugin guide forbids loading a Harness Client
 * package as a module (those ids change without notice, and a throwing component
 * blanks the slot entry) - so the two controls that carry behaviour, the
 * "overridden" badge and the boolean switch, are drawn here from the deployment's
 * own theme tokens (--dsw-alias-*), with the shipped Tag and Switch geometry and
 * colours copied rule for rule.
 *
 * The page owns the title, icon, and crumb, so the card renders only the fields
 * and the save row, and reports accept-vs-reject from `mutate` as a boolean.
 *
 * The bundle is written by hand in the loader format every plugin bundle uses
 * (window.__ModuleLoader__.load({ id, factory })): running it only registers the
 * factory, and the module body materializes on first use.
 */
window.__ModuleLoader__.load({
	id: 'dsh-web-search',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');

		/** This package's name: what the plugin page keys a bundle by. */
		const BUNDLE = 'dsh-web-search';
		/** The row this bundle's patch inserts; it is also the settings entry id. */
		const ROW_ID = 'dsh-web-search';
		/** The slot a row's configuration page is dispatched through. */
		const MODERN_SLOT = 'plugins.row.config';
		/** A row's configuration is keyed by its bundle and row. */
		const MODERN_KEY = BUNDLE + '#' + ROW_ID;
		/** The one-line summary the page shows while the row is listed. */
		const DESCRIPTION = '用当前会话选中的模型调用网关自带搜索工具联网检索。';
		/** Field id prefix: stable, so a label can point at its own control. */
		const ID_PREFIX = 'dsh-web-search-';

		/**
		 * Search tools a Vercel AI Gateway accepts as one tools[] entry on its
		 * Chat Completions API - the four its documentation lists for that format,
		 * at $5 per 1,000 calls for perplexity and parallel and $7 for exa and tako.
		 * Browserbase's tools are not documented for this format and measured badly
		 * through it, so they are not offered.
		 */
		const TOOLS = [
			'vercel:perplexity_search',
			'vercel:exa_search',
			'vercel:parallel_search',
			'vercel:tako_search',
		];

		/**
		 * The fields this card owns. Every default mirrors the Host schema, so a
		 * draft equal to its default clears the field (inherits) instead of storing
		 * a redundant override.
		 */
		const FIELDS = [
			{ key: 'enabled', kind: 'boolean', label: '启用本 provider', hint: '关掉后本 provider 报告为不可用，web_search 会报 "registered but unavailable"。', def: true },
			{ key: 'tool', kind: 'options', label: '搜索工具', hint: '网关自带的供应商端搜索工具，按每次检索计费（perplexity / parallel $5/千次，exa / tako $7/千次）。注意：系统提示词里的「最多 3 次搜索」只是建议，本格式没有硬上限，模型仍可能检索更多次，费用随次数累加。', def: 'vercel:perplexity_search', options: TOOLS },
			{ key: 'maxSources', kind: 'number', label: '来源上限', hint: '返回给 web 能力的来源条数上限；dsh-tool-web 的 searchMaxResults 还会再截一次。', def: 10 },
			{ key: 'timeoutMs', kind: 'number', label: '超时（毫秒）', hint: '单次搜索超时；dsh-tool-web 自己的 searchTimeoutMs（base 里是 60000）是模型侧的实际外框。', def: 90000 },
			{ key: 'maxTokens', kind: 'number', label: '输出上限（tokens）', hint: '太小会把回答和来源列表一起截断（实测一次问答约 3.5k–4.2k，含推理 token）。', def: 8192 },
			{ key: 'provider', kind: 'text', label: '钉死 LLM 路由（可选）', hint: '留空 = 跟随当前会话模型。', def: '' },
			{ key: 'model', kind: 'text', label: '钉死模型（可选）', hint: '留空 = 跟随当前会话模型。', def: '' },
			{ key: 'instructions', kind: 'textarea', label: '追加指令（可选）', hint: '追加到搜索指令末尾。', def: '' },
		];
		/**
		 * The card's own stylesheet, injected the way the shipped bundles inject
		 * theirs (one style element keyed by data-plugin-css). Every value either
		 * reads a deployment theme token or repeats a geometry the shipped card and
		 * field sheets already use - field rows divided by a .5px border-l2 rule,
		 * control height 34px, 8px radii - so the card follows the deployment
		 * through light, dark, and any future retheme instead of carrying a palette
		 * of its own.
		 */
		const CSS_ID = 'dsh-web-search/card.css';
		const CSS = [
			'.dswwsc-readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}',
			'.dswwsc-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
			'.dswwsc-field+.dswwsc-field{border-top:.5px solid var(--dsw-alias-border-l2)}',
			'.dswwsc-head{align-items:center;gap:8px;display:flex}',
			'.dswwsc-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}',
			'.dswwsc-badges{align-items:center;gap:8px;display:inline-flex}',
			// The "overridden" badge: the shipped Tag's neutral tone, values copied
			// from its stylesheet (radius 999px, 1px 8px padding, 11px/17px, 500).
			'.dswwsc-badge{align-items:center;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;display:inline-flex}',
			// The shipped Switch, rule for rule: 36x20 box, 2px padding, 999px radius,
			// border-l3 track that turns brand-primary when checked, thumb 16px
			// translating 16px, thumb colours from the shipped thumb rules.
			'.dswwsc-switch{box-sizing:border-box;background:var(--dsw-alias-border-l3);border:0;border-radius:999px;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;cursor:pointer;display:inline-block}',
			'.dswwsc-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}',
			'.dswwsc-switch:disabled{cursor:default;opacity:.5}',
			'.dswwsc-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
			'.dswwsc-switchThumb{background:var(--dsw-alias-label-primary-foreground);border-radius:50%;width:16px;height:16px;transition:transform .12s ease;display:block}',
			'.dswwsc-switch[aria-checked=false] .dswwsc-switchThumb{background:var(--dsw-alias-switch-thumb)}',
			'.dswwsc-switch[aria-checked=true] .dswwsc-switchThumb{transform:translate(16px)}',
			'.dswwsc-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}',
			'.dswwsc-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
			'.dswwsc-reset:disabled{cursor:default}',
			'.dswwsc-toggleRow{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:flex-start;gap:16px;font-size:13px;line-height:1.5;display:flex}',
			'.dswwsc-choices{border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;gap:6px;min-width:0;max-height:280px;margin:0;padding:10px;display:grid;overflow:auto}',
			'.dswwsc-choice{cursor:pointer;border-radius:6px;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px;min-width:0;padding:6px;display:grid}',
			'.dswwsc-choice:hover{background:var(--dsw-alias-bg-layer-4)}',
			'.dswwsc-choiceName{color:var(--dsw-alias-label-primary);font-size:13px;text-overflow:ellipsis;white-space:nowrap;display:block;overflow:hidden}',
			'.dswwsc-input{box-sizing:content-box;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}',
			'.dswwsc-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
			'.dswwsc-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
			'.dswwsc-textarea{height:auto;min-height:66px;padding:8px 12px;resize:vertical}',
			'.dswwsc-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
			'.dswwsc-footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}',
			'.dswwsc-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}',
			'.dswwsc-status{min-width:0;color:var(--dsw-alias-label-tertiary);flex:1;margin:0;font-size:12px;line-height:1.5}',
			'.dswwsc-discard,.dswwsc-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
			'.dswwsc-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}',
			'.dswwsc-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
			'.dswwsc-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
			'.dswwsc-discard:disabled,.dswwsc-save:disabled{opacity:.4;cursor:default}',
			'.dswwsc-discard:focus-visible,.dswwsc-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
		].join('');
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') === null) {
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-web-search';
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** Class names the stylesheet above defines. */
		const C = {
			readOnly: 'dswwsc-readOnly',
			field: 'dswwsc-field',
			head: 'dswwsc-head',
			label: 'dswwsc-label',
			badges: 'dswwsc-badges',
			badge: 'dswwsc-badge',
			switch: 'dswwsc-switch',
			switchThumb: 'dswwsc-switchThumb',
			reset: 'dswwsc-reset',
			toggleRow: 'dswwsc-toggleRow',
			choices: 'dswwsc-choices',
			choice: 'dswwsc-choice',
			choiceName: 'dswwsc-choiceName',
			input: 'dswwsc-input',
			textarea: 'dswwsc-textarea',
			hint: 'dswwsc-hint',
			footer: 'dswwsc-footer',
			failed: 'dswwsc-failed',
			status: 'dswwsc-status',
			discard: 'dswwsc-discard',
			save: 'dswwsc-save',
		};
		/** Join the class names that apply, the way the shipped cards do. */
		function cx() {
			const names = [];
			for (let index = 0; index < arguments.length; index += 1) {
				const name = arguments[index];
				if (name) names.push(name);
			}
			return names.join(' ');
		}

		/** Loose scalar equality, so a number typed into a text box still matches. */
		function sameValue(left, right) {
			if (left === right) return true;
			if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right);
			return String(left) === String(right);
		}

		/** Project one resolved section onto the card's draft shape. */
		function readDraft(section) {
			const source = section !== null && typeof section === 'object' ? section : {};
			const draft = {};
			for (const field of FIELDS) {
				const raw = source[field.key];
				if (raw === undefined || raw === null) { draft[field.key] = field.def; continue; }
				if (field.kind === 'number') draft[field.key] = Number.isFinite(Number(raw)) ? Number(raw) : field.def;
				else if (field.kind === 'boolean') draft[field.key] = raw === true;
				else draft[field.key] = String(raw);
			}
			return draft;
		}

		/**
		 * Turn one draft into path ops that store only real changes and clear every
		 * field returned to its default.
		 * @param draft - the staged values.
		 * @param section - the Host-resolved section this draft was seeded from.
		 * @param user - the raw user layer; presence marks a field overridden.
		 * @returns the ordered ops for one atomic mutation.
		 */
		function buildOps(draft, section, user) {
			const resolved = section !== null && typeof section === 'object' ? section : {};
			const overridden = user !== null && typeof user === 'object' ? user : {};
			const ops = [];
			for (const field of FIELDS) {
				const value = draft[field.key];
				const isOverridden = Object.prototype.hasOwnProperty.call(overridden, field.key);
				if (sameValue(value, field.def)) {
					if (isOverridden) ops.push({ op: 'unset', path: [field.key] });
					continue;
				}
				if (!sameValue(value, resolved[field.key])) ops.push({ op: 'set', path: [field.key], value });
			}
			return ops;
		}

		/** Ops that clear every field this card owns. */
		function clearOps(user) {
			const overridden = user !== null && typeof user === 'object' ? user : {};
			return FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(overridden, field.key)).map((field) => ({ op: 'unset', path: [field.key] }));
		}

		/**
		 * One labelled control, laid out the way the shipped cards lay theirs out.
		 *
		 * A boolean is a toggle row - its label on the left, a switch on the right
		 * (this card's own, styled from the shipped Switch's rules) - matching the
		 * shipped subagent card's toggle row. A
		 * one-of-many choice is a radio list - the shipped subagent card's shape for
		 * a list of options, down to the boxed group with its 8px radius and 6px
		 * rows - because a select hides every option but one behind a click. Text and
		 * number fields keep the shipped field kit's label row, control, and hint,
		 * with a hairline between consecutive fields.
		 * @param field - the field's spec.
		 * @param draft - the staged value to show.
		 * @param overridden - whether the user layer carries this field.
		 * @param disabled - whether writing is currently refused.
		 * @param onEdit - stage one typed value.
		 * @param onReset - clear this field back to the composition layer.
		 * @returns the field's element.
		 */
		function renderField(field, draft, overridden, disabled, onEdit, onReset) {
			const id = ID_PREFIX + field.key;
			const labelId = id + '-label';
			const value = draft[field.key];
			const badges = overridden ? React.createElement('span', { className: C.badges },
				React.createElement('span', { className: C.badge }, '已覆盖'),
				React.createElement('button', { type: 'button', className: C.reset, disabled, onClick: () => onReset(field) }, '恢复默认')) : null;
			if (field.kind === 'boolean') {
				// The shipped switch shape, drawn here: label left, the toggle right.
				// A button with role="switch" keeps it keyboard- and screen-reader
				// correct (Space/Enter activate it) and names itself with aria-label.
				return React.createElement('div', { className: C.field, key: field.key },
					React.createElement('div', { className: C.toggleRow },
						React.createElement('span', { className: C.label, id: labelId }, field.label),
						badges,
						React.createElement('button', {
							type: 'button',
							role: 'switch',
							className: C.switch,
							'aria-checked': value === true,
							'aria-label': field.label,
							disabled,
							onClick: () => onEdit(field, value !== true),
						}, React.createElement('span', { className: C.switchThumb }))),
					React.createElement('p', { className: C.hint }, field.hint));
			}
			let control;
			if (field.kind === 'options') {
				control = React.createElement('div', { className: C.choices, role: 'radiogroup', 'aria-labelledby': labelId },
					field.options.map((option) => React.createElement('label', { className: C.choice, key: option },
						React.createElement('input', { type: 'radio', name: id, value: option, checked: option === value, disabled, onChange: () => onEdit(field, option) }),
						React.createElement('span', { className: C.choiceName }, option))));
			} else if (field.kind === 'textarea') {
				control = React.createElement('textarea', { id, className: cx(C.input, C.textarea), value, disabled, onChange: (event) => onEdit(field, event.target.value) });
			} else {
				control = React.createElement('input', { id, className: C.input, type: field.kind === 'number' ? 'number' : 'text', value, disabled, onChange: (event) => onEdit(field, event.target.value) });
			}
			const label = field.kind === 'textarea' || field.kind === 'text' || field.kind === 'number'
				? React.createElement('label', { className: C.label, htmlFor: id }, field.label)
				: React.createElement('span', { className: C.label, id: labelId }, field.label);
			return React.createElement('div', { className: C.field, key: field.key },
				React.createElement('div', { className: C.head }, label, badges),
				control,
				React.createElement('p', { className: C.hint }, field.hint));
		}
		/**
		 * The card on dsh 0.2.x, where the plugin manager page owns the entry's
		 * configuration and hands it over: the page draws the title, icon, and crumb
		 * itself, passes the entry's accepted values with one mutate action, and asks
		 * for a one-line summary while the row is listed.
		 *
		 * The page re-renders this component when the form changes, so the snapshot
		 * arrives as a prop instead of through a subscription, and a write reports
		 * acceptance as a boolean rather than throwing for a refused revision.
		 * @param props - `view` (`summary` while the row is listed, `page` once it is
		 * opened) and, on `page`, `form`: the entry's snapshot and mutate action.
		 * @returns the summary line, the field list with its save control, or nothing.
		 */
		function ModernCard(props) {
			const form = props.form;
			const snapshot = form !== undefined && form !== null && form.state !== undefined
				? form.state
				: { status: 'loading', value: undefined, user: undefined, revision: undefined, writable: false };
			const section = snapshot.status === 'ready' && snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {};
			const user = snapshot.user !== null && typeof snapshot.user === 'object' ? snapshot.user : {};
			const [draft, setDraft] = React.useState(() => readDraft(section));
			const [status, setStatus] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const draftRef = React.useRef(draft);
			const seedRef = React.useRef(JSON.stringify(readDraft(section)));
			draftRef.current = draft;
			React.useEffect(() => {
				if (JSON.stringify(draftRef.current) !== seedRef.current) return;
				const next = readDraft(section);
				setDraft(next);
				seedRef.current = JSON.stringify(next);
			}, [snapshot]);
			if (props.view === 'summary') return DESCRIPTION;
			if (form === undefined || form === null) return null;
			if (snapshot.status !== 'ready') {
				return React.createElement('p', { className: C.readOnly, role: 'status' }, snapshot.status === 'loading' ? '正在读取配置…' : '本部署不对外暴露这个命名空间。');
			}
			const dirty = JSON.stringify(draft) !== seedRef.current;
			const failed = status !== null && status.kind === 'error';
			const disabled = busy || snapshot.writable === false;
			const edit = (field, value) => {
				setStatus(null);
				setDraft((previous) => Object.assign({}, previous, { [field.key]: field.kind === 'boolean' ? value === true : value }));
			};
			const editField = (field, value) => {
				if (field.kind === 'number') { const parsed = Number(value); edit(field, value === '' || !Number.isFinite(parsed) ? '' : parsed); return; }
				edit(field, value);
			};
			const run = async (ops) => {
				if (ops.length === 0) { setStatus({ kind: 'info', text: '没有需要写入的变更。' }); return; }
				setBusy(true);
				setStatus(null);
				try {
					const accepted = await form.mutate(ops, snapshot.revision);
					setStatus(accepted
						? { kind: 'ok', text: '已保存（' + ops.length + ' 项）。' }
						: { kind: 'error', text: '保存被拒绝：配置在读取之后又被改动过，请刷新页面后重试。' });
				} catch (error) {
					setStatus({ kind: 'error', text: '保存失败：' + (error && error.message ? error.message : String(error)) });
				} finally {
					setBusy(false);
				}
			};
			const statusText = failed ? status.text : (busy ? '保存中…' : (status === null ? '' : status.text));
			return React.createElement(React.Fragment, null,
				snapshot.writable === false ? React.createElement('p', { className: C.readOnly, role: 'status' }, '只读：本部署不允许写这个命名空间。') : null,
				FIELDS.map((field) => renderField(field, draft, Object.prototype.hasOwnProperty.call(user, field.key), disabled, editField, (target) => run([{ op: 'unset', path: [target.key] }]))),
				React.createElement('div', { className: C.footer },
					statusText === '' ? null : React.createElement('p', { className: failed ? C.failed : C.status, role: 'status' }, statusText),
					React.createElement('button', { type: 'button', className: C.discard, disabled, onClick: () => run(clearOps(user)) }, '全部恢复默认'),
					React.createElement('button', { type: 'button', className: C.discard, disabled: disabled || !dirty, onClick: () => { setDraft(readDraft(section)); setStatus(null); } }, '放弃'),
					React.createElement('button', { type: 'button', className: C.save, disabled: disabled || !dirty, onClick: () => run(buildOps(draft, section, user)) }, busy ? '保存中…' : '保存')));
		}

		/**
		 * Register the row's configuration card.
		 *
		 * The registration waits for the slot the plugin manager page declares, so a
		 * deployment that never composes that page shows no trace of this card.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			ctx.inject(['configForms'], (modernCtx) => {
				modernCtx.slots.inject(MODERN_SLOT, () => modernCtx.slots.register({
					name: MODERN_SLOT,
					key: MODERN_KEY,
				}, ModernCard));
			});
		}

		exports.apply = apply;
		exports.inject = ['slots'];
		// Test-only surface: the pure helpers, the field table, and the card, so this
		// repository can unit-test the write planner and the registration path
		// without a browser.
		exports.__internals = {
			BUNDLE, ROW_ID, MODERN_SLOT, MODERN_KEY,
			FIELDS, TOOLS, CSS, CSS_ID, C,
			readDraft, buildOps, clearOps,
			ModernCard,
		};
		return module.exports;
	},
});
