// Palette checks: the palette is the only place colour values live, so it has to
// be complete (every DSH alias token either themed or explicitly inherited),
// well-formed (both schemes, no injection-hostile characters), and consistent
// with the token fixture extracted from the running DSH build.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) failures.push(label)
}

const palette = JSON.parse(readFileSync(join(ROOT, 'theme/palette.json'), 'utf8'))
const fixture = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/alias-tokens.json'), 'utf8'))

const alias = palette.alias ?? {}
const inherit = new Set(palette.inherit ?? [])
const ignore = new Set(palette.ignore ?? [])
const specific = palette.specific ?? {}
const metrics = palette.metrics ?? {}

check('palette has an alias section', Object.keys(alias).length > 40, `${Object.keys(alias).length} alias tokens`)
check('palette has a specific section', Object.keys(specific).length >= 10, `${Object.keys(specific).length} surfaces`)
check('palette has metrics', Object.keys(metrics).length >= 10, `${Object.keys(metrics).length} metrics`)

// --- shape ------------------------------------------------------------------

for (const [token, pair] of Object.entries(alias)) {
	check(`alias name is a --dsw-alias-* token: ${token}`, token.startsWith('--dsw-alias-'))
	check(
		`alias ${token} has a light/dark pair`,
		pair !== null && typeof pair === 'object' && typeof pair.light === 'string' && typeof pair.dark === 'string' && pair.light.length > 0 && pair.dark.length > 0,
	)
	for (const scheme of ['light', 'dark']) {
		const value = pair?.[scheme] ?? ''
		check(`${token} ${scheme} is single-line`, !value.includes('\n'))
		check(`${token} ${scheme} cannot break a declaration`, !value.includes(';') && !value.includes('}') && !value.includes('{'))
		check(`${token} ${scheme} is a plausible CSS value`, /^(#|rgb|hsl|color-mix|var|linear-gradient|transparent|currentColor|Canvas)/u.test(value), value)
	}
}

for (const [token, pair] of Object.entries(specific)) {
	check(`specific name is a --dsw-specific-* token: ${token}`, token.startsWith('--dsw-specific-') || token.startsWith('--dsw-menu-'))
	check(`specific ${token} has both schemes`, typeof pair?.light === 'string' && typeof pair?.dark === 'string')
}

for (const [token, value] of Object.entries(metrics)) {
	check(`metric name is a custom property: ${token}`, token.startsWith('--'))
	check(`metric ${token} is a single-line string`, typeof value === 'string' && !value.includes('\n') && !value.includes(';'))
}

// --- completeness against the DSH token fixture -----------------------------

const fixtureTokens = Object.keys(fixture.light)
check('fixture uses --dsw-alias-* names', fixtureTokens.every((token) => token.startsWith('--dsw-alias-')))

const missing = fixtureTokens.filter((token) => alias[token] === undefined && !inherit.has(token) && !ignore.has(token))
check('every DSH alias token is themed, inherited, or ignored', missing.length === 0, missing.join(', '))

const overlap = [...Object.keys(alias)].filter((token) => inherit.has(token))
check('alias and inherit do not overlap', overlap.length === 0, overlap.join(', '))

const unknown = [...inherit].filter((token) => !fixtureTokens.includes(token))
check('inherit only names tokens that exist in the fixture', unknown.length === 0, unknown.join(', '))

const ignoredUnknown = [...ignore].filter((token) => !fixtureTokens.includes(token))
check('ignore only names tokens that exist in the fixture', ignoredUnknown.length === 0, ignoredUnknown.join(', '))

// --- semantic spot checks ---------------------------------------------------

const pairs = (token) => alias[token] ?? {}
check('base surface is themed', pairs('--dsw-alias-bg-base').light !== undefined && pairs('--dsw-alias-bg-base').dark !== undefined)
check('brand colour is DeepSeek Blue in both schemes', /3D5AF1/iu.test(pairs('--dsw-alias-brand-primary').light ?? '') && /4D6BFE/iu.test(pairs('--dsw-alias-brand-primary').dark ?? ''))
check('primary text contrasts with base surface', pairs('--dsw-alias-label-primary').light !== pairs('--dsw-alias-bg-base').light)
check('dark text is not the light text', pairs('--dsw-alias-label-primary').dark !== pairs('--dsw-alias-label-primary').light)
// DSH probes `--dsw-specific-sidebar-fill` as a *colour* to paint the native
// Windows caption (preload-app.cjs sets it on a throwaway span and reads
// getComputedStyle().backgroundColor). A gradient there computes to transparent
// and the caption falls back to the light system colour, so every design
// platform surface has to stay a solid colour; decorative gradients live in
// theme.css instead.
const gradientTokens = Object.entries(specific).filter(([, pair]) => /gradient/iu.test(`${pair.light}${pair.dark}`))
check('design-platform surfaces are solid colours', gradientTokens.length === 0, gradientTokens.map(([token]) => token).join(', '))
check('sidebar surface is a solid dark colour', /^#[0-9a-f]{6}$/iu.test(specific['--dsw-specific-sidebar-fill']?.dark ?? ''))
check('dark sidebar stays dark', /#0[0-9a-f]{5}/iu.test(specific['--dsw-specific-sidebar-fill']?.dark ?? ''))

const cssText = readFileSync(join(ROOT, 'theme/theme.css'), 'utf8')
check('sidebar decoration gradient lives in the stylesheet', /div:nth-of-type\(1\)[^{]*\{[^}]*background-image:[^}]*linear-gradient/u.test(cssText))
check('wallpaper styling is single-scheme (no light branch)', /\.orbital-theme-bg/u.test(cssText) && !cssText.includes('data-ds-dark-theme'))

// --- composer light band ----------------------------------------------------
//
// The band is the one sanctioned multi-hue exception, so its colours have to be
// real palette values (the stylesheet only ever uses var()) and the strip width
// has to be a length.
const bandTokens = ['--orbital-band-violet', '--orbital-band-azure', '--orbital-band-cyan', '--orbital-band-pale']
for (const token of bandTokens) {
	check(`composer band colour is a palette hex: ${token}`, /^#[0-9a-f]{6}$/iu.test(metrics[token] ?? ''), metrics[token] ?? 'missing')
}
check('composer band width is a length', /^\d+(?:\.\d+)?px$/u.test(metrics['--orbital-band-width'] ?? ''), metrics['--orbital-band-width'] ?? 'missing')
check('composer band is styled from those tokens', /\[data-composer-card\]::before\s*\{[^}]*var\(--orbital-band-azure\)/u.test(cssText))

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURE(S): ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
