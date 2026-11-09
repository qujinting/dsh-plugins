// Host injection checks: mount the host half against a fake Cordis context and
// inspect the rows it pushes into `webserver/index-inject`. The rows are the
// whole contract with the shell, so they are asserted structurally.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STYLE_MARKER, composeInjections, composeStyleSheet, readOptions } from '../lib/index.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) failures.push(label)
}

function createContext() {
	const listeners = []
	const log = { info: [], warn: [] }
	const ctx = {
		on(event, handler) {
			listeners.push({ event, handler })
			return () => {}
		},
		inject(_deps, callback) {
			callback({
				effect(factory) {
					return factory()
				},
				webServer: {
					register() {
						return () => {}
					},
				},
			})
			return () => {}
		},
		effect(factory) {
			return factory()
		},
		logger: {
			info: (message) => log.info.push(message),
			warn: (message) => log.warn.push(message),
		},
	}
	return { ctx, listeners, log }
}

const { apply } = await import('../lib/index.js')

// --- enabled, defaults ------------------------------------------------------

{
	const { ctx, listeners } = createContext()
	apply(ctx, {})
	check('registers an index-injection listener', listeners.length === 1 && listeners[0].event === 'webserver/index-inject')
	const table = []
	listeners[0].handler(table)
	check('pushes four rows for the default config', table.length === 4, String(table.length))
	check('row order is global → style → veil → script', table.map((row) => row.kind).join(',') === 'global,style,html,script')
	check('global row carries the boot config', table[0].name === '__DSH_THEME_BOOT__' && table[0].value.durationMs === 1500 && table[0].value.animation === 'hud')
	check('global row points at the intro film', table[0].value.introSrc === '/api/dsh-theme/video/intro')
	check('global row leaves the wallpaper off by default', table[0].value.backgroundSrc === null)
	check('global row hides the native title bar by default', table[0].value.titleBar === 'hide')
	check('global row carries the film tail trim', table[0].value.introTailMs === 1500)

	const style = table[1].text
	check('style row starts with the revision marker', style.startsWith(STYLE_MARKER))
	check('style row has a parseable revision', /^\/\* dsh-theme rev:[^*]+ \*\//u.test(style))
	check('style row themes both schemes', style.includes('html body{') && style.includes('html body[data-ds-dark-theme]{'))
	check('style row outranks app stylesheets', style.includes('html body') && style.includes(':root:root'))
	check('alias tokens are forced over the inline values', style.includes('--dsw-alias-bg-base:#050A14 !important'))
	check('both scheme blocks carry the dark design', (style.match(/--dsw-alias-bg-base:#050A14 !important/gu) ?? []).length === 2)
	check('native controls are locked to the dark design', style.includes('color-scheme:dark'))
	check('design-platform surfaces are forced too', style.includes('--dsw-specific-sidebar-fill:#070F1C !important'))
	check('style row carries the authored stylesheet', style.includes('#dsh-theme-veil'))
	check('style row cannot close its own tag', !/<\/style/iu.test(style))

	check('veil markup is injected into the body', table[2].placement === 'body' && table[2].html.includes('id="dsh-theme-veil"'))
	check('veil markup has no script', !/<script/iu.test(table[2].html))
	check('controller is injected last', table[3].placement === 'body' && table[3].text.includes('__dshThemePlayVeil'))
	check('controller cannot close its own tag', !/<\/script/iu.test(table[3].text))
}

// --- disabled ---------------------------------------------------------------

{
	const { ctx, listeners, log } = createContext()
	apply(ctx, { enabled: false })
	check('disabled config registers no listener', listeners.length === 0)
	check('disabled config logs why', log.info.length === 1 && /disabled/iu.test(log.info[0]))
}

// --- animation none ---------------------------------------------------------

{
	const options = readOptions({ animation: 'none' })
	const rows = composeInjections(options)
	check('animation:none drops the veil markup', rows.some((row) => row.kind === 'html') === false)
	check('animation:none still ships the controller for replay', rows.some((row) => row.kind === 'script') === true)
	check('animation:none drops the intro film', rows[0].value.introSrc === null)
}

// --- media config -----------------------------------------------------------

{
	const none = composeInjections(readOptions({ introVideo: '' }))
	check('empty introVideo disables the film', none[0].value.introSrc === null)
	const wallpaper = composeInjections(readOptions({ backgroundVideo: 'videos/bg.mp4' }))
	check('backgroundVideo is exposed to the client', wallpaper[0].value.backgroundSrc === '/api/dsh-theme/video/bg')
	check('wallpaper defaults to the always scope', wallpaper[0].value.backgroundScope === 'always')
	check('wallpaper scope accepts empty', readOptions({ backgroundScope: 'empty' }).backgroundScope === 'empty')
	check('unknown wallpaper scope falls back to always', readOptions({ backgroundScope: 'sometimes' }).backgroundScope === 'always')
	check('opacity is clamped', readOptions({ backgroundOpacity: 5 }).backgroundOpacity === 1)
	check('blur is clamped', readOptions({ backgroundBlur: -10 }).backgroundBlur === 0)
	check('conversation opacity is clamped', readOptions({ backgroundOpacityConversation: -1 }).backgroundOpacityConversation === 0)
	check('conversation blur is clamped', readOptions({ backgroundBlurConversation: 999 }).backgroundBlurConversation === 80)
	check('default intro film exists', readOptions({}).introVideo.endsWith('.mp4'))
	check('wallpaper is bright on an empty session by default', readOptions({}).backgroundOpacity === 0.85 && readOptions({}).backgroundBlur === 6)
	check('wallpaper softens inside a conversation by default', readOptions({}).backgroundOpacityConversation === 0.55 && readOptions({}).backgroundBlurConversation === 8)
}

// --- reveal hold ------------------------------------------------------------

check('hold defaults to 350ms', readOptions({}).holdMs === 350)
check('hold can be disabled', readOptions({ holdMs: 0 }).holdMs === 0)
check('hold is clamped high', readOptions({ holdMs: 99999 }).holdMs === 3000)
{
	const rows = composeInjections(readOptions({ holdMs: 900 }))
	check('hold reaches the boot controller', rows[0].value.holdMs === 900)
	check('style exposes both wallpaper intensities', rows[1].text.includes('--orbital-bg-opacity-conversation:'))
}

// --- config normalization ---------------------------------------------------

check('duration is clamped low', readOptions({ durationMs: 10 }).durationMs === 800)
check('duration is clamped high', readOptions({ durationMs: 999999 }).durationMs === 4000)
check('duration accepts integers', readOptions({ durationMs: 2100 }).durationMs === 2100)
check('unknown animation falls back to hud', readOptions({ animation: 'zoom' }).animation === 'hud')
check('unknown glow falls back to medium', readOptions({ glow: 'ultra' }).glow === 'medium')
check('playOn accepts cold', readOptions({ playOn: 'cold' }).playOn === 'cold')
check('unknown playOn falls back to cold', readOptions({ playOn: 'sometimes' }).playOn === 'cold')
check('playOn accepts always', readOptions({ playOn: 'always' }).playOn === 'always')
check('scanlines can be turned off', readOptions({ scanlines: false }).scanlines === false)
check('enabled defaults to true', readOptions({}).enabled === true)
check('titleBar defaults to hide', readOptions({}).titleBar === 'hide')
check('titleBar accepts blend', readOptions({ titleBar: 'blend' }).titleBar === 'blend')
check('titleBar accepts off', readOptions({ titleBar: 'off' }).titleBar === 'off')
check('unknown titleBar falls back to hide', readOptions({ titleBar: 'invisible' }).titleBar === 'hide')
check('garbage titleBar falls back to hide', readOptions({ titleBar: 42 }).titleBar === 'hide')
check('introTailMs defaults to 1500', readOptions({}).introTailMs === 1500)
check('introTailMs can be disabled', readOptions({ introTailMs: 0 }).introTailMs === 0)
check('introTailMs is clamped low', readOptions({ introTailMs: -500 }).introTailMs === 0)
check('introTailMs is clamped high', readOptions({ introTailMs: 99999 }).introTailMs === 5000)
check('garbage introTailMs falls back to 1500', readOptions({ introTailMs: 'soon' }).introTailMs === 1500)
try {
	readOptions('nope')
	check('garbage config does not throw', true)
} catch (error) {
	check('garbage config does not throw', false, error.message)
}

// --- ambience variables follow config --------------------------------------

{
	const off = composeStyleSheet(readOptions({ scanlines: false, grid: false, glow: 'off' }))
	check('scanlines off zeroes the variable', off.css.includes('--orbital-scanline-opacity:0'))
	check('grid off zeroes the variable', off.css.includes('--orbital-grid-opacity:0'))
	check('glow off zeroes the multiplier', off.css.includes('--orbital-glow:0'))
	const high = composeStyleSheet(readOptions({ glow: 'high' }))
	check('glow high raises the multiplier', high.css.includes('--orbital-glow:1.6'))
	check('revision changes with config', off.rev !== high.rev)
}

// --- client contract --------------------------------------------------------

const client = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
check('client searches for the same style marker', client.includes(STYLE_MARKER))
check('client parses the same revision shape', client.includes('rev:([^*]+)'))
check('client fetches the composed stylesheet route', client.includes('/injected.css'))
check('client reads the status route', client.includes('/api/dsh-theme'))
check('client exposes a diagnostics handle', client.includes('__dshTheme'))

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURE(S): ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
