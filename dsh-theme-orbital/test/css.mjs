// Stylesheet guards. These are structural, not visual: they catch the mistakes
// that actually break the injection contract (unbalanced braces, a `</style`
// sequence that would end the injected tag early, unbounded !important) and the
// selector-specificity rule that keeps the theme winning against app CSS.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) failures.push(label)
}

const css = readFileSync(join(ROOT, 'theme/theme.css'), 'utf8')
const bootHtml = readFileSync(join(ROOT, 'theme/boot.html'), 'utf8')

// --- injection safety -------------------------------------------------------

check('stylesheet never closes its own <style> tag', !/<\/style/iu.test(css))
check('stylesheet never opens a <script>', !/<script/iu.test(css))
check('veil markup has no script tag', !/<script/iu.test(bootHtml))
check('veil markup has no style tag', !/<style/iu.test(bootHtml))

// --- syntax -----------------------------------------------------------------

const open = (css.match(/\{/gu) ?? []).length
const close = (css.match(/\}/gu) ?? []).length
check('braces are balanced', open === close, `${open} open / ${close} close`)
check('no @import', !/@import/iu.test(css))
check('no external url()', !/url\(/iu.test(css))
check('no CSS nesting ampersand', !/&/u.test(css))

const keyframes = [...css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/gu)].map((match) => match[1])
check('keyframes exist', keyframes.length >= 5, `${keyframes.length} keyframes`)
const unprefixed = keyframes.filter((name) => !name.startsWith('orbital-'))
check('every keyframe is namespaced', unprefixed.length === 0, unprefixed.join(', '))

const importantCount = (css.match(/!important/gu) ?? []).length
check('!important stays bounded (reduced-motion / off guards only)', importantCount <= 5, `${importantCount} occurrences`)

// --- selector specificity ---------------------------------------------------
//
// The host's <style> is rendered before the app's own stylesheets in a browser
// index response, so a component rule of equal specificity would lose. Every
// component selector therefore has to start with `html`, `#root`, or `:root`.

function selectors(text) {
	const found = []
	let depth = 0
	let pending = ''
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index]
		if (char === '/' && text[index + 1] === '*') {
			const end = text.indexOf('*/', index + 2)
			index = end === -1 ? text.length : end + 1
			continue
		}
		if (char === '{') {
			const head = pending.trim()
			pending = ''
			if (head.startsWith('@')) {
				depth += 1
				continue
			}
			depth += 1
			found.push(head)
			continue
		}
		if (char === '}') {
			depth -= 1
			pending = ''
			continue
		}
		pending += char
	}
	return found.filter((selector) => selector !== '')
}

const rules = selectors(css)
check('stylesheet parsed into rules', rules.length > 30, `${rules.length} rules`)

const weak = []
for (const rule of rules) {
	for (const part of rule.split(',')) {
		const selector = part.trim()
		if (selector === '') continue
		if (selector.startsWith('from') || selector.startsWith('to') || /^\d+/u.test(selector)) continue
		if (selector.startsWith('html') || selector.startsWith('#') || selector.startsWith(':root')) continue
		if (selector.startsWith('body') && selector.includes('[data-ds-dark-theme]')) continue
		weak.push(selector)
	}
}
check('every component selector carries html/#root/:root specificity', weak.length === 0, weak.slice(0, 6).join(' | '))

// --- colour ownership -------------------------------------------------------
//
// theme.css must not hard-code palette colours; the only literals allowed are
// the veil's self-contained dark backdrop and its mask stops (the veil has to
// render even if the token layer failed).

const allowedHex = new Set(['#050a14', '#e6edfb', '#a8b9d8', '#7a8cae', '#000'])
const hexes = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/gu)].map((match) => match[0].toLowerCase())
const stray = hexes.filter((value) => !allowedHex.has(value))
check('no palette colours hard-coded in theme.css', stray.length === 0, [...new Set(stray)].join(', '))

const markupHexes = [...bootHtml.matchAll(/#[0-9a-fA-F]{3,8}\b/gu)].map((match) => match[0].toLowerCase())
const allowedMarkup = new Set(['#4d6bfe', '#8aa2ff'])
const strayMarkup = markupHexes.filter((value) => !allowedMarkup.has(value))
check('veil markup only uses the two brand accents', strayMarkup.length === 0, [...new Set(strayMarkup)].join(', '))

// --- contract with the boot controller --------------------------------------

check('theme defines the veil container', /#dsh-theme-veil\s*\{/u.test(css))
check('theme styles the shell boot screen', /\[data-dsh-boot\]/u.test(css))
check('reveal phase hooks exist', /data-dsh-theme-phase='reveal'/u.test(css))
check('reduced motion is honoured', /prefers-reduced-motion:\s*reduce/u.test(css))
check('theme has a CSS-only failsafe for the veil', /orbital-veil-autohide/u.test(css))
check('intro film layer is styled', /\.orbital-veil__video/u.test(css))
check('wallpaper layer is styled', /\.orbital-theme-bg/u.test(css))
check('wallpaper hides once a session has turns', /:not\(:has\(\[data-chat-turn\]\)\)[^{]*\.orbital-theme-bg/u.test(css))
check('wallpaper scope override exists', /data-dsh-theme-wallpaper='always'/u.test(css))
check('wallpaper sits behind conversation content', /\.orbital-theme-bg\s*\{[^}]*z-index:\s*-1/u.test(css))
check('conversation shell is opened up for the wallpaper', /div:has\(\[data-conversation-region\]\)\s*\{[^}]*background:\s*transparent/u.test(css))
/* DeepSeek Blue is a single-scheme design: the stylesheet must not contain any
   light-mode branch, and the wallpaper must stay visible in conversations. */
check('stylesheet has no light-scheme branch', !/data-ds-dark-theme/u.test(css))
check('wallpaper stays visible in a conversation', /html\[data-dsh-theme-wallpaper='always'\][^{]*:has\(\[data-chat-turn\]\)[^{]*\.orbital-theme-bg\s*\{[^}]*opacity:\s*var\(/u.test(css))
check('user bubble carries the brand hairline', /\[data-conversation-scroll\][^{]*\[class\*='_bubble'\][^{]*\{[^}]*box-shadow:\s*inset 0 0 0 1px/u.test(css))
check('video mode hides the CSS HUD stage', /\[data-media='video'\][^{]*\{[^}]*display:\s*none/u.test(css))

// --- composer light band ----------------------------------------------------
//
// The composer carries a coloured light strip drawn with a masked conic gradient
// on ::before, plus a coloured spill painted by the card's own box-shadow. The
// colours are palette metrics (never literals here) and the whole effect scales
// with --orbital-glow, so `glow: off` restores the plain card.
check('composer card draws a ring on ::before', /\[data-composer-card\]::before\s*\{[^}]*content:\s*''[^}]*position:\s*absolute/u.test(css))
check('composer ring is a conic gradient', /\[data-composer-card\]::before\s*\{[^}]*conic-gradient/u.test(css))
check('composer ring is hollowed out with a mask', /\[data-composer-card\]::before\s*\{[^}]*mask-composite:\s*exclude/u.test(css))
check('composer ring colours come from the palette', /var\(--orbital-band-cyan\)/u.test(css) && /var\(--orbital-band-violet\)/u.test(css) && !/--orbital-band-[a-z-]+:\s*#/u.test(css))
check('composer ring fades with the glow preset', /\[data-composer-card\]::before\s*\{[^}]*opacity:\s*(?:calc\()?var\(--orbital-glow\)/u.test(css))
check('composer card casts a coloured spill', /\[data-composer-card\]\s*\{[^}]*box-shadow:[^}]*var\(--orbital-band-/u.test(css))
check('composer spill also scales with the glow preset', /\[data-composer-card\]\s*\{[^}]*box-shadow:[^}]*calc\([^)]*var\(--orbital-glow\)/u.test(css))
check('composer ring drift stops under reduced motion', /prefers-reduced-motion[\s\S]*\[data-composer-card\]::before\s*\{[^}]*animation:\s*none/u.test(css))

// The focus state swaps in a brand ring shadow. Both states must keep the same
// number of layers AND the same inset pattern (a padded transparent layer would
// otherwise land opposite an inset one), or Chrome treats the pair as
// non-interpolable and the focus light snaps on instead of fading in.
check('composer base keeps the ring slot as a transparent layer', /\[data-composer-card\]\s*\{[^}]*box-shadow:[^}]*0 0 0 0 transparent/u.test(css))
check('composer focus light is transitioned', /\[data-composer-card\]\s*\{[^}]*transition:[^}]*box-shadow\s+\d+ms/u.test(css))
check('composer focus light uses the theme easings', /\[data-composer-card\]\s*\{[^}]*transition:[^}]*box-shadow\s+\d+ms\s+var\(--orbital-ease/u.test(css))
check('composer card transition is dropped for reduced motion', /prefers-reduced-motion[\s\S]*\[data-composer-card\]\s*\{[^}]*transition:\s*none/u.test(css))

// The placeholder and inline hint take --dsw-alias-label-caption; on the dark
// card that token reads as almost invisible, so the card lifts it locally.
check('composer lifts the caption colour for its placeholder', /\[data-composer-card\]\s*\{[^}]*--dsw-alias-label-caption:\s*color-mix/u.test(css))

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURE(S): ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
