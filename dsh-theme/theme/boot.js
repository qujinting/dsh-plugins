/*
 * dsh-theme — 入场遮罩控制器。
 *
 * 由宿主作为内联 <script> 注入到 body 末尾（在遮罩标记之后、应用挂载之前）。
 * 职责：
 *   1. 决定这次要不要播（配置、减少动态、playOn: cold 的会话标记）；
 *   2. 有 introSrc 时播放 4K 进场影片，等影片结束 + 应用挂载 + 最短停留都满足；
 *      没有影片（或影片加载失败）时退回纯 CSS 的 HUD 自检动画；
 *   3. 影片/自检期间把 Windows 原生标题栏（最小化 / 最大化 / 关闭）融进画面，
 *      揭开时还原（见 applyTitleBar）；
 *   4. 无论如何都要把遮罩删掉 —— 它挡不住点击，但一直留着会遮住界面。
 *
 * 失败绝不外抛：任何异常写进 localStorage 的 last-error 后静默降级。
 * 暴露 globalThis.__dshThemePlayVeil(cfg) 供客户端“重播”复用。
 */
(function () {
	'use strict'

	var PLAYED_KEY = 'dsh-theme.played'
	var ERROR_KEY = 'dsh-theme.last-error'

	function bootConfig() {
		var cfg = globalThis.__DSH_THEME_BOOT__
		return cfg !== null && typeof cfg === 'object' ? cfg : {}
	}

	function veilElement() {
		return document.getElementById('dsh-theme-veil')
	}

	function removeVeil(element) {
		if (element !== null && element.parentNode !== null) element.parentNode.removeChild(element)
	}

	function readPlayed() {
		try {
			return globalThis.sessionStorage.getItem(PLAYED_KEY) === '1'
		} catch (error) {
			return false
		}
	}

	function markPlayed() {
		try {
			globalThis.sessionStorage.setItem(PLAYED_KEY, '1')
		} catch (error) {
			/* 存储不可用只影响 “只播一次” 的判定，不影响动画本身 */
		}
	}

	function prefersReducedMotion() {
		try {
			return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches === true
		} catch (error) {
			return false
		}
	}

	function now() {
		var perf = globalThis.performance
		return perf !== undefined && typeof perf.now === 'function' ? perf.now() : Date.now()
	}

	function record(message) {
		try {
			globalThis.localStorage.setItem(ERROR_KEY, String(message))
		} catch (error) {
			/* 诊断写不进去就算了 */
		}
	}

	// -------------------------------------------------- Windows 原生标题栏

	/*
	 * 右上角那三个按钮不归网页管：Chromium 把 Window Controls Overlay 画在网页
	 * 之上，CSS 碰不到按钮本身。但 DSH 桌面端的 preload 会往 body 里插一个隐藏探针，
	 * 量出下面两个变量再经 `windowsAppearance` IPC 调 `mainWindow.setTitleBarOverlay`：
	 *
	 *   --dsw-specific-sidebar-fill  → 覆盖层底板色（浅色主题下就是那块白底）
	 *   --dsw-alias-label-primary    → 三个字形的颜色
	 *
	 * 所以在遮罩期间把这两个变量写进 body 的内联样式（!important，压过宿主注入的
	 * 令牌表），白底板就透出影片；hide 再把字形调成影片底色，看起来就像没有按钮。
	 * 必须写在 body 的 style 上：preload 的 MutationObserver 只盯 body 属性与 head，
	 * 写到别处它不会重新量色。
	 *
	 * 两段还原是有意的：字形在揭开时就要还原（否则淡出过程中界面文字是透明的），
	 * 底板则等遮罩真正移除后再还原（早还原会在淡出时先闪一块标题栏底色）。
	 */
	var TITLEBAR_FILL = '--dsw-specific-sidebar-fill'
	var TITLEBAR_SYMBOL = '--dsw-alias-label-primary'
	var TITLEBAR_DARK_GLYPH = '#071525'
	var TITLEBAR_LIGHT_GLYPH = '#e6f1ff'
	var TITLEBAR_FALLBACK = '#04080f'

	/** 遮罩自己的底色，也就是三个按钮背后实际显示的颜色。 */
	function veilBackdrop() {
		var veil = veilElement()
		var computed = veil !== null && typeof globalThis.getComputedStyle === 'function'
			? globalThis.getComputedStyle(veil)
			: null
		var value = computed !== null && computed !== undefined ? computed.backgroundColor : ''
		if (typeof value === 'string') {
			var trimmed = value.trim()
			if (trimmed !== '' && trimmed !== 'transparent' && trimmed !== 'rgba(0, 0, 0, 0)') return trimmed
		}
		return TITLEBAR_FALLBACK
	}

	/** 解析 #rgb / #rrggbb / rgb() / rgba()，返回 [r,g,b]（0–1），无法解析时 null。 */
	function parseColor(value) {
		if (typeof value !== 'string') return null
		var text = value.trim().toLowerCase()
		var hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/u.exec(text)
		if (hex !== null) {
			var digits = hex[1]
			if (digits.length === 3) digits = digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2]
			return [
				parseInt(digits.slice(0, 2), 16) / 255,
				parseInt(digits.slice(2, 4), 16) / 255,
				parseInt(digits.slice(4, 6), 16) / 255,
			]
		}
		var rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/u.exec(text)
		if (rgb === null) return null
		return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255]
	}

	function isDark(color) {
		var rgb = parseColor(color)
		if (rgb === null) return true
		return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 < 0.5
	}

	/**
	 * 把原生标题栏融进遮罩。
	 * @param {string} mode hide | blend | off
	 * @returns {boolean} 是否真的改了（off/不支持时 false，收尾就不用还原）。
	 */
	function applyTitleBar(mode) {
		if (mode !== 'hide' && mode !== 'blend') return false
		var body = document.body
		if (body === null || body === undefined) return false
		try {
			var backdrop = veilBackdrop()
			var glyph = mode === 'hide' ? backdrop : isDark(backdrop) ? TITLEBAR_LIGHT_GLYPH : TITLEBAR_DARK_GLYPH
			body.style.setProperty(TITLEBAR_FILL, 'transparent', 'important')
			body.style.setProperty(TITLEBAR_SYMBOL, glyph, 'important')
			return true
		} catch (error) {
			record(error)
			return false
		}
	}

	function clearTitleBarProperty(name) {
		try {
			if (document.body !== null && document.body !== undefined) document.body.style.removeProperty(name)
		} catch (error) {
			record(error)
		}
	}

	/** 兜底：任何异常路径都把两个变量清干净，别留下一个透明标题栏。 */
	function restoreTitleBar() {
		clearTitleBarProperty(TITLEBAR_SYMBOL)
		clearTitleBarProperty(TITLEBAR_FILL)
	}

	/** 遮罩内部的“点击/按键跳过”提示。 */
	function skipHint() {
		var hint = document.createElement('div')
		hint.className = 'orbital-veil__skip'
		hint.textContent = 'Click or press any key to skip'
		return hint
	}

	/**
	 * 播一次入场遮罩。遮罩元素必须已经在 DOM 里（首次由宿主注入，重播由客户端插入）。
	 * @param {object} [override] 覆盖配置；缺省读宿主注入的 __DSH_THEME_BOOT__。
	 * @returns {boolean} 是否真的开始播放。
	 */
	function playVeil(override) {
		var config = override !== undefined && override !== null ? override : bootConfig()
		var element = veilElement()
		if (element === null) return false
		if (config.enabled === false || config.animation === 'none' || prefersReducedMotion()) {
			removeVeil(element)
			return false
		}
		if (config.playOn === 'cold' && readPlayed()) {
			removeVeil(element)
			return false
		}

		var root = document.documentElement
		var duration = Number(config.durationMs)
		if (!isFinite(duration) || duration < 300) duration = 1500
		/* 影片真播完/HUD 自检路径：先定格一小会儿再开始淡出，避免“啪”地切走。
		   影片路径在 introTailMs > 0 时走下面的交叉淡出，不再定格。 */
		var hold = Number(config.holdMs)
		if (!isFinite(hold) || hold < 0) hold = 350
		if (hold > 3000) hold = 3000
		/* 影片结尾往往是几乎静止的一帧（自带的两支片子大约 1.5s）。提前这么多开始
		   交叉淡出，把“最后一帧干等”换成连贯的叠化；0 = 等影片真正播完再淡出。 */
		var introTail = Number(config.introTailMs)
		if (!isFinite(introTail) || introTail < 0) introTail = 1500
		if (introTail > 5000) introTail = 5000
		var startedAt = now()
		var settled = false
		var armed = false
		var finishedMedia = false
		var mountedFlag = false
		var minElapsed = false
		var video = null
		var hardStop = null
		var mountTimer = null
		var observer = null
		var titleBarActive = false
		var handoffTimer = null
		var crossfade = false

		element.setAttribute('data-animation', config.animation === 'fade' ? 'fade' : 'hud')
		element.setAttribute('data-media', 'hud')
		root.setAttribute('data-dsh-theme-phase', 'boot')
		root.style.setProperty('--orbital-veil-duration', duration + 'ms')
		markPlayed()
		/* 遮罩与样式都已就位，这时量出来的才是遮罩真实底色。 */
		titleBarActive = applyTitleBar(config.titleBar)

		function finish() {
			if (settled) return
			settled = true
			root.setAttribute('data-dsh-theme-phase', 'reveal')
			element.setAttribute('data-phase', 'reveal')
			/* 淡出会把下面的界面露出来，字形色必须立刻还原；底板色留到遮罩移除。 */
			if (titleBarActive) clearTitleBarProperty(TITLEBAR_SYMBOL)
			/* 影片还在播也没关系：整层降低透明度淡出，解码等节点真正移除时再停。 */
			var remove = function () {
				if (hardStop !== null) clearTimeout(hardStop)
				if (mountTimer !== null) clearTimeout(mountTimer)
				stopHandoffWatch()
				if (observer !== null) {
					observer.disconnect()
					observer = null
				}
				stopMedia()
				removeVeil(element)
				if (titleBarActive) clearTitleBarProperty(TITLEBAR_FILL)
				if (root.getAttribute('data-dsh-theme-phase') === 'reveal') {
					root.removeAttribute('data-dsh-theme-phase')
				}
			}
			element.addEventListener('animationend', remove, { once: true })
			/* 淡出动画 900ms；留足余量再用定时器兜底移除。 */
			setTimeout(remove, 1600)
		}

		/**
		 * 三段都满足之后揭开：影片（或其结尾交叉点）、应用挂载、最短停留。
		 * @param {boolean} [immediate] true = 立刻开始淡出（交叉淡出路径，不再定格）。
		 */
		function maybeReveal(immediate) {
			if (settled || armed) return
			if (!(finishedMedia && mountedFlag && minElapsed)) return
			armed = true
			/* 交叉淡出路径不再定格：片子边播边淡，主界面在遮罩后面同时进场。 */
			if (immediate === true || crossfade === true) finish()
			else setTimeout(finish, hold)
		}

		function stopHandoffWatch() {
			if (handoffTimer !== null) {
				clearTimeout(handoffTimer)
				handoffTimer = null
			}
		}

		/**
		 * 盯着影片进度：到达（时长 − introTail）时就把“影片播完”提前标记掉，并立刻
		 * 开始交叉淡出。放在播放期间轮询而不是等 `ended`，这样尾巴上的静止段不会
		 * 被当成卡死；影片被暂停/卡住时也不会提前。
		 */
		function watchFilmHandoff() {
			if (introTail <= 0 || handoffTimer !== null || video === null) return
			var tick = function () {
				handoffTimer = null
				if (settled || video === null) return
				var length = video.duration
				if (typeof length !== 'number' || !isFinite(length) || length <= 0) {
					handoffTimer = setTimeout(tick, 150)
					return
				}
				/* 短片也别在开头就切：最多提前到片长的一半。 */
				var cut = Math.max(length * 0.5, length - introTail / 1000)
				if (video.currentTime < cut) {
					handoffTimer = setTimeout(tick, 120)
					return
				}
				finishedMedia = true
				crossfade = true
				maybeReveal(true)
			}
			handoffTimer = setTimeout(tick, 120)
		}

		function stopMedia() {
			stopHandoffWatch()
			if (video === null) return
			try {
				video.pause()
				video.removeAttribute('src')
				video.load()
			} catch (error) {
				/* 停止解码失败不影响揭开 */
			}
			video = null
		}

		function startVideo(source) {
			try {
				video = document.createElement('video')
				video.className = 'orbital-veil__video'
				video.muted = true
				video.defaultMuted = true
				video.playsInline = true
				video.autoplay = true
				video.preload = 'auto'
				video.setAttribute('muted', '')
				video.setAttribute('playsinline', '')
				video.setAttribute('aria-hidden', 'true')
				video.disablePictureInPicture = true
				/* 6s 还没能起播（典型是起播请求卡住）就退回 CSS HUD，别一直黑着。 */
				var readiness = setTimeout(function () {
					if (video === null || settled) return
					if (video.readyState < 3 && !video.ended) failVideo()
				}, 6000)
				video.addEventListener('playing', function () {
					clearTimeout(readiness)
					element.setAttribute('data-media', 'video')
					watchFilmHandoff()
				})
				video.addEventListener('ended', function () {
					clearTimeout(readiness)
					stopHandoffWatch()
					finishedMedia = true
					maybeReveal()
				})
				video.addEventListener('error', function () {
					clearTimeout(readiness)
					failVideo()
				})
				video.src = source
				element.appendChild(video)
				element.appendChild(skipHint())
				var attempt = video.play()
				if (attempt !== undefined && typeof attempt.catch === 'function') {
					attempt.catch(function () {
						failVideo()
					})
				}
			} catch (error) {
				failVideo()
			}
		}

		/** 影片不可用时退回 CSS HUD：把影片节点摘掉，按 durationMs 走老路径。 */
		function failVideo() {
			stopHandoffWatch()
			if (video !== null) {
				try {
					video.remove()
				} catch (error) {
					/* ignore */
				}
				video = null
			}
			var hint = element.querySelector('.orbital-veil__skip')
			if (hint !== null) hint.remove()
			element.setAttribute('data-media', 'hud')
			finishedMedia = true
			maybeReveal()
		}

		var mounted = function () {
			return document.querySelector('[data-dsh-boot]') === null && document.querySelector('[data-shell-overlay]') !== null
		}

		if (mounted()) {
			mountedFlag = true
		} else if (typeof globalThis.MutationObserver === 'function') {
			observer = new globalThis.MutationObserver(function () {
				if (!mounted()) return
				observer.disconnect()
				observer = null
				mountedFlag = true
				maybeReveal()
			})
			observer.observe(document.documentElement, { childList: true, subtree: true })
		}

		setTimeout(function () {
			minElapsed = true
			maybeReveal()
		}, Math.max(0, duration - (now() - startedAt)))

		/* 观察器不可用或结构迟迟不出现时，绝不永久遮挡。 */
		mountTimer = setTimeout(function () {
			if (observer !== null) {
				observer.disconnect()
				observer = null
			}
			mountedFlag = true
			finishedMedia = true
			minElapsed = true
			maybeReveal()
		}, duration + 10000)

		hardStop = setTimeout(finish, duration + 20000)

		/* 影片期间任意点击/按键可跳过（遮罩本身 pointer-events: none）。 */
		var skip = function () {
			if (settled) return
			finishedMedia = true
			minElapsed = true
			finish()
		}
		globalThis.addEventListener('pointerdown', skip, { once: true, capture: true })
		globalThis.addEventListener('keydown', skip, { once: true, capture: true })

		if (typeof config.introSrc === 'string' && config.introSrc !== '') startVideo(config.introSrc)
		else finishedMedia = true

		return true
	}

	globalThis.__dshThemePlayVeil = playVeil

	try {
		var startup = bootConfig()
		if (typeof startup.backgroundScope === 'string' && startup.backgroundScope !== '') {
			document.documentElement.setAttribute('data-dsh-theme-wallpaper', startup.backgroundScope)
		}
		/* 深潜设计是单一深色方案：在应用挂载前就把 DSH 自己的深色分支点亮，
		   否则那些按 body[data-ds-dark-theme] 选静态中性色的组件（文件改动卡片、
		   菜单、diff 底）会沿用浅色。 */
		if (document.body !== null) document.body.setAttribute('data-ds-dark-theme', '')
		playVeil()
	} catch (error) {
		record(error && error.stack !== undefined ? error.stack : error)
		restoreTitleBar()
		removeVeil(veilElement())
	}
})()
