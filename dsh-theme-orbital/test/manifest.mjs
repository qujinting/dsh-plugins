// Manifest and layout checks: the package must look like a DSH bundle with a
// browser half, and every file it advertises must exist on disk.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) failures.push(label)
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

check('package is an ES module', manifest.type === 'module')
check('host entry is lib/index.js', manifest.main === 'lib/index.js')
check('exports the browser half', manifest.exports?.['./client'] !== undefined)
check('exports the bundle patch', manifest.exports?.['./cordis.patch.yml'] !== undefined)
check('declares the bundle patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('declares a web client half', manifest.dsh?.client?.platform === 'web')
check('client half injects the slots service', Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.includes('slots'))
check('package name matches the module id used by lib/client.js', manifest.name === 'dsh-theme-orbital')

for (const file of [
	'lib/index.js',
	'lib/client.js',
	'theme/palette.json',
	'theme/theme.css',
	'theme/boot.html',
	'theme/boot.js',
	'cordis.patch.yml',
	'README.md',
	'README.zh.md',
	'LICENSE',
	'icon.svg',
]) {
	check(`file exists: ${file}`, existsSync(join(ROOT, file)))
}

const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
check('bundle patch inserts one row', /- id: theme-orbital/u.test(patch))
check('bundle patch names this package', /name: 'dsh-theme-orbital'/u.test(patch))
for (const key of ['enabled', 'animation', 'playOn', 'durationMs', 'holdMs', 'introTailMs', 'titleBar', 'scanlines', 'grid', 'glow']) {
	check(`bundle patch documents config.${key}`, new RegExp(`^\\s*${key}:`, 'mu').test(patch))
}

const fixturePath = join(ROOT, 'test/fixtures/alias-tokens.json')
check('alias token fixture exists', existsSync(fixturePath))
if (existsSync(fixturePath)) {
	const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
	check('fixture is non-trivial', Object.keys(fixture.light).length > 80, `${Object.keys(fixture.light).length} tokens`)
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURE(S): ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
