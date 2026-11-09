/**
 * Structural checks that do not need a harness: every module parses, the client
 * bundle is shaped the way `dsh-client-modules` expects, the host entry exports
 * a Cordis plugin, and the packaging wiring that keeps the store out of git and
 * out of the published tarball is actually in place.
 *
 * The last group is the one worth automating: `data/` holds the encrypted
 * secrets, and a single missing `.gitignore` line would be the difference
 * between a private file and a committed one.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Every file that must at least parse. */
const sources = [
	...fs.readdirSync(path.join(ROOT, 'src')).filter((name) => name.endsWith('.js')).map((name) => path.join('src', name)),
	path.join('lib', 'client.js'),
]

for (const relative of sources) {
	const absolute = path.join(ROOT, relative)
	assert.ok(fs.existsSync(absolute), `${relative} exists`)
	execFileSync(process.execPath, ['--check', absolute], { stdio: 'pipe' })
	console.log(`ok   parse  ${relative}`)
}

// --------------------------------------------------------------- client shape

const client = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
assert.ok(client.startsWith('// dsh-secret-broker'), 'the client bundle keeps its header comment')
assert.ok(client.includes('window.__ModuleLoader__.load({'), 'the client bundle registers through the module loader')
assert.ok(client.includes("id: 'dsh-secret-broker'"), 'and registers under the package name')
assert.ok(client.includes("require('react')"), 'React comes from the platform module table')
assert.ok(client.includes("ctx.slots.inject('settings.section'"), 'the page occupies the settings section seat')
assert.ok(!client.includes('@deepseek-ai/'), 'no non-baseline module request, so no dsh.client.external is needed')
assert.ok(client.includes("ctx.slots.inject('conversation.session.header.utilities'"), 'the session title bar carries the entry')
// The module system fails a row whose `require` it cannot answer, so the bundle
// must request exactly one external and only that one.
const requires = [...client.matchAll(/require\(['"]([^'"]+)['"]\)/gu)].map((match) => match[1])
assert.deepEqual([...new Set(requires)], ['react'], `the bundle requests only react, got: ${requires.join(', ')}`)
console.log('ok   shape  lib/client.js')

// ------------------------------------------------------- host plugin contract

const host = await import(new URL('../src/index.js', import.meta.url).href)
assert.equal(host.name, 'secret-broker')
assert.equal(typeof host.apply, 'function')
assert.deepEqual(host.inject, ['tools', 'systemPrompt'])
assert.equal(typeof host.readOptions, 'function')
console.log('ok   shape  src/index.js')

// ------------------------------------------------------------- packaging wiring

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
assert.equal(pkg.name, 'dsh-secret-broker')
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
assert.equal(pkg.dsh.client.platform, 'web')
assert.deepEqual(pkg.dsh.client.inject, ['slots'])
assert.equal(pkg.exports['./client'], './lib/client.js')
assert.ok(!pkg.files.some((entry) => entry.startsWith('data')), 'the store directory is never published')
assert.ok(!('dependencies' in pkg), 'the plugin has no runtime dependencies to resolve')

const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
assert.ok(/id:\s*secret-broker/u.test(patch), 'the bundle patch inserts the row')
assert.ok(/name:\s*'dsh-secret-broker'/u.test(patch), 'and names this package')

const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
assert.ok(/^data\/$/mu.test(ignore), 'data/ is git-ignored')
console.log('ok   wiring package.json / cordis.patch.yml / .gitignore')

console.log('\nparse.mjs: all structural checks passed')
