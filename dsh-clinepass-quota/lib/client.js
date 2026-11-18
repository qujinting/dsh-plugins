// dsh-clinepass-quota — 浏览器半边。
//
// 两个落点，共用一个主体：
//
//   * **设置 → ClinePass 额度**：完整信息 —— 三档窗口、余额、Key 的来源。
//   * **会话标题栏的徽章**：一眼看到最紧的那档还剩多少，点开是同一份面板。
//
// 手写 `__ModuleLoader__` 工厂、没有构建步骤：模块表里只有 React，而这里
// 需要的也只有 React。所有数据来自 Host 半边的 `/api/dsh-clinepass-quota`，
// 页面自己不发上游请求 —— 缓存、key 解析、错误归一化都只有一份实现。
//
// 三个刻意的选择：
//
//   * **徽章不是装饰。** 它显示「最紧张的那档窗口」的剩余百分比：用户真正想
//     知道的是「我还能不能跑一次长任务」，而不是三行数字里挑一行看。
//   * **失败要看得见。** 网络错误、key 被拒、没有订阅都渲染成不同颜色的横幅，
//     旧快照继续显示并标注「缓存」—— 一个 401 不该让页面变成白板。
//   * **key 不在这里配。** 凭据的唯一入口是 DSH 的凭据存储；面板只报告读到
//     了哪个来源、掩码长什么样。多一个输入框就等于多一条要维护的写路径。

window.__ModuleLoader__.load({
	id: 'dsh-clinepass-quota',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		// 唯一的外部依赖，防御性解析：没播种 React 的 shell 应该只丢掉这个
		// 界面，而不是整块设置面板。
		let react
		try {
			react = require('react')
		} catch {
			react = undefined
		}

		// ------------------------------------------------------------ 常量

		const API = '/api/dsh-clinepass-quota'
		const STYLE_ID = 'dsh-cpq-style'

		/** 页面自动刷新间隔：配额是按小时滚的，5 分钟足够。 */
		const AUTO_REFRESH_MS = 5 * 60_000

		const h = react === undefined ? undefined : react.createElement

		// ------------------------------------------------------------ 工具

		/** 把路由路径变成绝对 URL（同一页面源下都成立）。 */
		function absoluteUrl(path) {
			return new URL(path, window.location.href).href
		}

		/**
		 * 调一次 host 路由并拆信封。
		 *
		 * HTTP 层失败抛错；业务失败（`ok: false`）由调用方从 payload.error 读。
		 */
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

		/** 百分比去掉无意义的小数位。 */
		function percentText(value) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
			const rounded = Math.round(value * 10) / 10
			return Number.isInteger(rounded) ? `${String(rounded)}%` : `${rounded.toFixed(1)}%`
		}

		/**
		 * 美元金额的展示文本：小于 1 美元时给足微美元精度。
		 *
		 * 余额是微美元精度（$0.190123），固定两位会把它写成 $0.19 —— 看着像差了
		 * 一截；固定六位又像设备读数。所以取六位后裁掉尾零：有多少精度显示多少。
		 */
		function usdText(usd) {
			if (typeof usd !== 'number' || !Number.isFinite(usd)) return '—'
			if (usd === 0) return '0.00'
			if (Math.abs(usd) >= 1) return usd.toFixed(2)
			const six = usd.toFixed(6)
			const trimmed = six.replace(/0+$/u, '')
			return trimmed.endsWith('.') ? six : trimmed
		}

		/** key 来源的一句话标签。 */
		function sourceLabel(source) {
			if (source === 'credentials') return '凭据存储'
			if (source === 'config') return '插件配置'
			if (source === 'env') return '环境变量'
			if (source === 'file') return '本地文件'
			return '未知来源'
		}

		/** 剩余量的语义色：够用 / 吃紧 / 见底。 */		function levelOf(percentRemaining) {
			if (typeof percentRemaining !== 'number') return 'idle'
			if (percentRemaining <= 10) return 'error'
			if (percentRemaining <= 25) return 'warn'
			return 'ok'
		}

		/** 剩余进度条的颜色。 */
		function barColor(percentRemaining) {
			const level = levelOf(percentRemaining)
			if (level === 'error') return 'var(--dsw-alias-state-error-primary, #dc2626)'
			if (level === 'warn') return 'var(--dsw-alias-state-warn-primary, #d97706)'
			if (level === 'ok') return 'var(--dsw-alias-state-success-primary, #16a34a)'
			return 'var(--dsw-alias-state-idle-primary, #9ca3af)'
		}

		/** 一个 ISO 时间 → 「3 小时 12 分钟后重置」。 */
		function resetText(iso) {
			if (typeof iso !== 'string' || iso.length === 0) return undefined
			const at = Date.parse(iso)
			if (Number.isNaN(at)) return iso
			const diff = at - Date.now()
			if (diff <= 0) return '即将重置'
			const minutes = Math.round(diff / 60_000)
			if (minutes < 1) return '不到 1 分钟后重置'
			if (minutes < 60) return `${String(minutes)} 分钟后重置`
			const hours = Math.floor(minutes / 60)
			const rest = minutes % 60
			if (hours < 24) return `${String(hours)} 小时${rest > 0 ? ` ${String(rest)} 分钟` : ''}后重置`
			return `${new Date(at).toLocaleString('zh-CN', { hour12: false })} 重置`
		}

		/** 一个时间戳 → 本地时间字符串。 */
		function timeText(value) {
			if (typeof value !== 'string' || value.length === 0) return '—'
			const date = new Date(value)
			if (Number.isNaN(date.getTime())) return value
			return date.toLocaleString('zh-CN', { hour12: false })
		}

		/** 「12 秒前」「3 分钟前」。 */
		function ageText(seconds) {
			if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '刚刚'
			if (seconds < 5) return '刚刚'
			if (seconds < 60) return `${String(Math.round(seconds))} 秒前`
			const minutes = Math.round(seconds / 60)
			if (minutes < 60) return `${String(minutes)} 分钟前`
			return `${String(Math.round(minutes / 60))} 小时前`
		}

		/** 从快照里挑出最紧的一档窗口（剩余最少且有数据的）。 */
		function tightestWindow(snapshot) {
			if (snapshot === undefined || !Array.isArray(snapshot.windows)) return undefined
			let tightest
			for (const window of snapshot.windows) {
				if (typeof window.percentRemaining !== 'number') continue
				if (tightest === undefined || window.percentRemaining < tightest.percentRemaining) tightest = window
			}
			return tightest
		}

		/** 徽章上的一行摘要。 */
		function badgeText(state) {
			if (state === undefined) return 'ClinePass'
			const tightest = tightestWindow(state.snapshot)
			if (tightest !== undefined) return percentText(tightest.percentRemaining)
			if (state.error !== undefined) return '—'
			return 'ClinePass'
		}

		// ------------------------------------------------------------ 样式

		const STYLE = `
.cpq { display: flex; flex-direction: column; gap: 14px; font-size: 13px; color: var(--dsw-alias-label-primary, #111827); }
.cpq-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.cpq-head-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.cpq-title { font-size: 15px; font-weight: 600; }
.cpq-sub { color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; line-height: 1.55; }
.cpq-banner { border-radius: 8px; padding: 8px 10px; line-height: 1.5; border: 1px solid transparent; }
.cpq-banner-error { color: var(--dsw-alias-state-error-primary, #b91c1c); border-color: var(--dsw-alias-state-error-primary, #b91c1c); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #b91c1c) 8%, transparent); }
.cpq-banner-warn { color: var(--dsw-alias-state-warn-primary, #b45309); border-color: var(--dsw-alias-state-warn-primary, #b45309); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b45309) 8%, transparent); }
.cpq-banner-ok { color: var(--dsw-alias-state-success-primary, #15803d); border-color: var(--dsw-alias-state-success-primary, #15803d); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #15803d) 8%, transparent); }
.cpq-windows { display: flex; flex-direction: column; gap: 10px; }
.cpq-window { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #f9fafb); border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08)); }
.cpq-window-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.cpq-window-label { font-weight: 600; }
.cpq-window-left { font-variant-numeric: tabular-nums; font-weight: 600; }
.cpq-window-left.cpq-level-ok { color: var(--dsw-alias-state-success-primary, #15803d); }
.cpq-window-left.cpq-level-warn { color: var(--dsw-alias-state-warn-primary, #b45309); }
.cpq-window-left.cpq-level-error { color: var(--dsw-alias-state-error-primary, #b91c1c); }
.cpq-window-left.cpq-level-idle { color: var(--dsw-alias-state-idle-primary, #6b7280); }
.cpq-bar { height: 6px; border-radius: 999px; overflow: hidden; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.08)); }
.cpq-bar-fill { height: 100%; border-radius: 999px; transition: width 200ms ease; }
.cpq-window-foot { color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
.cpq-facts { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); }
.cpq-facts b { color: var(--dsw-alias-label-primary, #111827); font-weight: 600; }
.cpq-btn {
  box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px; font: inherit; line-height: 1.4; cursor: pointer;
  color: var(--dsw-alias-label-primary, #111827);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.16));
  border-radius: 6px;
}
.cpq-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, #f3f4f6); }
.cpq-btn:disabled { opacity: 0.55; cursor: default; }
.cpq-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; }
.cpq-btn-primary { color: #ffffff; background: var(--dsw-alias-brand-primary, #2563eb); border-color: transparent; }
.cpq-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary, #2563eb); filter: brightness(1.08); }
.cpq-btn-ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary, #6b7280); }
.cpq-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: var(--dsw-alias-label-primary, #111827); }
.cpq-badge {
  display: inline-flex; align-items: center; gap: 6px; max-width: 160px;
  padding: 3px 8px; font: inherit; font-size: 12px; line-height: 1.5; cursor: pointer;
  color: var(--dsw-alias-label-secondary, #6b7280);
  background: transparent; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08));
  border-radius: 999px;
}
.cpq-badge:hover { background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: var(--dsw-alias-label-primary, #111827); }
.cpq-badge:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; }
.cpq-badge-dot { width: 7px; height: 7px; border-radius: 999px; flex: none; }
.cpq-badge-value { font-variant-numeric: tabular-nums; font-weight: 600; }
.cpq-mask {
  position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
  padding: 24px; background: rgba(0, 0, 0, 0.42);
}
.cpq-dialog {
  box-sizing: border-box; width: min(480px, 100%); max-height: min(80vh, 720px); overflow: hidden;
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-overlay, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.16));
  border-radius: 12px; box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
}
.cpq-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 16px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08)); }
.cpq-dialog-body { padding: 14px 16px 16px; overflow: auto; }
.cpq-iconbtn {
  box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; cursor: pointer; flex: none;
  color: var(--dsw-alias-label-secondary, #6b7280);
  background: transparent; border: 1px solid transparent; border-radius: 6px;
}
.cpq-iconbtn:hover { background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: var(--dsw-alias-label-primary, #111827); }
.cpq-iconbtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; }
.cpq-empty { color: var(--dsw-alias-label-secondary, #6b7280); line-height: 1.6; }
.cpq-foot { display: flex; flex-wrap: wrap; gap: 6px 12px; color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; }
`

		/** 注入一次样式；重复调用是空操作。 */
		function installStyles() {
			if (typeof document === 'undefined') return
			if (document.getElementById(STYLE_ID) !== null) return
			const element = document.createElement('style')
			element.id = STYLE_ID
			element.textContent = STYLE
			document.head.appendChild(element)
		}

		const CLOSE_ICON = h === undefined ? undefined : h('svg', {
			width: 14,
			height: 14,
			viewBox: '0 0 14 14',
			'aria-hidden': 'true',
		}, h('path', {
			d: 'M3 3l8 8M11 3l-8 8',
			stroke: 'currentColor',
			strokeWidth: 1.6,
			strokeLinecap: 'round',
			fill: 'none',
		}))

		const GAUGE_ICON = h === undefined ? undefined : h('svg', {
			width: 13,
			height: 13,
			viewBox: '0 0 16 16',
			'aria-hidden': 'true',
		}, h('path', {
			d: 'M2.5 12.5a6 6 0 1 1 11 0',
			stroke: 'currentColor',
			strokeWidth: 1.5,
			strokeLinecap: 'round',
			fill: 'none',
		}), h('path', {
			d: 'M8 12.5L11 7',
			stroke: 'currentColor',
			strokeWidth: 1.5,
			strokeLinecap: 'round',
			fill: 'none',
		}))

		// ------------------------------------------------------------ 界面

		/**
		 * 共用主体：设置页与对话框都是它。
		 *
		 * @param props.compact - 对话框里少一段说明文字。
		 */
		function QuotaPanel(props) {
			const { useState, useEffect, useCallback } = react
			const [data, setData] = useState(undefined)
			const [error, setError] = useState(undefined)
			const [busy, setBusy] = useState(false)

			const load = useCallback(async (force) => {
				setBusy(true)
				setError(undefined)
				try {
					const payload = force === true ? await api('/refresh', {}) : await api('/state')
					setData(payload)
				} catch (failure) {
					setError(failure?.message ?? String(failure))
				} finally {
					setBusy(false)
				}
			}, [])

			useEffect(() => {
				void load(false)
				const timer = setInterval(() => {
					void load(false)
				}, AUTO_REFRESH_MS)
				return () => clearInterval(timer)
			}, [load])

			const snapshot = data?.snapshot
			const windows = snapshot !== undefined && Array.isArray(snapshot.windows) ? snapshot.windows : []
			const key = data?.key
			const businessError = data?.error
			const tightest = tightestWindow(snapshot)

			const banner = (() => {
				if (error !== undefined) return h('div', { className: 'cpq-banner cpq-banner-error' }, error)
				if (businessError !== undefined) {
					const auth = data?.authFailed === true
					return h('div', { className: `cpq-banner ${auth ? 'cpq-banner-error' : 'cpq-banner-warn'}` },
						`${businessError}${snapshot === undefined ? '' : '（下面显示的是上一次成功的结果）'}`)
				}
				return undefined
			})()

			// Key 不在这个页面里配：DSH 的凭据存储是唯一入口，面板只报告它读到了
			// 什么。没有 key 时给一句能照着做的话，而不是一个会分叉的输入框。
			const keyNotice = key?.configured === true
				? undefined
				: h('div', { className: 'cpq-banner cpq-banner-warn' },
					'没有找到 ClinePass 的 API Key。请在 DSH 凭据里配置 CLINEPASS_API_KEY（app.cline.bot → Settings → API Keys 创建），本插件会自动读取。')

			const windowList = windows.length === 0
				? h('div', { className: 'cpq-empty' },
					businessError !== undefined
						? '暂时读不到额度。'
						: (data === undefined ? '正在读取…' : '这个 API Key 的账户没有 ClinePass 订阅，所以没有配额窗口可显示。'))
				: h('div', { className: 'cpq-windows' }, windows.map((window) => {
					const level = levelOf(window.percentRemaining)
					const used = typeof window.percentUsed === 'number' ? window.percentUsed : undefined
					const reset = resetText(window.resetsAt)
					return h('div', { className: 'cpq-window', key: window.key },
						h('div', { className: 'cpq-window-head' },
							h('span', { className: 'cpq-window-label' }, window.label),
							h('span', { className: `cpq-window-left cpq-level-${level}` }, `剩余 ${percentText(window.percentRemaining)}`)),
						h('div', { className: 'cpq-bar' },
							h('div', {
								className: 'cpq-bar-fill',
								style: {
									width: `${String(Math.max(0, Math.min(100, window.percentRemaining ?? 0)))}%`,
									background: barColor(window.percentRemaining),
								},
							})),
						h('div', { className: 'cpq-window-foot' },
							used === undefined ? undefined : h('span', null, `已用 ${percentText(used)}`),
							reset === undefined ? undefined : h('span', null, reset)))
				}))

			const facts = h('div', { className: 'cpq-facts' },
				snapshot?.credits === undefined
					? undefined
					: h('span', null, '按量付费余额 ', h('b', null, `$${usdText(snapshot.credits.usd)}`)),
				snapshot?.account?.email === undefined ? undefined : h('span', null, '账户 ', h('b', null, snapshot.account.email)),
				snapshot?.hasPlan === true && tightest !== undefined
					? h('span', null, '最紧的一档 ', h('b', null, `${tightest.label} 剩余 ${percentText(tightest.percentRemaining)}`))
					: undefined)

			const foot = h('div', { className: 'cpq-foot' },
				h('span', null, snapshot === undefined ? '未查询' : `查询于 ${timeText(snapshot.fetchedAt)}`),
				data?.cache?.ageSeconds === undefined ? undefined : h('span', null, `缓存 ${ageText(data.cache.ageSeconds)}`),
				h('span', null, `自动刷新 ${String(Math.round(AUTO_REFRESH_MS / 60_000))} 分钟`))

			return h('div', { className: 'cpq' },
				props?.compact === true ? undefined : h('div', { className: 'cpq-sub' },
					'ClinePass 是 $9.99/月的定额订阅，配额分三档滚动（5 小时 / 周 / 月），这三组数字与 '
					+ 'app.cline.bot 的订阅页一致；「按量付费余额」是另一套计费，为 0 不代表订阅到期。'),
				banner,
				keyNotice,
				h('div', { className: 'cpq-head' },
					h('div', { className: 'cpq-head-main' },
						h('div', { className: 'cpq-facts' },
							h('span', { title: key?.sourceDetail ?? undefined },
								key?.configured === true
									? `Key ${key.mask} · ${sourceLabel(key.source)}`
									: 'Key 未配置'))),
					h('button', {
						type: 'button',
						className: 'cpq-btn',
						disabled: busy,
						onClick: () => void load(true),
						title: '忽略缓存，重新查询一次',
					}, busy ? '查询中…' : '刷新')),
				windowList,
				facts,
				foot)
		}

		/** 设置页：标题 + 主体。 */
		function SettingsSection() {
			return h('div', { className: 'cpq' },
				h('div', { className: 'cpq-head-main' },
					h('div', { className: 'cpq-title' }, 'ClinePass 额度'),
					h('div', { className: 'cpq-sub' }, '用 Cline API Key 查询订阅配额；Key 存进 DSH 凭据存储，页面只读回掩码。')),
				h(QuotaPanel, null))
		}

		/** 会话标题栏的徽章：点开是同一份面板。 */
		function HeaderQuotaBadge() {
			const { useState, useEffect, useCallback } = react
			const [open, setOpen] = useState(false)
			const [state, setState] = useState(undefined)

			const peek = useCallback(async () => {
				try {
					const payload = await api('/state')
					setState(payload)
				} catch {
					// 徽章读不到就保持中性外观；详细原因在对话框里说。
				}
			}, [])

			useEffect(() => {
				void peek()
				const timer = setInterval(() => {
					void peek()
				}, AUTO_REFRESH_MS)
				return () => clearInterval(timer)
			}, [peek])

			useEffect(() => {
				if (!open) return undefined
				const onKey = (event) => {
					if (event.key === 'Escape') setOpen(false)
				}
				window.addEventListener('keydown', onKey)
				return () => window.removeEventListener('keydown', onKey)
			}, [open])

			// Host 侧 `headerBadge: false` 时这里收起来；第一次渲染还没拿到配置，
			// 先按显示处理，读到配置后自然消失（比整块不挂载换来的闪烁更小）。
			if (state?.ui?.headerBadge === false) return null

			const tightest = tightestWindow(state?.snapshot)
			const label = tightest === undefined
				? 'ClinePass 额度'
				: `ClinePass ${tightest.label}剩余 ${percentText(tightest.percentRemaining)}`
			const fill = barColor(tightest?.percentRemaining)

			const dialog = open
				? h('div', {
					className: 'cpq-mask',
					onClick: () => setOpen(false),
				},
					h('div', {
						className: 'cpq cpq-dialog',
						role: 'dialog',
						'aria-modal': 'true',
						'aria-label': 'ClinePass 额度',
						onClick: (event) => event.stopPropagation(),
					},
						h('div', { className: 'cpq-dialog-head' },
							h('div', null,
								h('div', { className: 'cpq-title' }, 'ClinePass 额度'),
								h('div', { className: 'cpq-sub' }, '5 小时 / 周 / 月三档滚动配额，与 app.cline.bot 订阅页一致。')),
							h('button', {
								type: 'button',
								className: 'cpq-iconbtn',
								title: '关闭',
								'aria-label': '关闭',
								onClick: () => setOpen(false),
							}, CLOSE_ICON)),
						h('div', { className: 'cpq-dialog-body' },
							h(QuotaPanel, { compact: true }))))
				: undefined

			const button = h('button', {
				type: 'button',
				className: 'cpq-badge',
				title: label,
				'aria-label': label,
				'aria-haspopup': 'dialog',
				'aria-expanded': open,
				onClick: () => setOpen(true),
			},
				h('span', { className: 'cpq-badge-dot', style: { background: fill } }),
				GAUGE_ICON,
				h('span', { className: 'cpq-badge-value' }, badgeText(state)))

			return h(react.Fragment, null, button, dialog)
		}

		// ------------------------------------------------------------ 插件

		const name = 'clinepass-quota'
		const inject = ['slots']

		/**
		 * 挂载两个落点。
		 *
		 * 各自 try/catch：缺标题栏座位的 shell 仍然应该拿到设置页，反之亦然。
		 *
		 * @param ctx - client 插件上下文。
		 */
		function apply(ctx) {
			if (react === undefined) {
				ctx.logger?.warn?.('clinepass-quota: React 不可用，客户端界面未挂载')
				return
			}
			installStyles()
			if (ctx.slots === undefined || ctx.slots === null) return

			try {
				ctx.slots.inject('settings.section', () => ctx.slots.register({
					name: 'settings.section',
					id: 'clinepass-quota',
					order: 62,
					label: () => 'ClinePass 额度',
				}, SettingsSection))
			} catch (error) {
				ctx.logger?.warn?.(`clinepass-quota: 设置页挂载失败：${error?.message ?? error}`)
			}

			try {
				ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
					name: 'conversation.session.header.utilities',
					id: 'clinepass-quota',
					order: 6,
					label: () => 'ClinePass 额度',
				}, HeaderQuotaBadge))
			} catch (error) {
				ctx.logger?.warn?.(`clinepass-quota: 标题栏徽章挂载失败：${error?.message ?? error}`)
			}
		}

		exports.name = name
		exports.inject = inject
		exports.apply = apply
		exports.QuotaPanel = QuotaPanel
		exports.SettingsSection = SettingsSection
		exports.HeaderQuotaBadge = HeaderQuotaBadge
		return module.exports
	},
})
