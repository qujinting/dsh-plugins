// dsh-secret-broker — browser half.
//
// The key manager page inside Settings. It is a hand-written
// `__ModuleLoader__` factory with no build step, because the module table seeds
// only React and a few platform packages and this page needs nothing else: the
// host half already owns every operation, and the page is a thin view over
// `/api/dsh-secret-broker`.
//
// Three design decisions shape it:
//
//   * **The page never needs a value to do its job.** The list is metadata, the
//     form is write-only, and the one call that returns a value is behind an
//     explicit click per row. A settings page that cannot leak by accident is
//     worth more than one that is convenient.
//   * **Scope is a first-class control, not a column.** Globals and a session's
//     own keys are different things the user is thinking about, so the page is
//     filtered by scope and every write states the scope it targets.
//   * **Failures are shown, not thrown.** A locked store, a missing data
//     directory and a refused request all render as a banner over the list,
//     because the settings panel must survive a broken plugin.

window.__ModuleLoader__.load({
	id: 'dsh-secret-broker',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		// The one external this bundle needs, resolved defensively: a shell that
		// did not seed React should cost the page, not the whole settings panel.
		//
		// Deliberately *nothing* else is required — not even `react-dom` inside a
		// try/catch. The module system records a failed resolution against the
		// requiring row, so a specifier it cannot answer fails the whole bundle at
		// import time even when the throw is caught here. That is why the popover
		// below is placed with `position: fixed` from a measured rectangle instead
		// of being portalled through `react-dom`.
		let react
		try {
			react = require('react')
		} catch {
			react = undefined
		}

		// ------------------------------------------------------------- constants

		const API = '/api/dsh-secret-broker'
		const STYLE_ID = 'dsh-secret-broker-style'
		const GLOBAL_SCOPE = 'global'
		const SESSION_PREFIX = 'session:'
		const PROJECT_PREFIX = 'project:'

		/** How long a revealed value stays on screen before hiding itself again. */
		const REVEAL_HOLD_MS = 30_000

		/** How long a success notice stays up. */
		const NOTICE_MS = 4_000

		/** What a pair shows while its value is masked. */
		const MASK = '••••••••'

		const h = react === undefined ? undefined : react.createElement

		/** One absolute URL for a host route, valid under every page origin. */
		function absoluteUrl(path) {
			return new URL(path, window.location.href).href
		}

		/** Call one host route and unwrap its envelope. */
		async function api(path, body) {
			const response = await fetch(absoluteUrl(`${API}${path}`), {
				method: body === undefined ? 'GET' : 'POST',
				...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
				cache: 'no-store',
				credentials: 'same-origin',
			})
			const payload = await response.json().catch(() => undefined)
			if (!response.ok || payload?.ok !== true) {
				throw new Error(payload?.error ?? `请求失败（HTTP ${String(response.status)}）`)
			}
			return payload
		}

		/** A short, stable identity for one row. */
		function identity(scope, key) {
			return `${scope}\u0000${key}`
		}

		/** `session:abc…` → `abc…`, anything else unchanged. */
		function sessionIdOf(scope) {
			return scope.startsWith(SESSION_PREFIX) ? scope.slice(SESSION_PREFIX.length) : undefined
		}

		/** A human label for one scope, preferring the live session list. */
		function scopeText(scope, sessions) {
			if (scope === GLOBAL_SCOPE) return '全局'
			if (scope.startsWith(PROJECT_PREFIX)) return `工程 ${projectName(scope)}`
			const id = sessionIdOf(scope) ?? scope
			const live = sessions.find((session) => session.id === id)
			return live === undefined ? `会话 ${id.slice(0, 8)}（已结束）` : live.label
		}

		/** A compact local timestamp, or a dash when the field is empty. */
		function timeText(value) {
			if (typeof value !== 'string' || value.length === 0) return '—'
			const date = new Date(value)
			if (Number.isNaN(date.getTime())) return value
			return date.toLocaleString()
		}

		/** The last path segment of a project scope, for a short label. */
		function projectName(scope) {
			const raw = scope.startsWith(PROJECT_PREFIX) ? scope.slice(PROJECT_PREFIX.length) : scope
			const parts = raw.split(/[\\/]/u).filter((part) => part.length > 0)
			return parts.length === 0 ? raw : parts[parts.length - 1]
		}

		/** The CSS, injected once and scoped to this page's class prefix. */
		const STYLE = `
.dsh-sb { display: flex; flex-direction: column; gap: 14px; font-size: 13px; color: var(--dsw-alias-label-primary, #111827); }
.dsh-sb-head { display: flex; flex-direction: column; gap: 4px; }
.dsh-sb-title { font-size: 15px; font-weight: 600; }
.dsh-sb-sub { color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; line-height: 1.5; }
.dsh-sb-banner { border-radius: 8px; padding: 8px 10px; line-height: 1.5; border: 1px solid transparent; }
.dsh-sb-banner-error { color: var(--dsw-alias-state-error-primary, #b91c1c); border-color: var(--dsw-alias-state-error-primary, #b91c1c); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #b91c1c) 8%, transparent); }
.dsh-sb-banner-warn { color: var(--dsw-alias-state-warn-primary, #b45309); border-color: var(--dsw-alias-state-warn-primary, #b45309); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b45309) 8%, transparent); }
.dsh-sb-banner-ok { color: var(--dsw-alias-state-success-primary, #15803d); border-color: var(--dsw-alias-state-success-primary, #15803d); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #15803d) 8%, transparent); }
.dsh-sb-bar { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
.dsh-sb-field { display: flex; flex-direction: column; gap: 4px; }
.dsh-sb-field > label { color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; }
.dsh-sb input, .dsh-sb select, .dsh-sb textarea {
  box-sizing: border-box; width: 100%; padding: 6px 8px; font: inherit;
  color: var(--dsw-alias-label-primary, #111827);
  background: var(--dsw-alias-bg-base, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.16));
  border-radius: 6px;
}
.dsh-sb input:focus-visible, .dsh-sb select:focus-visible, .dsh-sb textarea:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px;
}
.dsh-sb input[readonly] { color: var(--dsw-alias-label-secondary, #6b7280); }
.dsh-sb button {
  font: inherit; padding: 6px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;
  color: var(--dsw-alias-label-primary, #111827);
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12));
  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08));
}
.dsh-sb button:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2, rgba(0,0,0,0.24)); }
.dsh-sb button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; }
.dsh-sb button:disabled { opacity: 0.5; cursor: default; }
/* The brand token is a *contrast-flipping* colour in this theme: near-black in
   light mode, near-white in dark. A filled primary button therefore has to take
   its foreground from the base background token, or the label disappears in one
   of the two themes — hardcoding #fff was exactly that bug. */
.dsh-sb button.dsh-sb-primary { background: var(--dsw-alias-brand-primary, #3b82f6); color: var(--dsw-alias-bg-base, #ffffff); border-color: transparent; }
.dsh-sb button.dsh-sb-danger { color: var(--dsw-alias-state-error-primary, #b91c1c); }
.dsh-sb-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; align-items: end; padding: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08)); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.04)); }
.dsh-sb-form-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; grid-column: 1 / -1; }
.dsh-sb-hint { color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; }
.dsh-sb-table { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08)); border-radius: 10px; overflow: hidden; }
.dsh-sb-row { display: grid; grid-template-columns: minmax(150px, 1.1fr) minmax(110px, 1fr) 104px auto; gap: 10px; align-items: center; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08)); }
.dsh-sb-row:first-child { border-top: 0; }
.dsh-sb-row-head { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08)); color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; }
/* The user's own key name leads everywhere; the derived variable name is the
   secondary detail beside it. The variable is what the model writes, but the key
   is what the user calls the thing, and a list showing only the derived name
   reads like the plugin invented a key. */
.dsh-sb-key { font-weight: 600; word-break: break-all; }
.dsh-sb-env { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); word-break: break-all; }
.dsh-sb-desc { color: var(--dsw-alias-label-secondary, #6b7280); word-break: break-word; }
.dsh-sb-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: nowrap; }
.dsh-sb-when { color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; white-space: nowrap; }
.dsh-sb-value { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; word-break: break-all; grid-column: 1 / -1; padding: 6px 8px; border-radius: 6px; background: var(--dsw-alias-bg-base, #fff); border: 1px dashed var(--dsw-alias-border-l2, rgba(0,0,0,0.24)); }
.dsh-sb-empty { padding: 18px 12px; text-align: center; color: var(--dsw-alias-label-secondary, #6b7280); }

/* --- the session-title-bar entry: one icon button, one modal -------------
   The button copies the header's own icon buttons exactly — 28x28, radius 8,
   transparent, label-secondary, hover on the layer-2 fill — because it sits in
   that row, and a pill with an emoji in it did not. The dialog copies the
   shell's own surface language: a dim backdrop and a 16px-radius card. */
.dsh-sb-iconbtn { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 6px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #61666b); font: inherit; cursor: pointer; }
.dsh-sb-iconbtn:hover, .dsh-sb-iconbtn[aria-expanded="true"] { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12)); color: var(--dsw-alias-label-primary, #111827); }
.dsh-sb-iconbtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; }
.dsh-sb-backdrop { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, 0.42); }
/* Matched to the shell's own settings dialog, measured live: a layer surface
   (not the translucent overlay surface a menu uses), a 28px radius, no border,
   and a hairline ring plus a soft shadow instead of a 1px outline. */
.dsh-sb-dialog { box-sizing: border-box; display: flex; flex-direction: column; gap: 0; width: min(560px, 100%); max-height: min(76vh, 680px); overflow: hidden; padding: 0; border: 0; border-radius: 28px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #111827); box-shadow: 0 0 0 0.5px var(--dsw-alias-border-l2, rgba(0,0,0,0.14)), 0 3px 8px rgba(0, 0, 0, 0.04), 0 18px 48px rgba(0, 0, 0, 0.24); }
.dsh-sb-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 16px 8px; }
.dsh-sb-dialog-title { font-size: 15px; font-weight: 600; }
.dsh-sb-dialog-sub { margin-top: 2px; color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; }
.dsh-sb-dialog-body { flex: 1; min-height: 0; overflow: auto; padding: 0 16px 6px; }
.dsh-sb-dialog-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 16px 14px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08)); color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; }
.dsh-sb-pop-group { margin: 12px 0 2px; }
.dsh-sb-pop-group > h4 { margin: 0 0 2px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #6b7280); }
.dsh-sb-pair { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; align-items: center; padding: 8px; border-radius: 8px; }
.dsh-sb-pair + .dsh-sb-pair { border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06)); }
.dsh-sb-pair:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08)); }
.dsh-sb-pair-name { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dsh-sb-pair-key { font-weight: 600; word-break: break-all; }
.dsh-sb-pair-env { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); word-break: break-all; }
.dsh-sb-pair-desc { grid-column: 1 / -1; color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; word-break: break-word; }
.dsh-sb-pair-value { grid-column: 1 / -1; }
/* Tinted from currentColor rather than a surface token: the layer tokens
   resolve to the dialog's own background here, which would hide the chip, and
   a text-colour tint stays visible on both themes. */
.dsh-sb-pair-value code { display: block; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; word-break: break-all; padding: 5px 8px; border-radius: 6px; background: rgba(127,127,127,0.12); background: color-mix(in srgb, currentColor 8%, transparent); border: 1px solid rgba(127,127,127,0.2); border-color: color-mix(in srgb, currentColor 12%, transparent); }
.dsh-sb-group-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-sb-mini { padding: 2px 8px; font-size: 12px; }
.dsh-sb-editor { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; align-items: end; margin: 4px 0 8px; padding: 10px; border-radius: 10px; background: rgba(127,127,127,0.1); background: color-mix(in srgb, currentColor 5%, transparent); }
.dsh-sb-editor-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; grid-column: 1 / -1; }
.dsh-sb-pair-actions { display: flex; gap: 4px; flex-wrap: nowrap; }
.dsh-sb-pair-actions button { padding: 3px 8px; font-size: 12px; }
@media (max-width: 900px) {
  .dsh-sb-form { grid-template-columns: 1fr; }
  .dsh-sb-row { grid-template-columns: 1fr; }
}
`

		/**
		 * Inject — or refresh — the page stylesheet.
		 *
		 * The id is stable across revisions on purpose, and the mounted element is
		 * compared against this revision's text rather than trusted. A plugin
		 * reload keeps the page's DOM: without the comparison, a bundle from
		 * revision N+1 would find revision N's stylesheet, skip the injection, and
		 * render its new class names with no styles at all — which for a modal
		 * means its backdrop falls back to a block element inside the header row.
		 * That failure is silent and looks like a layout bug in the header.
		 */
		function installStyles() {
			const existing = document.getElementById(STYLE_ID)
			if (existing !== null) {
				if (existing.textContent !== STYLE) existing.textContent = STYLE
				return
			}
			const style = document.createElement('style')
			style.id = STYLE_ID
			style.textContent = STYLE
			document.head.appendChild(style)
		}

		// ------------------------------------------------------------- components

		/** One labelled field. */
		function Field(props) {
			return h('div', { className: 'dsh-sb-field', style: props.style },
				h('label', { htmlFor: props.id }, props.label),
				props.children)
		}

		/** The page. */
		function SecretsSection() {
			const [state, setState] = react.useState({ phase: 'loading' })
			const [scope, setScope] = react.useState(GLOBAL_SCOPE)
			const [key, setKey] = react.useState('')
			const [value, setValue] = react.useState('')
			const [description, setDescription] = react.useState('')
			const [showDraft, setShowDraft] = react.useState(false)
			const [busy, setBusy] = react.useState(false)
			const [notice, setNotice] = react.useState(undefined)
			const [revealed, setRevealed] = react.useState({})

			const load = react.useCallback(async () => {
				try {
					const data = await api('/state')
					setState({ phase: 'ready', data })
				} catch (error) {
					setState({ phase: 'error', error: String(error?.message ?? error) })
				}
			}, [])

			react.useEffect(() => { void load() }, [load])

			// A notice is transient by nature; the persistent facts live in the
			// status line, so this only has to disappear.
			react.useEffect(() => {
				if (notice === undefined) return undefined
				const timer = setTimeout(() => setNotice(undefined), NOTICE_MS)
				return () => clearTimeout(timer)
			}, [notice])

			// A revealed value hides itself: leaving a secret on screen because the
			// user walked away is the one failure this page can cause on its own.
			react.useEffect(() => {
				const keys = Object.keys(revealed)
				if (keys.length === 0) return undefined
				const timer = setTimeout(() => setRevealed({}), REVEAL_HOLD_MS)
				return () => clearTimeout(timer)
			}, [revealed])

			if (state.phase === 'loading') {
				return h('div', { className: 'dsh-sb' }, h('div', { className: 'dsh-sb-empty' }, '正在读取密钥存储…'))
			}
			if (state.phase === 'error') {
				return h('div', { className: 'dsh-sb' },
					h('div', { className: 'dsh-sb-banner dsh-sb-banner-error' }, `无法读取密钥存储：${state.error}`),
					h('div', null, h('button', { type: 'button', onClick: () => { setState({ phase: 'loading' }); void load() } }, '重试')))
			}

			const data = state.data
			const sessions = data.sessions ?? []
			const allKeys = data.keys ?? []

			/**
			 * The scope picker, grouped by kind.
			 *
			 * Every scope the store holds is reachable — including one whose
			 * session or directory is gone — so an orphan can be inspected,
			 * promoted or deleted instead of becoming invisible.
			 */
			const optionsFor = (prefix, initial) => {
				const options = [...initial]
				for (const entry of allKeys) {
					if (prefix === undefined ? false : !entry.scope.startsWith(prefix)) continue
					if (options.some((option) => option.value === entry.scope)) continue
					options.push({ value: entry.scope, label: scopeText(entry.scope, sessions) })
				}
				return options
			}
			const scopeGroups = [
				{ label: '全局', options: [{ value: GLOBAL_SCOPE, label: '全局（所有会话）' }] },
				{
					label: '工程（按会话的工作目录）',
					options: optionsFor(PROJECT_PREFIX, (data.projects ?? []).map((project) => ({
						value: project.scope,
						label: `${projectName(project.scope)}${project.live ? '' : '（无活动会话）'}`,
					}))),
				},
				{
					label: '会话（只给这一个会话）',
					options: optionsFor(SESSION_PREFIX, sessions.map((session) => ({ value: SESSION_PREFIX + session.id, label: session.label }))),
				},
			].filter((group) => group.options.length > 0)

			const rows = allKeys
				.filter((entry) => entry.scope === scope)
				.sort((left, right) => left.key.localeCompare(right.key))

			/** Run one mutating call, then refresh and report. Resolves to whether it worked. */
			const run = async (operation, success) => {
				setBusy(true)
				try {
					await operation()
					setNotice({ kind: 'ok', text: success })
					await load()
					return true
				} catch (error) {
					setNotice({ kind: 'error', text: String(error?.message ?? error) })
					return false
				} finally {
					setBusy(false)
				}
			}

			const submit = (event) => {
				event.preventDefault()
				const trimmed = key.trim()
				if (trimmed.length === 0 || value.length === 0) {
					setNotice({ kind: 'error', text: '键名与值都不能为空。' })
					return
				}
				void run(
					() => api('/set', { key: trimmed, value, scope, description: description.trim() }),
					`已保存 ${trimmed}（${scopeText(scope, sessions)}）`,
				).then((saved) => {
					// Keep what the user typed when the write was refused, so a
					// rejected key name does not cost them the value as well.
					if (!saved) return
					setKey('')
					setValue('')
					setDescription('')
					setShowDraft(false)
				})
			}

			const remove = (entry) => {
				void run(
					() => api('/delete', { key: entry.key, scope: entry.scope }),
					`已删除 ${entry.key}`,
				)
			}

			const promote = (entry) => {
				void run(
					() => api('/promote', { key: entry.key, from: entry.scope, to: GLOBAL_SCOPE }),
					`${entry.key} 已提升为全局`,
				)
			}

			const reveal = (entry) => {
				void run(async () => {
					const payload = await api('/reveal', { key: entry.key, scope: entry.scope })
					setRevealed((current) => ({ ...current, [identity(entry.scope, entry.key)]: payload.value }))
				}, '值已显示，30 秒后自动隐藏')
			}

			const hide = (entry) => {
				setRevealed((current) => {
					const next = { ...current }
					delete next[identity(entry.scope, entry.key)]
					return next
				})
			}

			const banners = []
			if (data.locked === true) {
				banners.push(h('div', { key: 'locked', className: 'dsh-sb-banner dsh-sb-banner-error' },
					'加密文件无法解密，密钥存储当前为只读。请确认在同一 Windows 账户下运行；如需重新开始，请先移走数据目录里的 secrets.dpapi。'))
			} else if (data.writable !== true) {
				banners.push(h('div', { key: 'readonly', className: 'dsh-sb-banner dsh-sb-banner-error' }, '密钥存储当前不可写，请检查数据目录权限。'))
			}
			for (const warning of data.warnings ?? []) {
				banners.push(h('div', { key: warning.code, className: 'dsh-sb-banner dsh-sb-banner-warn' }, warning.message))
			}
			if (notice !== undefined) {
				banners.push(h('div', {
					key: 'notice',
					className: `dsh-sb-banner ${notice.kind === 'ok' ? 'dsh-sb-banner-ok' : 'dsh-sb-banner-error'}`,
				}, notice.text))
			}

			const status = [
				data.encryption === 'dpapi' ? 'DPAPI 加密存储' : '明文存储',
				`${String(allKeys.length)} 个密钥`,
				data.dataDir,
				data.redactResults === true ? '结果脱敏已开启' : '结果脱敏已关闭',
			].join(' · ')

			return h('div', { className: 'dsh-sb' },
				h('div', { className: 'dsh-sb-head' },
					h('div', { className: 'dsh-sb-title' }, '密钥'),
					h('div', { className: 'dsh-sb-sub' },
						'会话只拿到键名：在 shell 命令里写 $env:DSH_SECRET_<键名大写>，值由主机在执行那一刻注入子进程。值不会进入对话、日志或模型请求。'),
					h('div', { className: 'dsh-sb-sub dsh-sb-env' }, status)),

				banners.length > 0 ? h('div', { className: 'dsh-sb', style: { gap: '6px' } }, banners) : undefined,

				h('form', { className: 'dsh-sb-form', onSubmit: submit },
					h(Field, { id: 'dsh-sb-key', label: '键名' },
						h('input', {
							id: 'dsh-sb-key',
							value: key,
							placeholder: 'gh-token',
							title: '字母开头，可含字母数字、下划线与连字符，最长 64 字符',
							autoComplete: 'off',
							spellCheck: false,
							onChange: (event) => setKey(event.target.value),
						})),
					h(Field, { id: 'dsh-sb-value', label: '值' },
						h('input', {
							id: 'dsh-sb-value',
							type: showDraft ? 'text' : 'password',
							value,
							placeholder: '粘贴 token / 密码 / 连接串',
							title: '保存后界面上不再显示，除非点「查看」',
							autoComplete: 'new-password',
							spellCheck: false,
							onChange: (event) => setValue(event.target.value),
						})),
					h(Field, { id: 'dsh-sb-scope', label: '作用域' },
						h('select', {
							id: 'dsh-sb-scope',
							value: scope,
							onChange: (event) => setScope(event.target.value),
						}, scopeGroups.map((group) => h('optgroup', { key: group.label, label: group.label },
							group.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))))),
					h(Field, { id: 'dsh-sb-desc', label: '说明（可选，会出现在会话的密钥清单里）' },
						h('input', {
							id: 'dsh-sb-desc',
							value: description,
							placeholder: 'GitHub 只读 PAT',
							onChange: (event) => setDescription(event.target.value),
						})),
					h('div', { className: 'dsh-sb-form-actions' },
						h('button', { type: 'submit', className: 'dsh-sb-primary', disabled: busy }, busy ? '处理中…' : '保存'),
						h('button', {
							type: 'button',
							disabled: busy,
							onClick: () => { setKey(''); setValue(''); setDescription('') },
						}, '清空'),
						h('label', { className: 'dsh-sb-hint' },
							h('input', {
								type: 'checkbox',
								checked: showDraft,
								style: { width: 'auto', marginRight: '6px' },
								onChange: (event) => setShowDraft(event.target.checked),
							}),
							'显示正在输入的值'),
						h('span', { className: 'dsh-sb-hint' },
							`当前作用域：${scopeText(scope, sessions)}${scope === GLOBAL_SCOPE ? '（对所有会话生效）' : '（只对该会话生效，同名时覆盖全局）'}`))),

				h('div', { className: 'dsh-sb-table' },
					h('div', { className: 'dsh-sb-row dsh-sb-row-head' },
						h('div', null, '环境变量 / 键名'),
						h('div', null, '说明'),
						h('div', null, '更新时间'),
						h('div', { className: 'dsh-sb-actions' }, '操作')),
					rows.length === 0
						? h('div', { className: 'dsh-sb-empty' },
							scope === GLOBAL_SCOPE ? '还没有全局密钥。在上面的表单里新增一个。' : '这个会话还没有专属密钥。')
						: rows.map((entry) => {
							const id = identity(entry.scope, entry.key)
							const shown = revealed[id]
							return h('div', { key: id, className: 'dsh-sb-row' },
								h('div', null,
									h('div', { className: 'dsh-sb-key' }, entry.key),
									h('div', { className: 'dsh-sb-env' }, entry.env)),
								h('div', { className: 'dsh-sb-desc' }, entry.description.length > 0 ? entry.description : '—'),
								h('div', { className: 'dsh-sb-when' }, timeText(entry.updatedAt)),
								h('div', { className: 'dsh-sb-actions' },
									data.allowReveal === true
										? h('button', {
											type: 'button',
											disabled: busy,
											title: '把已保存的值显示 30 秒',
											onClick: () => (shown === undefined ? reveal(entry) : hide(entry)),
										}, shown === undefined ? '查看' : '隐藏')
										: undefined,
									sessionIdOf(entry.scope) === undefined
										? undefined
										: h('button', {
											type: 'button',
											disabled: busy,
											title: '移到全局作用域',
											onClick: () => promote(entry),
										}, '提升为全局'),
									h('button', {
										type: 'button',
										className: 'dsh-sb-danger',
										disabled: busy,
										onClick: () => remove(entry),
									}, '删除')),
								shown === undefined
									? undefined
									: h('div', { className: 'dsh-sb-value' }, shown),
								entry.orphan === true
									? h('div', { className: 'dsh-sb-hint', style: { gridColumn: '1 / -1' } }, '该会话已不在运行，这条密钥不会再被任何会话用到。')
									: undefined)
						})))
		}

		// -------------------------------------------------- session title bar

		/**
		 * The header's icon language, copied from the buttons beside it: a 16x16
		 * box, `currentColor`, and a one-unit stroke. Drawn here rather than
		 * imported so the bundle keeps its single `react` request.
		 */
		const KEY_ICON = h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1, 'aria-hidden': 'true' },
			h('circle', { cx: 4.75, cy: 8, r: 2.75, stroke: 'currentColor' }),
			h('path', { d: 'M7.5 8H14', stroke: 'currentColor' }),
			h('path', { d: 'M11.25 8v2.5', stroke: 'currentColor' }),
			h('path', { d: 'M13.75 8v1.75', stroke: 'currentColor' }))

		/** The dialog's close control, in the same language. */
		const CLOSE_ICON = h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1, 'aria-hidden': 'true' },
			h('path', { d: 'M4 4l8 8', stroke: 'currentColor' }),
			h('path', { d: 'M12 4l-8 8', stroke: 'currentColor' }))

		/**
		 * The session-title-bar entry: one icon button and the dialog it opens.
		 *
		 * The settings page is where keys are *managed*; this is where they are
		 * *looked up* while working, so it answers one question — "what can this
		 * session use right now, and what is each one for?" — for exactly the two
		 * scopes that can apply: the globals, and this session's own overrides.
		 *
		 * Two shape decisions come from the surrounding UI rather than from taste:
		 * the trigger is the header's own 28x28 icon button (a labelled pill sat
		 * badly in that row and read as the header growing), and the content is a
		 * centred modal over a dim backdrop, which by construction cannot move the
		 * header it was opened from.
		 *
		 * Values follow the store's `titleBarValues` posture. Masked by default,
		 * because this is the most screenshotted strip of the window and a dialog
		 * that prints every secret the moment it opens is a leak waiting for a
		 * screenshot; one click (or one config line) shows it.
		 *
		 * @param props - the slot's standard Session props; `sessionId` is the one used.
		 */
		function HeaderSecretsAction(props) {
			const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined
			const ownScope = sessionId === undefined ? undefined : SESSION_PREFIX + sessionId
			const [open, setOpen] = react.useState(false)
			const [data, setData] = react.useState(undefined)
			const [error, setError] = react.useState(undefined)
			const [busy, setBusy] = react.useState(false)
			const [values, setValues] = react.useState({})
			const [copied, setCopied] = react.useState(undefined)
			// The inline editor. One draft at a time: `create` for a new key in the
			// group it was opened from, `edit` for a new value on an existing one.
			const [draft, setDraft] = react.useState(undefined)
			// Which row is waiting for a second click to delete.
			const [confirming, setConfirming] = react.useState(undefined)
			const [notice, setNotice] = react.useState(undefined)
			const panelRef = react.useRef(null)

			const load = react.useCallback(async () => {
				try {
					setData(await api('/state'))
					setError(undefined)
				} catch (failure) {
					setError(String(failure?.message ?? failure))
				}
			}, [])

			// The two scopes that can apply to the session in front of the user.
			// Derived here because two effects below depend on them.
			const keys = data?.keys ?? []
			const globals = react.useMemo(() => keys.filter((entry) => entry.scope === GLOBAL_SCOPE), [keys])
			// The project this session works in. The scope string is the host's,
			// taken from the session descriptor rather than re-derived here: one
			// normalizer decides what a project scope is, and it lives on the host.
			const ownProject = (data?.sessions ?? []).find((session) => session.id === sessionId)?.projectScope
			const projectEntries = react.useMemo(
				() => (ownProject === undefined ? [] : keys.filter((entry) => entry.scope === ownProject)),
				[keys, ownProject],
			)
			const mine = react.useMemo(
				() => (ownScope === undefined ? [] : keys.filter((entry) => entry.scope === ownScope)),
				[keys, ownScope],
			)
			const allowReveal = data?.allowReveal === true
			const plain = allowReveal && data?.titleBarValues === 'plain'

			// The count belongs in the tooltip, which needs the state before the
			// dialog is ever opened.
			react.useEffect(() => { void load() }, [load])

			react.useEffect(() => {
				if (!open) return undefined
				void load()
				// A dialog is a modal: the page behind it must not scroll under the
				// pointer, and the previous value has to come back on close. Keyed on
				// `open` alone — folding the draft into this effect would re-capture
				// "hidden" as the value to restore.
				const previousOverflow = document.body.style.overflow
				document.body.style.overflow = 'hidden'
				return () => {
					document.body.style.overflow = previousOverflow
				}
			}, [open, load])

			react.useEffect(() => {
				if (!open) return undefined
				const onKeyDown = (event) => {
					if (event.key !== 'Escape') return
					// Escape unwinds one layer at a time: the editor, then a pending
					// delete, then the dialog. One key must not throw away a
					// half-typed value and the whole surface at once.
					if (draft !== undefined) {
						setDraft(undefined)
						return
					}
					if (confirming !== undefined) {
						setConfirming(undefined)
						return
					}
					setOpen(false)
				}
				document.addEventListener('keydown', onKeyDown, true)
				return () => document.removeEventListener('keydown', onKeyDown, true)
			}, [open, draft, confirming])

			react.useEffect(() => {
				if (notice === undefined) return undefined
				const timer = setTimeout(() => setNotice(undefined), NOTICE_MS)
				return () => clearTimeout(timer)
			}, [notice])

			// A pending delete forgets itself, so a row never sits armed.
			react.useEffect(() => {
				if (confirming === undefined) return undefined
				const timer = setTimeout(() => setConfirming(undefined), 4_000)
				return () => clearTimeout(timer)
			}, [confirming])

			// A revealed value hides itself; the dialog can sit open for a long time.
			react.useEffect(() => {
				if (Object.keys(values).length === 0) return undefined
				const timer = setTimeout(() => setValues({}), REVEAL_HOLD_MS)
				return () => clearTimeout(timer)
			}, [values])

			react.useEffect(() => {
				if (copied === undefined) return undefined
				const timer = setTimeout(() => setCopied(undefined), 1_500)
				return () => clearTimeout(timer)
			}, [copied])

			const hide = (entry) => {
				setValues((current) => {
					const next = { ...current }
					delete next[identity(entry.scope, entry.key)]
					return next
				})
			}

			const reveal = async (entry) => {
				setBusy(true)
				try {
					const payload = await api('/reveal', { key: entry.key, scope: entry.scope })
					setValues((current) => ({ ...current, [identity(entry.scope, entry.key)]: payload.value }))
					setError(undefined)
				} catch (failure) {
					setError(String(failure?.message ?? failure))
				} finally {
					setBusy(false)
				}
			}

			const copy = async (entry) => {
				const id = identity(entry.scope, entry.key)
				try {
					await navigator.clipboard.writeText(values[id] ?? '')
					setCopied(id)
				} catch (failure) {
					setError(`复制失败：${String(failure?.message ?? failure)}`)
				}
			}

			/** Open the editor for a new key in one of the two groups. */
			const openCreate = (scope) => {
				setConfirming(undefined)
				setError(undefined)
				setDraft({ mode: 'create', scope, key: '', value: '', description: '', reveal: false })
			}

			/**
			 * Open the editor for an existing key.
			 *
			 * The current value is deliberately not fetched: "edit" means "replace",
			 * and a form pre-filled with the secret would put it on screen for the
			 * whole time the user is typing.
			 */
			const openEdit = (entry) => {
				setConfirming(undefined)
				setError(undefined)
				setDraft({ mode: 'edit', scope: entry.scope, key: entry.key, value: '', description: entry.description, reveal: false })
			}

			/** Commit the draft. */
			const saveDraft = async () => {
				if (draft === undefined) return
				const key = draft.key.trim()
				setBusy(true)
				try {
					await api('/set', { key, value: draft.value, scope: draft.scope, description: draft.description.trim() })
					const verb = draft.mode === 'edit' ? '已更新' : '已保存'
					setDraft(undefined)
					setNotice(`${verb} ${key}`)
					setError(undefined)
					await load()
				} catch (failure) {
					setError(String(failure?.message ?? failure))
				} finally {
					setBusy(false)
				}
			}

			/** Remove one entry. The caller has already asked for confirmation. */
			const remove = async (entry) => {
				setBusy(true)
				try {
					await api('/delete', { key: entry.key, scope: entry.scope })
					setConfirming(undefined)
					setNotice(`已删除 ${entry.key}`)
					setError(undefined)
					await load()
				} catch (failure) {
					setError(String(failure?.message ?? failure))
				} finally {
					setBusy(false)
				}
			}

			/**
			 * Move one entry to another scope.
			 *
			 * A key filed at the wrong granularity is the normal case, not an
			 * exception: a token saved for one session usually belongs to the
			 * project, and one saved for a project often belongs to everyone.
			 */
			const move = async (entry, to) => {
				setBusy(true)
				try {
					await api('/promote', { key: entry.key, from: entry.scope, to })
					setNotice(`${entry.key} 已移到${scopeText(to, data?.sessions ?? [])}`)
					setError(undefined)
					await load()
				} catch (failure) {
					setError(String(failure?.message ?? failure))
				} finally {
					setBusy(false)
				}
			}

			/** Whether the draft's key already exists in its scope, so the button can say so. */
			const overwrites = draft !== undefined && draft.mode === 'create'
				&& keys.some((entry) => entry.scope === draft.scope && entry.key === draft.key.trim())

			/** The one inline editor, shared by create and edit. */
			const editor = () => h('div', { className: 'dsh-sb-editor' },
				h('div', { className: 'dsh-sb-field' },
					h('label', { htmlFor: 'dsh-sb-d-key' }, draft.mode === 'edit' ? '键名（不可改）' : '键名'),
					h('input', {
						id: 'dsh-sb-d-key',
						value: draft.key,
						readOnly: draft.mode === 'edit',
						placeholder: 'gh-token',
						autoComplete: 'off',
						spellCheck: false,
						onChange: (event) => setDraft({ ...draft, key: event.target.value }),
					})),
				h('div', { className: 'dsh-sb-field' },
					h('label', { htmlFor: 'dsh-sb-d-value' }, draft.mode === 'edit' ? '新值（覆盖现有值）' : '值'),
					h('input', {
						id: 'dsh-sb-d-value',
						type: draft.reveal ? 'text' : 'password',
						value: draft.value,
						placeholder: '粘贴 token / 密码 / 连接串',
						autoComplete: 'new-password',
						spellCheck: false,
						onChange: (event) => setDraft({ ...draft, value: event.target.value }),
					})),
				h('div', { className: 'dsh-sb-field' },
					h('label', { htmlFor: 'dsh-sb-d-desc' }, '说明（可选）'),
					h('input', {
						id: 'dsh-sb-d-desc',
						value: draft.description,
						placeholder: 'GitHub 只读 PAT',
						onChange: (event) => setDraft({ ...draft, description: event.target.value }),
					})),
				h('div', { className: 'dsh-sb-editor-actions' },
					h('button', {
						type: 'button',
						className: 'dsh-sb-primary',
						disabled: busy || draft.key.trim().length === 0 || draft.value.length === 0,
						onClick: () => void saveDraft(),
					}, draft.mode === 'edit' ? '保存新值' : (overwrites ? '覆盖保存' : '保存')),
					h('button', { type: 'button', disabled: busy, onClick: () => setDraft(undefined) }, '取消'),
					h('label', { className: 'dsh-sb-hint' },
						h('input', {
							type: 'checkbox',
							checked: draft.reveal,
							style: { width: 'auto', marginRight: '6px' },
							onChange: (event) => setDraft({ ...draft, reveal: event.target.checked }),
						}),
						'显示正在输入的值'),
					h('span', { className: 'dsh-sb-hint' }, draft.scope === GLOBAL_SCOPE ? '作用域：全局' : '作用域：本会话')))

			// A `plain` posture shows every value the dialog is about to list. The
			// values still come from `/reveal` one key at a time — `/state` stays
			// structurally incapable of carrying one, which is a property worth
			// keeping even when the UI chooses to display them.
			react.useEffect(() => {
				if (!open || !plain) return undefined
				const entries = [...globals, ...mine]
				if (entries.length === 0) return undefined
				let live = true
				void Promise.all(entries.map(async (entry) => {
					try {
						const payload = await api('/reveal', { key: entry.key, scope: entry.scope })
						return [identity(entry.scope, entry.key), payload.value]
					} catch {
						return undefined
					}
				})).then((pairs) => {
					if (!live) return
					setValues((current) => {
						const next = { ...current }
						for (const pair of pairs) if (pair !== undefined) next[pair[0]] = pair[1]
						return next
					})
				})
				return () => { live = false }
			}, [open, plain, globals, mine])

			const pair = (entry) => {
				const id = identity(entry.scope, entry.key)
				const shown = values[id]
				if (draft !== undefined && draft.mode === 'edit' && draft.scope === entry.scope && draft.key === entry.key) {
					return h('div', { key: id }, editor())
				}
				const armed = confirming === id
				return h('div', { key: id, className: 'dsh-sb-pair' },
					h('div', { className: 'dsh-sb-pair-name' },
						h('span', { className: 'dsh-sb-pair-key' }, entry.key),
						h('span', { className: 'dsh-sb-pair-env' }, entry.env)),
					h('div', { className: 'dsh-sb-pair-actions' },
						allowReveal && !plain
							? h('button', {
								type: 'button',
								disabled: busy,
								onClick: () => (shown === undefined ? reveal(entry) : hide(entry)),
							}, shown === undefined ? '显示' : '隐藏')
							: undefined,
						shown === undefined
							? undefined
							: h('button', { type: 'button', disabled: busy, onClick: () => copy(entry) }, copied === id ? '已复制' : '复制'),
						h('button', { type: 'button', disabled: busy, onClick: () => openEdit(entry) }, '修改'),
						entry.scope === GLOBAL_SCOPE
							? undefined
							: h('button', {
								type: 'button',
								disabled: busy,
								title: '移到全局作用域：所有会话都能用',
								onClick: () => void move(entry, GLOBAL_SCOPE),
							}, '→全局'),
						sessionIdOf(entry.scope) === undefined || ownProject === undefined
							? undefined
							: h('button', {
								type: 'button',
								disabled: busy,
								title: `移到工程 ${projectName(ownProject)}：这个目录下的所有会话都能用`,
								onClick: () => void move(entry, ownProject),
							}, '→工程'),
						// Two clicks, because a dialog that deletes on one is a dialog
						// that deletes by accident.
						h('button', {
							type: 'button',
							className: 'dsh-sb-danger',
							disabled: busy,
							title: armed ? '再点一次确认删除' : '删除',
							onClick: () => (armed ? void remove(entry) : setConfirming(id)),
						}, armed ? '确认删除' : '删除')),
					entry.description.length > 0 ? h('div', { className: 'dsh-sb-pair-desc' }, entry.description) : undefined,
					h('div', { className: 'dsh-sb-pair-value' },
						h('code', null, shown === undefined ? MASK : shown)))
			}

			const group = (title, scope, entries, empty) => h('div', { className: 'dsh-sb-pop-group', key: title },
				h('div', { className: 'dsh-sb-group-head' },
					h('h4', null, `${title}（${String(entries.length)}）`),
					h('button', {
						type: 'button',
						className: 'dsh-sb-mini',
						disabled: busy,
						onClick: () => openCreate(scope),
					}, '新增')),
				draft !== undefined && draft.mode === 'create' && draft.scope === scope ? editor() : undefined,
				entries.length === 0 ? h('div', { className: 'dsh-sb-hint' }, empty) : entries.map(pair))

			// The structural half of the modal geometry is inline, not only in the
			// stylesheet: if the stylesheet is ever stale or missing, the dialog
			// must still cover the viewport and centre itself rather than land in
			// the header row's flow. Colour, radius and shadow stay in CSS.
			const dialog = open
				? h('div', {
					className: 'dsh-sb-backdrop',
					style: {
						position: 'fixed',
						inset: '0',
						zIndex: 2147483000,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						padding: '24px',
						background: 'rgba(0, 0, 0, 0.42)',
					},
					onClick: () => setOpen(false),
				},
					h('div', {
						className: 'dsh-sb dsh-sb-dialog',
						ref: panelRef,
						role: 'dialog',
						'aria-modal': 'true',
						'aria-label': '密钥',
						style: { boxSizing: 'border-box', display: 'flex', flexDirection: 'column', width: 'min(560px, 100%)', maxHeight: 'min(76vh, 680px)', overflow: 'hidden' },
						onClick: (event) => event.stopPropagation(),
					},
						h('div', { className: 'dsh-sb-dialog-head' },
							h('div', null,
								h('div', { className: 'dsh-sb-dialog-title' }, '密钥'),
								h('div', { className: 'dsh-sb-dialog-sub' }, '全局密钥对所有会话生效；本会话的密钥同名时覆盖全局。')),
							h('button', {
								type: 'button',
								className: 'dsh-sb-iconbtn',
								title: '关闭',
								'aria-label': '关闭',
								onClick: () => setOpen(false),
							}, CLOSE_ICON)),
						h('div', { className: 'dsh-sb-dialog-body' },
							error === undefined ? undefined : h('div', { className: 'dsh-sb-banner dsh-sb-banner-error' }, error),
							notice === undefined ? undefined : h('div', { className: 'dsh-sb-banner dsh-sb-banner-ok' }, notice),
							data === undefined
								? h('div', { className: 'dsh-sb-empty' }, '正在读取…')
								: h('div', null,
									group('全局', GLOBAL_SCOPE, globals, '还没有全局密钥，点右上「新增」。'),
									ownProject === undefined
										? undefined
										: group(`本工程 · ${projectName(ownProject)}`, ownProject, projectEntries, '这个工程还没有专属密钥，点右上「新增」。'),
									ownScope === undefined
										? undefined
										: group('本会话', ownScope, mine, '这个会话还没有专属密钥，点右上「新增」。'))),
						h('div', { className: 'dsh-sb-dialog-foot' },
							h('span', null, '跨会话总览：设置 → 密钥'),
							h('span', null, data?.encryption === 'dpapi' ? 'DPAPI 加密' : '明文存储'))))
				: undefined

			const button = h('button', {
				type: 'button',
				className: 'dsh-sb-iconbtn',
				title: data === undefined
					? '密钥'
					: `密钥：全局 ${String(globals.length)} · 本工程 ${String(projectEntries.length)} · 本会话 ${String(mine.length)}`,
				'aria-label': '密钥',
				'aria-haspopup': 'dialog',
				'aria-expanded': open,
				onClick: () => setOpen(true),
			}, KEY_ICON)

			return h(react.Fragment, null, button, dialog)
		}

		// ------------------------------------------------------------------ plugin

		const name = 'secret-broker'
		const inject = ['slots']

		/**
		 * Mount the two surfaces.
		 *
		 * Each registration is attempted on its own: a shell that lacks the header
		 * seat should still get the settings page, and vice versa.
		 *
		 * @param ctx - the client plugin context.
		 */
		function apply(ctx) {
			if (react === undefined) {
				ctx.logger?.warn?.('secret-broker: React 不可用，客户端界面未挂载')
				return
			}
			installStyles()
			if (ctx.slots === undefined || ctx.slots === null) return

			try {
				// The right-aligned header utilities: the one row that is entirely
				// icon buttons, so an icon button belongs in it.
				ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
					name: 'conversation.session.header.utilities',
					id: 'secret-broker',
					order: 5,
					label: () => '密钥',
				}, HeaderSecretsAction))
			} catch (error) {
				ctx.logger?.warn?.(`secret-broker: 标题栏入口挂载失败：${error?.message ?? error}`)
			}

			try {
				ctx.slots.inject('settings.section', () => ctx.slots.register({
					name: 'settings.section',
					id: 'secrets',
					order: 60,
					label: () => '密钥',
				}, SecretsSection))
			} catch (error) {
				ctx.logger?.warn?.(`secret-broker: 设置页挂载失败：${error?.message ?? error}`)
			}
		}

		exports.name = name
		exports.inject = inject
		exports.apply = apply
		exports.SecretsSection = SecretsSection
		exports.HeaderSecretsAction = HeaderSecretsAction
		return module.exports
	},
})
