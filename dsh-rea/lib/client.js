// dsh-rea — browser half.
//
// The REA settings panel. What a user needs at a glance is one line: *is REA
// ready, and what will run*. Everything that answers "why" — the launch line, the
// candidate table, the data directory, the path form, the install log — is one
// click away, because a settings page that shows all of it at once is a page
// nobody reads.
//
// Hand-written `__ModuleLoader__` factory with no build step, for the same reason
// the sibling plugins are: the module table seeds React and nothing else, and the
// Host half already owns every operation. The page renders metadata and calls
// `/api/dsh-rea`; it never launches a process itself.
//
// Three decisions worth stating:
//
//   * **The status line is the whole surface.** Badge, source, version, then two
//     buttons. Everything else folds.
//   * **The page opens the fold it needs.** No REA at all opens "install"; a path
//     that stopped resolving opens it too, because that is the only thing the user
//     came to fix.
//   * **Nothing here is destructive.** Clearing the path falls back to the vendor
//     install or the default command; it never deletes an installed copy.

window.__ModuleLoader__.load({
	id: 'dsh-rea',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		let react
		try {
			react = require('react')
		} catch {
			react = undefined
		}

		const API = '/api/dsh-rea'
		const STYLE_ID = 'dsh-rea-style'
		const POLL_MS = 1500
		const NOTICE_MS = 5000

		const h = react === undefined ? undefined : react.createElement

		const ORIGIN_TEXT = {
			configured: '手动指定',
			vendor: '插件目录内置',
			command: 'npx 临时启动',
		}

		const STYLE = `
.dsh-rea { display: flex; flex-direction: column; gap: 8px; font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-primary, #111827); }
.dsh-rea-card { padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.18)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.03)); }
.dsh-rea-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dsh-rea-summary-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dsh-rea-summary-title { font-weight: 600; }
.dsh-rea-badge { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid rgba(127,127,127,0.28); border-color: color-mix(in srgb, currentColor 16%, transparent); background: color-mix(in srgb, currentColor 7%, transparent); }
.dsh-rea-badge-ok { color: var(--dsw-alias-state-success, #16a34a); }
.dsh-rea-badge-warn { color: var(--dsw-alias-state-warning, #b45309); }
.dsh-rea-badge-bad { color: var(--dsw-alias-state-error, #dc2626); }
.dsh-rea-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; word-break: break-all; }
.dsh-rea-path { display: block; padding: 6px 8px; border-radius: 6px; background: color-mix(in srgb, currentColor 7%, transparent); border: 1px solid rgba(127,127,127,0.18); border-color: color-mix(in srgb, currentColor 12%, transparent); }
.dsh-rea-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.dsh-rea button { padding: 5px 11px; font: inherit; font-size: 13px; color: inherit; background: transparent; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.28)); border-radius: 8px; cursor: pointer; }
.dsh-rea button:hover:not(:disabled) { background: color-mix(in srgb, currentColor 6%, transparent); }
.dsh-rea button:disabled { opacity: 0.5; cursor: default; }
.dsh-rea button.dsh-rea-primary { color: var(--dsw-alias-label-on-brand, #fff); background: var(--dsw-alias-brand-primary, #3b82f6); border-color: transparent; }
.dsh-rea button.dsh-rea-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3b82f6) 86%, #000); }
.dsh-rea-fold { border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.18)); border-radius: 12px; overflow: hidden; }
.dsh-rea-fold-head { box-sizing: border-box; width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 16px; font: inherit; font-size: 13px; text-align: left; color: inherit; background: transparent; border: 0; border-radius: 0; cursor: pointer; }
.dsh-rea-fold-head:hover { background: color-mix(in srgb, currentColor 5%, transparent); }
.dsh-rea-fold-title { font-weight: 600; }
.dsh-rea-fold-hint { margin-left: 8px; color: var(--dsw-alias-label-secondary, #6b7280); font-weight: 400; font-size: 12px; }
.dsh-rea-chev { color: var(--dsw-alias-label-secondary, #6b7280); font-size: 11px; }
.dsh-rea-fold-body { display: flex; flex-direction: column; gap: 12px; padding: 4px 16px 18px; }
.dsh-rea-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: end; }
.dsh-rea-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dsh-rea-field > label { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dsh-rea-field input { box-sizing: border-box; width: 100%; padding: 7px 9px; font: inherit; font-size: 13px; color: inherit; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08)); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.28)); border-radius: 8px; }
.dsh-rea-field input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; }
.dsh-rea-hint { margin: 0; color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; }
.dsh-rea-kv { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 4px 10px; align-items: baseline; }
.dsh-rea-kv > dt { color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; }
.dsh-rea-kv > dd { margin: 0; min-width: 0; }
.dsh-rea-banner { padding: 7px 10px; border-radius: 8px; font-size: 12px; }
.dsh-rea-banner-ok { color: var(--dsw-alias-state-success, #15803d); background: color-mix(in srgb, var(--dsw-alias-state-success, #16a34a) 12%, transparent); }
.dsh-rea-banner-bad { color: var(--dsw-alias-state-error, #b91c1c); background: color-mix(in srgb, var(--dsw-alias-state-error, #dc2626) 12%, transparent); }
.dsh-rea-log { max-height: 160px; overflow: auto; margin: 0; padding: 8px; border-radius: 8px; background: color-mix(in srgb, currentColor 5%, transparent); border: 1px solid rgba(127,127,127,0.16); border-color: color-mix(in srgb, currentColor 10%, transparent); white-space: pre-wrap; word-break: break-all; }
.dsh-rea-list { display: flex; flex-direction: column; gap: 8px; }
.dsh-rea-item { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dsh-rea-item > span:first-child { min-width: 132px; }
`

		/** Inject — or refresh — the panel stylesheet. */
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

		/** The tail of a path, for a one-line label. */
		function lastSegment(value) {
			if (typeof value !== 'string') return ''
			const parts = value.split(/[\\/]/u)
			return parts[parts.length - 1] ?? value
		}

		/** One collapsible block. */
		function Fold(props) {
			return h('div', { className: 'dsh-rea-fold' },
				h('button', {
					type: 'button',
					className: 'dsh-rea-fold-head',
					'aria-expanded': props.open,
					onClick: props.onToggle,
				},
					h('span', null,
						h('span', { className: 'dsh-rea-fold-title' }, props.title),
						props.hint === undefined ? null : h('span', { className: 'dsh-rea-fold-hint' }, props.hint)),
					h('span', { className: 'dsh-rea-chev' }, props.open ? '收起' : '展开')),
				props.open ? h('div', { className: 'dsh-rea-fold-body' }, props.children) : null)
		}

		/** One row in the candidate list. */
		function CandidateRow(props) {
			const item = props.item
			return h('div', { className: 'dsh-rea-item' },
				h('span', null, item.label),
				h('span', { className: `dsh-rea-badge ${item.available ? 'dsh-rea-badge-ok' : 'dsh-rea-badge-warn'}` }, item.available ? '可用' : '未找到'),
				item.version === undefined ? null : h('span', { className: 'dsh-rea-mono' }, `v${item.version}`),
				h('span', { className: 'dsh-rea-mono' }, item.path))
		}

		/** The settings section. */
		function ReaSection() {
			const [state, setState] = react.useState({ phase: 'loading' })
			const [open, setOpen] = react.useState({ details: false, manual: false, install: false })
			const [pathDraft, setPathDraft] = react.useState('')
			const [versionDraft, setVersionDraft] = react.useState('6.8.0')
			const [busy, setBusy] = react.useState(undefined)
			const [notice, setNotice] = react.useState(undefined)
			const [probe, setProbe] = react.useState(undefined)
			const opened = react.useRef(false)

			const load = react.useCallback(async () => {
				try {
					const data = await api('/status')
					setState({ phase: 'ready', data })
				} catch (error) {
					setState({ phase: 'error', error: String(error?.message ?? error) })
				}
			}, [])

			react.useEffect(() => { void load() }, [load])

			const data = state.phase === 'ready' ? state.data : undefined
			const install = data?.install
			const installing = install?.status === 'running'

			// Poll only while a job is actually in flight.
			react.useEffect(() => {
				if (installing !== true) return undefined
				const timer = setInterval(() => { void load() }, POLL_MS)
				return () => clearInterval(timer)
			}, [installing, load])

			react.useEffect(() => {
				if (notice === undefined) return undefined
				const timer = setTimeout(() => setNotice(undefined), NOTICE_MS)
				return () => clearTimeout(timer)
			}, [notice])

			// Open the fold the user came for, once, on the first status load: a
			// machine with no REA should land on "install", not on a status line
			// telling it that nothing is installed.
			react.useEffect(() => {
				if (opened.current || state.phase !== 'ready') return
				opened.current = true
				const launch = state.data.launch
				const configured = state.data.candidates.find((row) => row.origin === 'configured')
				if (launch.script === undefined) setOpen((current) => ({ ...current, install: true }))
				else if (configured !== undefined && configured.available !== true) setOpen((current) => ({ ...current, manual: true }))
				if (configured !== undefined) setPathDraft(configured.path)
			}, [state.phase, state.data])

			if (state.phase === 'loading') return h('div', { className: 'dsh-rea' }, '正在读取 REA 配置…')
			if (state.phase === 'error') {
				return h('div', { className: 'dsh-rea' },
					h('div', { className: 'dsh-rea-banner dsh-rea-banner-bad' }, `无法读取配置：${state.error}`),
					h('div', null, h('button', { type: 'button', onClick: () => { setState({ phase: 'loading' }); void load() } }, '重试')))
			}

			const launch = data.launch
			const ready = launch.script !== undefined
			const sourceText = ready
				? `${ORIGIN_TEXT[launch.origin] ?? launch.origin}${launch.origin === 'configured' ? ` · ${lastSegment(launch.script)}` : ''}`
				: '尚未配置 REA'

			const toggle = (key) => setOpen((current) => ({ ...current, [key]: !current[key] }))

			const run = async (label, action) => {
				setBusy(label)
				try {
					await action()
					await load()
				} catch (error) {
					setNotice({ tone: 'bad', text: String(error?.message ?? error) })
				} finally {
					setBusy(undefined)
				}
			}

			const testConnection = () => run('probe', async () => {
				setProbe(undefined)
				const result = await api('/probe', {})
				setProbe(result)
				if (result.ok === true) setNotice({ tone: 'ok', text: '连接成功' })
			})

			return h('div', { className: 'dsh-rea' },

				// The only always-visible surface: what is ready, and what to do next.
				h('div', { className: 'dsh-rea-card dsh-rea-summary' },
					h('div', { className: 'dsh-rea-summary-main' },
						h('span', { className: `dsh-rea-badge ${ready ? 'dsh-rea-badge-ok' : 'dsh-rea-badge-warn'}` }, ready ? '已就绪' : '未配置'),
						h('span', { className: 'dsh-rea-summary-title' }, sourceText),
						launch.version === undefined ? null : h('span', { className: 'dsh-rea-mono' }, `v${launch.version}`)),
					h('div', { className: 'dsh-rea-actions' },
						ready
							? h('button', { type: 'button', disabled: busy !== undefined, onClick: testConnection }, busy === 'probe' ? '正在连接…' : '测试连接')
							: h('button', { type: 'button', className: 'dsh-rea-primary', disabled: busy !== undefined || installing === true, onClick: () => setOpen((current) => ({ ...current, install: true })) }, '安装 REA'),
						h('button', { type: 'button', onClick: () => setOpen((current) => ({ ...current, manual: true })) }, ready ? '更换' : '已有本地文件'),
						h('button', { type: 'button', onClick: () => toggle('details') }, open.details ? '收起详情' : '详情'))),

				probe === undefined ? null : h('div', {
					className: `dsh-rea-banner ${probe.ok ? 'dsh-rea-banner-ok' : 'dsh-rea-banner-bad'}`,
				}, probe.ok ? `${probe.tools} 个工具 / ${Math.round(probe.elapsedMs / 100) / 10}s` : `连接失败：${probe.error}`),

				installing === true ? h('div', { className: 'dsh-rea-banner' }, `正在安装${install.version === undefined ? '' : ` v${install.version}`}…`) : null,

				h(Fold, { title: '详细信息', hint: '启动行 · 来源 · 数据目录', open: open.details, onToggle: () => toggle('details') },
					h('dl', { className: 'dsh-rea-kv' },
						h('dt', null, '启动命令'),
						h('dd', { className: 'dsh-rea-mono' }, `${launch.command} ${(launch.args ?? []).join(' ')}`),
						h('dt', null, '数据目录'),
						h('dd', { className: 'dsh-rea-mono' }, data.dataDir)),
					h('div', { className: 'dsh-rea-list' },
						data.candidates.map((item) => h(CandidateRow, { key: item.origin, item })))),

				h(Fold, { title: '手动指定 rea.mjs', hint: '已有本地 REA 时用这个', open: open.manual, onToggle: () => toggle('manual') },
					h('div', { className: 'dsh-rea-row' },
						h('div', { className: 'dsh-rea-field' },
							h('label', { htmlFor: 'dsh-rea-path' }, '绝对路径'),
							h('input', {
								id: 'dsh-rea-path',
								type: 'text',
								value: pathDraft,
								placeholder: 'C:\\...\\rea-agents\\scripts\\rea.mjs',
								onChange: (event) => setPathDraft(event.target.value),
							})),
						h('div', { className: 'dsh-rea-actions' },
							h('button', {
								type: 'button',
								disabled: busy !== undefined || pathDraft.trim().length === 0,
								onClick: () => run('save', async () => {
									await api('/set-path', { path: pathDraft })
									setNotice({ tone: 'ok', text: '已保存，下次调用使用新路径' })
								}),
							}, busy === 'save' ? '保存中…' : '保存'),
							h('button', {
								type: 'button',
								disabled: busy !== undefined,
								onClick: () => run('clear', async () => {
									await api('/clear-path', {})
									setPathDraft('')
									setNotice({ tone: 'ok', text: '已清除手动路径' })
								}),
							}, '清除'))),
					h('p', { className: 'dsh-rea-hint' }, '保存后会停掉当前进程，下次调用按新路径重新启动。')),

				h(Fold, { title: '从 npm 安装', hint: '装到插件数据目录', open: open.install, onToggle: () => toggle('install') },
					h('div', { className: 'dsh-rea-row' },
						h('div', { className: 'dsh-rea-field' },
							h('label', { htmlFor: 'dsh-rea-version' }, '版本'),
							h('input', {
								id: 'dsh-rea-version',
								type: 'text',
								value: versionDraft,
								onChange: (event) => setVersionDraft(event.target.value),
							})),
						h('div', { className: 'dsh-rea-actions' },
							h('button', {
								type: 'button',
								className: 'dsh-rea-primary',
								disabled: busy !== undefined || installing === true,
								onClick: () => run('install', async () => {
									await api('/install', { version: versionDraft })
									setNotice({ tone: 'ok', text: '安装已开始' })
								}),
							}, installing === true ? '安装中…' : '安装'),
							installing === true
								? h('button', {
									type: 'button',
									onClick: () => run('cancel', async () => {
										await api('/cancel-install', {})
									}),
								}, '取消')
								: null)),
					h('p', { className: 'dsh-rea-hint' }, `安装位置：${data.dataDir}\\node_modules`),
					install === undefined || install.status === 'idle' ? null : h('div', { className: 'dsh-rea-banner ' + (install.status === 'done' ? 'dsh-rea-banner-ok' : install.status === 'running' ? '' : 'dsh-rea-banner-bad') },
						install.status === 'running'
							? `正在安装${install.version === undefined ? '' : ` v${install.version}`}…`
							: install.status === 'done'
								? `安装完成${install.version === undefined ? '' : ` v${install.version}`}`
								: install.status === 'cancelled'
									? '安装已取消'
									: `安装失败：${install.error ?? '未知原因'}`),
					install?.log === undefined || install.log.length === 0 ? null : h('pre', { className: 'dsh-rea-mono dsh-rea-log' }, install.log.slice(-4000))),

				notice === undefined ? null : h('div', { className: 'dsh-rea-banner ' + (notice.tone === 'ok' ? 'dsh-rea-banner-ok' : 'dsh-rea-banner-bad') }, notice.text))
		}

		const name = 'rea'
		const inject = ['slots']

		/** Mount the settings section. */
		function apply(ctx) {
			if (react === undefined) {
				ctx.logger?.warn?.('rea: React 不可用，设置页未挂载')
				return
			}
			installStyles()
			if (ctx.slots === undefined || ctx.slots === null) return
			try {
				ctx.slots.inject('settings.section', () => ctx.slots.register({
					name: 'settings.section',
					id: 'rea',
					order: 65,
					label: () => '逆向工程 REA',
				}, ReaSection))
			} catch (error) {
				ctx.logger?.warn?.(`rea: 设置页挂载失败：${error?.message ?? error}`)
			}
		}

		exports.name = name
		exports.inject = inject
		exports.apply = apply
		exports.ReaSection = ReaSection
		return module.exports
	},
})
