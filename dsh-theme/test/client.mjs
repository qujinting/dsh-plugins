// Browser half contract checks. The bundle is never executed here — it is
// parsed with a real JavaScript parser and then checked against the
// `__ModuleLoader__` factory contract and the platform-module rules.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) failures.push(label)
}

const source = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
const bootSource = readFileSync(join(ROOT, 'theme/boot.js'), 'utf8')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// `node --check` is not used: the loader factory may use syntax that only a
// parser agrees with, and a real parse is what the shell performs.
try {
	new vm.Script(source, { filename: 'lib/client.js' })
	check('lib/client.js parses', true)
} catch (error) {
	check('lib/client.js parses', false, error.message)
}

try {
	new vm.Script(bootSource, { filename: 'theme/boot.js' })
	check('theme/boot.js parses', true)
} catch (error) {
	check('theme/boot.js parses', false, error.message)
}

// --- module-loader contract -------------------------------------------------

check('registers with the module loader', source.includes('window.__ModuleLoader__.load({'))
check('factory declares the package id', source.includes(`id: '${manifest.name}'`))
check('factory receives require', /factory:\s*\(require\)\s*=>/u.test(source))
check('exports apply', /exports\.apply = apply/u.test(source))
check('exports inject', /exports\.inject = inject/u.test(source))
check('requires the slots service', /const inject = \['slots'\]/u.test(source))
check('returns module.exports', /return module\.exports/u.test(source))

// --- platform-module rules --------------------------------------------------

check('does not import DSH packages', !source.includes('@deepseek-ai/'))
const requires = [...source.matchAll(/require\((['"])([^'"]+)\1\)/gu)].map((match) => match[2])
const unexpected = requires.filter((name) => name !== 'react')
check('only requires platform modules', unexpected.length === 0, unexpected.join(', '))
check('requires React exactly once', requires.filter((name) => name === 'react').length === 1)

// --- behaviour hooks --------------------------------------------------------

check('finds the host stylesheet by marker', source.includes('/* dsh-theme'))
check('reads the revision marker', source.includes('rev:([^*]+)'))
check('refreshes through the composed route', source.includes('/injected.css'))
check('persists the switch locally', source.includes("'dsh-theme.enabled'"))
check('records failures for the error report', source.includes("'dsh-theme.last-error'"))
check('mounts the sidebar control', source.includes("'sidebar.footer.action'"))
check('exposes the diagnostics handle', source.includes('globalThis.__dshTheme ='))
check('replay reuses the boot controller', source.includes('__dshThemePlayVeil'))
check('mounts the optional wallpaper film', source.includes('orbital-theme-bg'))
check('keeps the wallpaper in conversations in both schemes', !source.includes('hasTurns && !document.body.hasAttribute'))
check('sidebar control carries the DeepSeek Blue label', source.includes('深潜主题'))
check('sidebar control matches the prototype pill', source.includes('orbital-theme-dot') && source.includes('orbital-theme-label') && source.includes('orbital-theme-replay'))
check('replay affordance is an inline SVG triangle', source.includes("viewBox: '0 0 24 24'") && source.includes('orbital-theme-replay'))
check('forces the single-scheme palette from palette.json', source.includes('/palette.json') && source.includes("FORCED_SCHEME = 'dark'"))
check('forces the app dark attribute as well', source.includes("DARK_ATTRIBUTE = 'data-ds-dark-theme'"))
check('pins the wallpaper so the composer cannot rescale it', source.includes('pinWallpaperSize') && source.includes("addEventListener('resize'"))
check('re-asserts the dark attribute when the app clears it', source.includes('MutationObserver'))
check('releases the dark attribute on disable', source.includes('releaseDarkAttribute()'))
check('boot marks the document dark before the app mounts', bootSource.includes('data-ds-dark-theme'))
check('removes the forced tokens on disable', source.includes('clearForcedScheme()'))
check('removes the wallpaper on disable', source.includes('removeBackgroundVideo'))
check('disable blanks the injected stylesheet instead of guessing tokens', source.includes('disabled */'))
check('respects reduced motion through the controller', bootSource.includes('prefers-reduced-motion'))
check('controller supports cold-start-only playback', bootSource.includes("'dsh-theme.played'"))
check('controller never throws into the page', /try\s*\{[\s\S]*catch/u.test(bootSource))
check('controller removes the veil on failure', bootSource.includes('removeVeil(veilElement())'))
check('controller drives the Windows caption probe variable', bootSource.includes('--dsw-specific-sidebar-fill'))
check('controller restores the caption variables', bootSource.includes('restoreTitleBar'))

const scriptClose = /<\/script/iu
check('client bundle cannot close a script tag', !scriptClose.test(source))
check('boot controller cannot close a script tag', !scriptClose.test(bootSource))

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURE(S): ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
