// Parse both halves with a real JavaScript parser.
//
// `node --check` is not enough here: a missing newline between two statements
// made V8 report a bogus "private field must be declared in an enclosing class"
// error, while esbuild points at the actual token. The client half is also
// checked for the module-loader contract the host's bundle route depends on.
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'

const failures = []
const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) failures.push(label)
}

for (const file of ['lib/index.js', 'lib/client.js']) {
	const source = readFileSync(file, 'utf8')
	try {
		await transform(source, { loader: 'js', format: 'esm', target: 'es2022' })
		check(`${file} parses`, true)
	} catch (error) {
		const location = error.errors?.[0]?.location
		check(`${file} parses`, false, `${error.errors?.[0]?.text ?? error.message} @ ${location?.file}:${location?.line}:${location?.column}`)
	}
}

const client = readFileSync('lib/client.js', 'utf8')
check('client registers with the module loader', client.includes('window.__ModuleLoader__.load({'))
check('client factory declares the package id', client.includes("id: 'dsh-desktop-pet'"))
check('client exports apply/inject/name', /exports\.apply = apply/u.test(client) && /exports\.inject = inject/u.test(client) && /exports\.name = name/u.test(client))

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
check('manifest declares the bundle patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('manifest declares a web client half', manifest.dsh?.client?.platform === 'web')
check('manifest exports ./client', manifest.exports?.['./client'] !== undefined)

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURE(S): ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
