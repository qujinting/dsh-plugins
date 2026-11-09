/**
 * dsh-theme — browser half.
 *
 * A hand-written `__ModuleLoader__` factory (no build step). It requires only
 * React, which the shell seeds in its frozen platform module table; everything
 * else is DOM work:
 *
 *   · keeps the host-injected stylesheet fresh. The desktop app collects index
 *     injections once per launch, so a stylesheet edit would otherwise need a
 *     full app restart; fetching `/api/dsh-theme/injected.css` on every page
 *     load makes "refresh the window" enough.
 *   · owns the enable/disable switch. The host's <style> carries a revision
 *     marker comment; disabling blanks that text and restoring puts it back, so
 *     the untouched inline `--dsw-*` values written by ui-layout take over again
 *     with no bookkeeping.
 *   · mounts the sidebar control (toggle + replay) and the diagnostics handle
 *     `window.__dshTheme`.
 *
 * Nothing here may throw into the app: every entry point is wrapped, and a
 * failure is recorded in localStorage for the error report.
 */

window.__ModuleLoader__.load({
	id: 'dsh-theme',
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

		// ----------------------------------------------------------- constants

		const PACKAGE = 'dsh-theme'
		const API = '/api/dsh-theme'
		const MARKER = '/* dsh-theme'
		const MARKER_PATTERN = /\/\* dsh-theme rev:([^*]+) \*\//
		const STORAGE_KEY = 'dsh-theme.enabled'
		const ERROR_KEY = 'dsh-theme.last-error'
		const VERSION = 1

		// ------------------------------------------------------------- storage

		/**
		 * `localStorage` can throw on the very first access in some desktop
		 * shells; an in-memory fallback keeps the switch usable for the session.
		 */
		function createStorage() {
			try {
				const probe = '__dsh_theme_orbital_probe__'
				window.localStorage.setItem(probe, '1')
				window.localStorage.removeItem(probe)
				return window.localStorage
			} catch {
				const memory = new Map()
				return {
					getItem: (key) => (memory.has(key) ? memory.get(key) : null),
					setItem: (key, value) => memory.set(key, String(value)),
					removeItem: (key) => memory.delete(key),
				}
			}
		}

		const storage = createStorage()

		function recordFailure(error) {
			const detail = error && error.stack !== undefined ? error.stack : String(error)
			try {
				storage.setItem(ERROR_KEY, detail)
			} catch {
				/* diagnostics are best-effort */
			}
		}

		function readStoredEnabled() {
			try {
				return storage.getItem(STORAGE_KEY) !== 'off'
			} catch {
				return true
			}
		}

		function writeStoredEnabled(enabled) {
			try {
				storage.setItem(STORAGE_KEY, enabled ? 'on' : 'off')
			} catch {
				/* best-effort */
			}
		}

		// -------------------------------------------------------------- state

		const state = {
			enabled: readStoredEnabled(),
			/** Text the host injected, kept so disabling is reversible in place. */
			originalStyleText: undefined,
			styleTag: undefined,
			revision: undefined,
			lastError: undefined,
		}

		const listeners = new Set()

		function publish() {
			for (const listener of [...listeners]) {
				try {
					listener()
				} catch {
					/* a broken subscriber must not break the rest */
				}
			}
		}

		function subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		}

		// --------------------------------------------------------- stylesheet

		/** Find the host-injected stylesheet by its revision marker. */
		function findInjectedStyle() {
			if (state.styleTag !== undefined && state.styleTag.isConnected) return state.styleTag
			for (const tag of document.head.querySelectorAll('style')) {
				if (tag.textContent !== null && tag.textContent.startsWith(MARKER)) {
					state.styleTag = tag
					return tag
				}
			}
			return undefined
		}

		/** Read the revision recorded in a marker-tagged stylesheet. */
		function readRevision(text) {
			const match = MARKER_PATTERN.exec(text ?? '')
			return match === null ? undefined : match[1]
		}

		/**
		 * Replace the stylesheet with whatever the host currently serves.
		 * A no-op when revision and text already agree.
		 */
		async function refreshStylesheet() {
			if (!state.enabled) return
			let tag = findInjectedStyle()
			try {
				const revision = readRevision(tag?.textContent)
				const query = revision === undefined ? '' : `?rev=${encodeURIComponent(revision)}`
				const response = await fetch(`${API}/injected.css${query}`, { cache: 'no-store' })
				if (response.status === 304) return
				if (!response.ok) return
				const text = await response.text()
				if (text.startsWith(MARKER) === false) return
				if (tag === undefined) {
					tag = document.createElement('style')
					tag.dataset.dshTheme = 'orbital'
					document.head.appendChild(tag)
					state.styleTag = tag
				}
				if (state.originalStyleText === undefined || !state.enabled) {
					/* disabled pages keep a blanked tag; never overwrite with the stale copy */
					state.originalStyleText = undefined
				}
				tag.textContent = text
				state.originalStyleText = text
				state.revision = readRevision(text)
			} catch (error) {
				state.lastError = String(error)
				recordFailure(error)
			}
		}

		// ------------------------------------------------------------- scheme

		/**
		 * DeepSeek Blue is a single-scheme design: the palette's dark projection
		 * is written onto <body> inline, so the app renders the abyss even when the
		 * DSH appearance preference is light. The host's token layer already ships
		 * the dark values under both schemes; this extra pass also covers a host
		 * process that started before that behaviour landed — a page refresh is
		 * enough to see the design.
		 */
		const FORCED_SCHEME = 'dark'
		/** The app marks its dark styles on <body>; the design needs it even in light preference. */
		const DARK_ATTRIBUTE = 'data-ds-dark-theme'
		/** Inline properties this half wrote, so disabling can remove exactly them. */
		let forcedTokens = []
		/** Re-asserts the dark attribute when the app's theme service clears it. */
		let darkAttributeObserver

		function clearForcedScheme() {
			for (const token of forcedTokens) {
				try {
					document.body.style.removeProperty(token)
				} catch {
					/* best-effort */
				}
			}
			forcedTokens = []
			try {
				document.documentElement.style.removeProperty('color-scheme')
			} catch {
				/* best-effort */
			}
		}

		async function applyForcedScheme() {
			if (!state.enabled || document.body === null) return
			const palette = await fetchJson(`${API}/palette.json`)
			if (palette === null || typeof palette !== 'object') return
			if (!state.enabled) return
			clearForcedScheme()
			const push = (pairs, important) => {
				for (const [token, pair] of Object.entries(pairs ?? {})) {
					const value = pair === null || typeof pair !== 'object' ? undefined : pair[FORCED_SCHEME]
					if (typeof value !== 'string') continue
					try {
						document.body.style.setProperty(token, value, important ? 'important' : '')
						forcedTokens.push(token)
					} catch {
						/* a broken token must not break the rest */
					}
				}
			}
			push(palette.alias, true)
			push(palette.specific, true)
			try {
				document.documentElement.style.setProperty('color-scheme', FORCED_SCHEME, 'important')
			} catch {
				/* best-effort */
			}
		}

		/**
		 * Force the app's own dark styles on as well. Overriding tokens is not
		 * enough: several components (the file-changes card, diff gutters, menus)
		 * pick their static neutral scale from `body[data-ds-dark-theme]`, so with a
		 * light appearance preference those rules resolve to light neutrals and the
		 * card stays white. Setting the attribute makes every scheme-conditional rule
		 * in the app take its dark branch.
		 */
		function claimDarkAttribute() {
			if (document.body === null) return
			if (!document.body.hasAttribute(DARK_ATTRIBUTE)) document.body.setAttribute(DARK_ATTRIBUTE, '')
			if (darkAttributeObserver !== undefined || typeof MutationObserver !== 'function') return
			darkAttributeObserver = new MutationObserver(() => {
				if (!state.enabled || document.body === null) return
				if (!document.body.hasAttribute(DARK_ATTRIBUTE)) document.body.setAttribute(DARK_ATTRIBUTE, '')
			})
			darkAttributeObserver.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] })
		}

		function releaseDarkAttribute() {
			if (darkAttributeObserver !== undefined) {
				darkAttributeObserver.disconnect()
				darkAttributeObserver = undefined
			}
			if (document.body === null) return
			/* Leave it alone when DSH itself is in dark mode: the app owns it then. */
			const source = document.documentElement.dataset.dsThemeSource
			if (source !== 'dark') document.body.removeAttribute(DARK_ATTRIBUTE)
		}

		// -------------------------------------------------- enable / disable

		/** Apply the switch to the live document. */
		function applyEnabled(enabled, persist) {
			state.enabled = enabled
			const root = document.documentElement
			if (enabled) {
				root.dataset.dshTheme = 'orbital'
				const tag = findInjectedStyle()
				if (tag !== undefined && state.originalStyleText !== undefined) tag.textContent = state.originalStyleText
				claimDarkAttribute()
				void refreshStylesheet()
				void applyForcedScheme()
				void syncBackgroundVideo()
			} else {
				root.dataset.dshTheme = 'off'
				releaseDarkAttribute()
				clearForcedScheme()
				removeBackgroundVideo()
				const tag = findInjectedStyle()
				if (tag !== undefined) {
					if (state.originalStyleText === undefined) state.originalStyleText = tag.textContent
					tag.textContent = `${MARKER} disabled */`
				}
			}
			if (persist) writeStoredEnabled(enabled)
			publish()
		}

		function setEnabled(enabled) {
			applyEnabled(enabled, true)
			return enabled
		}

		function toggle() {
			return setEnabled(!state.enabled)
		}

		// ------------------------------------------------------------ replay

		/** Replay the entrance veil on demand (also used by the acceptance probe). */
		async function replay() {
			try {
				if (document.getElementById('dsh-theme-veil') !== null) return false
				const status = await fetchJson(`${API}/status`)
				if (status === undefined || status.animation === 'none') return false
				const markup = await fetchText(`${API}/boot.html`)
				if (markup === undefined) return false
				const holder = document.createElement('div')
				holder.innerHTML = markup
				const veil = holder.firstElementChild
				if (veil === null) return false
				document.body.appendChild(veil)
				const play = globalThis.__dshThemePlayVeil
				if (typeof play !== 'function') {
					veil.remove()
					return false
				}
				return play({ ...status, playOn: 'always' }) === true
			} catch (error) {
				state.lastError = String(error)
				recordFailure(error)
				return false
			}
		}

		async function fetchJson(url) {
			const response = await fetch(url, { cache: 'no-store' })
			if (!response.ok) return undefined
			return response.json()
		}

		async function fetchText(url) {
			const response = await fetch(url, { cache: 'no-store' })
			if (!response.ok) return undefined
			return response.text()
		}

		// ---------------------------------------------------- background film

		/** The optional looping wallpaper element (only when configured). */
		let backgroundVideo
		/** Watches for chat turns so the wallpaper only decodes while it is visible. */
		let wallpaperObserver
		let wallpaperTimer
		/** Window-resize hook that re-pins the wallpaper to the frame geometry. */
		let wallpaperResize
		let wallpaperResizeTimer

		function removeBackgroundVideo() {
			if (wallpaperObserver !== undefined) {
				wallpaperObserver.disconnect()
				wallpaperObserver = undefined
			}
			if (wallpaperTimer !== undefined) {
				clearTimeout(wallpaperTimer)
				wallpaperTimer = undefined
			}
			if (wallpaperResizeTimer !== undefined) {
				clearTimeout(wallpaperResizeTimer)
				wallpaperResizeTimer = undefined
			}
			if (wallpaperResize !== undefined) {
				try {
					globalThis.removeEventListener('resize', wallpaperResize)
				} catch {
					/* cosmetic */
				}
				wallpaperResize = undefined
			}
			if (backgroundVideo === undefined) return
			try {
				backgroundVideo.pause()
				backgroundVideo.remove()
			} catch {
				/* removal is cosmetic */
			}
			backgroundVideo = undefined
		}

		/**
		 * The wallpaper stays on in conversations too — the DeepSeek Blue skin
		 * sinks it into the background instead of hiding it, so `backgroundScope`
		 * is the only on/off switch (and the CSS still dims it behind text).
		 * @returns {boolean} whether the film should be decoding right now.
		 */
		function wallpaperVisible() {
			if (!state.enabled || backgroundVideo === undefined) return false
			const hasTurns = document.querySelector('[data-chat-turn]') !== null
			if (document.documentElement.getAttribute('data-dsh-theme-wallpaper') === 'always') return true
			return !hasTurns
		}

		function syncWallpaperPlayback() {
			if (backgroundVideo === undefined) return
			if (wallpaperVisible()) {
				const started = backgroundVideo.play()
				if (started !== undefined && typeof started.catch === 'function') started.catch(() => {})
			} else {
				backgroundVideo.pause()
			}
		}

		/**
		 * The wallpaper is a fixed backdrop, not a stretchable box: pin its pixel
		 * height to the frame (centre-column top → bottom row), so the composer or
		 * the queue dock growing/shrinking can only occlude it, never rescale or
		 * re-crop it. Runs on mount and on window resize only — never on column
		 * layout changes.
		 */
		function pinWallpaperSize() {
			if (backgroundVideo === undefined) return
			const column = backgroundVideo.parentElement
			const frame = column === null ? null : column.parentElement
			if (column === null || frame === null) return
			/* The frame bottom, not the column bottom: a bottom row or a grown
			   composer must never be able to shrink the pinned backdrop. */
			const columnRect = column.getBoundingClientRect()
			const frameRect = frame.getBoundingClientRect()
			const height = Math.round(frameRect.bottom - columnRect.top)
			if (height > 0) backgroundVideo.style.height = `${height}px`
		}

		function watchWallpaperViewport() {
			if (wallpaperResize !== undefined || typeof globalThis.addEventListener !== 'function') {
				pinWallpaperSize()
				return
			}
			wallpaperResize = () => {
				if (wallpaperResizeTimer !== undefined) clearTimeout(wallpaperResizeTimer)
				wallpaperResizeTimer = setTimeout(() => {
					wallpaperResizeTimer = undefined
					pinWallpaperSize()
				}, 120)
			}
			globalThis.addEventListener('resize', wallpaperResize)
			pinWallpaperSize()
			if (typeof globalThis.requestAnimationFrame === 'function') {
				globalThis.requestAnimationFrame(() => pinWallpaperSize())
			}
		}

		/** Re-evaluate playback whenever the conversation gains or loses turns. */
		function watchWallpaper(column) {
			if (typeof globalThis.MutationObserver !== 'function') return
			if (wallpaperObserver !== undefined) wallpaperObserver.disconnect()
			wallpaperObserver = new globalThis.MutationObserver(() => {
				if (wallpaperTimer !== undefined) clearTimeout(wallpaperTimer)
				wallpaperTimer = setTimeout(() => {
					wallpaperTimer = undefined
					syncWallpaperPlayback()
				}, 200)
			})
			wallpaperObserver.observe(column, { childList: true, subtree: true })
			/* 明暗切换会改变“该不该铺壁纸”，所以也要盯 body 的主题属性。 */
			if (document.body !== null) {
				wallpaperObserver.observe(document.body, {
					attributes: true,
					attributeFilter: ['data-ds-dark-theme'],
				})
			}
		}

		/**
		 * Mount the configured wallpaper into the conversation column. The app
		 * mounts after this plug-in applies, so the first attempts retry until the
		 * column exists; a column that never appears just leaves the film off.
		 */
		async function syncBackgroundVideo(attempt = 0) {
			try {
				if (!state.enabled) {
					removeBackgroundVideo()
					return
				}
				const status = await fetchJson(`${API}/status`)
				if (status === undefined || !status.backgroundVideo) {
					removeBackgroundVideo()
					return
				}
				if (backgroundVideo !== undefined && backgroundVideo.isConnected) return
				const column = document.querySelector('#root div:has(> [data-shell-overlay]) > div:nth-of-type(2)')
				if (column === null) {
					if (attempt < 10) setTimeout(() => void syncBackgroundVideo(attempt + 1), 600)
					return
				}
				const video = document.createElement('video')
				video.className = 'orbital-theme-bg'
				video.muted = true
				video.loop = true
				video.playsInline = true
				video.preload = 'auto'
				video.setAttribute('muted', '')
				video.setAttribute('playsinline', '')
				video.setAttribute('aria-hidden', 'true')
				video.src = `${API}/video/bg`
				column.appendChild(video)
				backgroundVideo = video
				if (typeof status.backgroundScope === 'string' && status.backgroundScope !== '') {
					document.documentElement.setAttribute('data-dsh-theme-wallpaper', status.backgroundScope)
				}
				watchWallpaper(column)
				watchWallpaperViewport()
				syncWallpaperPlayback()
			} catch (error) {
				state.lastError = String(error)
				recordFailure(error)
			}
		}

		// --------------------------------------------------------------- UI

		const UI_CSS = `
.orbital-theme-action{display:flex;align-items:center;box-sizing:border-box;width:100%;min-width:0;height:36px;padding:0 5px 0 0;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);transition:background 160ms var(--ds-ease-in-out),border-color 160ms var(--ds-ease-in-out)}
.orbital-theme-action:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 42%,transparent)}
.orbital-theme-action:has(.orbital-theme-btn[aria-pressed='false']){border-color:var(--dsw-alias-border-l2);background:transparent}
.orbital-theme-btn{display:flex;align-items:center;box-sizing:border-box;gap:9px;flex:1;min-width:0;height:100%;padding:0 0 0 10px;border:0;border-radius:10px;background:transparent;color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-label-primary));font:inherit;font-size:13px;font-weight:500;line-height:1;text-align:left;cursor:pointer}
.orbital-theme-action:has(.orbital-theme-btn[aria-pressed='false']) .orbital-theme-btn{color:var(--dsw-alias-label-secondary)}
.orbital-theme-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);box-shadow:0 0 6px color-mix(in srgb,var(--dsw-alias-brand-primary) 60%,transparent)}
.orbital-theme-action:has(.orbital-theme-btn[aria-pressed='false']) .orbital-theme-dot{background:transparent;box-shadow:inset 0 0 0 1px var(--dsw-alias-label-tertiary)}
.orbital-theme-replay{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;flex:none;width:30px;height:30px;padding:0;border:0;border-radius:8px;background:transparent;color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-label-primary));cursor:pointer}
.orbital-theme-replay:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);color:var(--dsw-alias-label-primary)}
.orbital-theme-btn:focus-visible,.orbital-theme-replay:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.orbital-theme-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`

		function installUiStyles() {
			const tagId = `${PACKAGE}/ui.css`
			if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {}
			const tag = document.createElement('style')
			tag.dataset.plugin = PACKAGE
			tag.dataset.pluginCss = tagId
			tag.textContent = UI_CSS
			document.head.appendChild(tag)
			return () => tag.remove()
		}

		/** Subscribe a component to the module-level switch state. */
		function useThemeState() {
			const [, force] = react.useState(0)
			react.useEffect(() => subscribe(() => force((value) => value + 1)), [])
			return state.enabled
		}

		/**
		 * The sidebar-foot control, matching the prototype: one full-width pill with
		 * a brand dot + label (the toggle) and a replay triangle on the right.
		 * Disabled, the pill goes quiet (no fill, hollow dot, label "经典界面").
		 */
		function ThemeToggle(props) {
			const enabled = useThemeState()
			const wide = props?.wide !== false
			const label = enabled ? '深潜主题' : '经典界面'
			const children = [
				react.createElement('span', { key: 'dot', className: 'orbital-theme-dot', 'aria-hidden': 'true' }),
			]
			if (wide) children.push(react.createElement('span', { key: 'label', className: 'orbital-theme-label' }, label))
			const toggleButton = react.createElement(
				'button',
				{
					key: 'toggle',
					type: 'button',
					className: 'orbital-theme-btn',
					title: enabled ? '切换到 DSH 原生界面' : '启用深潜主题（DeepSeek Blue）',
					'aria-pressed': enabled,
					onClick: () => {
						toggle()
					},
				},
				children,
			)
			if (!enabled) {
				return react.createElement('div', { className: 'orbital-theme-action' }, toggleButton)
			}
			const replayIcon = react.createElement(
				'svg',
				{
					width: 13,
					height: 13,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.7,
					strokeLinejoin: 'round',
					strokeLinecap: 'round',
					'aria-hidden': 'true',
				},
				react.createElement('path', { d: 'M8.5 5.8 18 12 8.5 18.2Z' }),
			)
			const replayButton = react.createElement(
				'button',
				{
					key: 'replay',
					type: 'button',
					className: 'orbital-theme-replay',
					title: '重播启动动画',
					'aria-label': '重播启动动画',
					onClick: () => {
						void replay()
					},
				},
				replayIcon,
			)
			return react.createElement('div', { className: 'orbital-theme-action' }, toggleButton, replayButton)
		}

		// ------------------------------------------------------------ runtime

		/** Required services: the UI slot registry. */
		const inject = ['slots']

		/**
		 * Client plugin body: bring the stylesheet in sync, restore the saved
		 * switch state, mount the sidebar control, publish diagnostics.
		 * @param ctx client cordis context.
		 */
		function apply(ctx) {
			try {
				const root = document.documentElement
				root.dataset.dshTheme = state.enabled ? 'orbital' : 'off'
				const tag = findInjectedStyle()
				if (tag !== undefined) {
					state.originalStyleText = tag.textContent
					state.revision = readRevision(tag.textContent)
				}
				if (!state.enabled) applyEnabled(false, false)
				else {
					claimDarkAttribute()
					void applyForcedScheme()
					void refreshStylesheet()
					void syncBackgroundVideo()
				}

				const stopUiStyles = installUiStyles()
				let disposeSlot
				try {
					if (react !== undefined && ctx.slots !== undefined && ctx.slots !== null) {
						disposeSlot = ctx.slots.inject('sidebar.footer.action', () =>
							ctx.slots.register(
								{
									name: 'sidebar.footer.action',
									id: PACKAGE,
									order: 60,
									label: () => (state.enabled ? '深潜主题' : '经典界面'),
								},
								ThemeToggle,
							),
						)
					}
				} catch (error) {
					ctx.logger?.warn?.(`dsh-theme: sidebar control unavailable: ${error?.message ?? error}`)
				}

				ctx.effect(
					() => () => {
						if (typeof disposeSlot === 'function') disposeSlot()
						stopUiStyles()
						removeBackgroundVideo()
						releaseDarkAttribute()
						clearForcedScheme()
						document.documentElement.removeAttribute('data-dsh-theme')
						document.documentElement.removeAttribute('data-dsh-theme-wallpaper')
					},
					'dsh-theme: client lifecycle',
				)
			} catch (error) {
				state.lastError = String(error)
				recordFailure(error)
				ctx.logger?.warn?.(`dsh-theme: client half failed: ${error?.message ?? error}`)
			}
		}

		// -------------------------------------------------------- diagnostics

		globalThis.__dshTheme = {
			version: VERSION,
			status: () => ({
				version: VERSION,
				enabled: state.enabled,
				revision: state.revision,
				hasInjectedStylesheet: findInjectedStyle() !== undefined,
				playVeil: typeof globalThis.__dshThemePlayVeil === 'function',
				lastError: state.lastError,
			}),
			enable: () => setEnabled(true),
			disable: () => setEnabled(false),
			toggle,
			replay,
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
