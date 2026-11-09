// Standalone host-half smoke test: mount the plugin on a fake Cordis context
// backed by a real HTTP server, then exercise every route it registers.
import http from 'node:http'
import { readFile, utimes, writeFile } from 'node:fs/promises'
import { apply, name, inject } from '../lib/index.js'

const registrations = []
const ctx = {
	logger: { info: (m) => console.log('  [info]', m), warn: (m) => console.log('  [warn]', m) },
	effect: (fn) => fn(),
	on: () => {},
	webServer: {
		register: (route) => {
			registrations.push(route)
			return () => {}
		},
	},
}

console.log(`plugin name=${name} inject=${JSON.stringify(inject)}`)
apply(ctx, {})
if (registrations.length !== 1) throw new Error(`expected one route, got ${registrations.length}`)
const route = registrations[0]
console.log(`route kind=${route.kind} path=${route.path}`)

const server = http.createServer((req, res) => {
	if (!req.url.startsWith(route.path)) {
		res.writeHead(404).end('no route')
		return
	}
	Promise.resolve(route.handler(req, res)).catch((error) => {
		res.writeHead(500).end(String(error))
	})
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}${route.path}`

const failures = []
const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) failures.push(label)
}

async function get(path, options) {
	const response = await fetch(`${base}${path}`, options)
	const body = await response.text()
	return { status: response.status, headers: response.headers, body }
}

// --- catalog -----------------------------------------------------------------
const catalog = await get('/catalog')
const catalogJson = JSON.parse(catalog.body)
check('catalog 200', catalog.status === 200, String(catalog.status))
check('catalog ok flag', catalogJson.ok === true, JSON.stringify(catalogJson.error))
check('catalog model url', typeof catalogJson.model === 'string', catalogJson.model)
check(
	'catalog expressions table',
	Object.keys(catalogJson.expressions ?? {}).length === 44,
	String(Object.keys(catalogJson.expressions ?? {}).length),
)
check('catalog runtime urls', typeof catalogJson.runtime?.core === 'string' && typeof catalogJson.runtime?.vendor === 'string')
check('catalog events url', catalogJson.events?.endsWith('/events') === true, catalogJson.events)
check('catalog phase snapshot', typeof catalogJson.phase?.phase === 'string', JSON.stringify(catalogJson.phase))

// --- asset closure -----------------------------------------------------------
const model = await get('/asset/c_0120.model3.json')
check('model3.json served', model.status === 200 && model.body.includes('c_0120.moc3'), String(model.status))

const moc = await get('/asset/model/c_0120.moc3')
check('moc3 served', moc.status === 200 && moc.body.length > 2_000_000, `${moc.status} ${moc.body.length}B`)

const texture = await get('/asset/textures/texture_00.png')
check('texture served as image/png', texture.status === 200 && texture.headers.get('content-type') === 'image/png')

const expression = await get('/asset/expressions/whale.exp3.json')
check('expression served', expression.status === 200 && expression.body.includes('jingyu'))

const motion = await get('/asset/motions/idle.motion3.json')
check('motion served', motion.status === 200)

// Everything below is outside the model's reference closure and must 404.
// (`pet.json` is deliberately inside it: it is the pet's public manifest, and
// the browser half is the thing that reads it.)
for (const path of [
	'/asset/c_0120.vtube.json',
	'/asset/items_pinned_to_model.json',
	'/asset/icon.png',
	'/asset/../../package.json',
	'/asset/..%2f..%2fpackage.json',
	'/asset/%2e%2e%2f%2e%2e%2fpackage.json',
	'/asset/model/../../../lib/index.js',
]) {
	const response = await get(path)
	check(`closure rejects ${path}`, response.status === 404, String(response.status))
}

const manifest = await get('/asset/pet.json')
check('pet manifest served', manifest.status === 200 && manifest.body.includes('ds-whale-girl'), String(manifest.status))

// The preview is declared by the manifest, so it is inside the closure.
const preview = await get('/asset/preview.png')
check('preview served', preview.status === 200 && preview.headers.get('content-type') === 'image/png')

// --- etag revalidation -------------------------------------------------------
const etag = model.headers.get('etag')
const revalidated = await get('/asset/c_0120.model3.json', { headers: { 'if-none-match': etag } })
check('etag 304', revalidated.status === 304, String(revalidated.status))

// --- vendor bundle -----------------------------------------------------------
const vendor = await get('/runtime/vendor.js')
check(
	'vendor bundle served',
	vendor.status === 200 && vendor.body.includes('__dshPetVendor') && vendor.body.length > 500_000,
	`${vendor.status} ${vendor.body.length}B`,
)

// --- cubism core (network) ---------------------------------------------------
const core = await get('/runtime/core.js')
check(
	'cubism core served',
	core.status === 200 && core.body.includes('Live2DCubismCore'),
	`${core.status} source=${core.headers.get('x-dsh-pet-core')} ${core.body.length}B`,
)
const coreAgain = await get('/runtime/core.js')
check('cubism core cached on second hit', coreAgain.headers.get('x-dsh-pet-core') === 'cached', String(coreAgain.headers.get('x-dsh-pet-core')))

// --- SSE ---------------------------------------------------------------------
const controller = new AbortController()
const stream = await fetch(`${base}/events`, { signal: controller.signal })
const reader = stream.body.getReader()
const chunk = await Promise.race([
	reader.read().then((r) => new TextDecoder().decode(r.value)),
	new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 3000)),
])
controller.abort()
check('events stream opens with a snapshot', chunk.includes('data:') && chunk.includes('phase'), chunk.trim().slice(0, 90))

// --- method + route guards ---------------------------------------------------
const post = await get('/catalog', { method: 'POST' })
check('POST rejected', post.status === 405, String(post.status))
const missing = await get('/nope')
check('unknown route 404', missing.status === 404, String(missing.status))

// --- the catalog is live, not cached -----------------------------------------
check('catalog is uncacheable', catalog.headers.get('cache-control') === 'no-store', String(catalog.headers.get('cache-control')))

// Editing the pet manifest must be picked up without reloading the plugin: a
// pet is the thing people tinker with, so a restart-to-change-a-line would be
// the wrong trade.
const manifestPath = new URL('../assets/pet/pet.json', import.meta.url)
const original = await readFile(manifestPath, 'utf8')
try {
	const edited = JSON.parse(original)
	edited.lines = { ...edited.lines, __probe: ['stamp check'] }
	await writeFile(manifestPath, `${JSON.stringify(edited, null, 2)}\n`, 'utf8')
	// Filesystem mtime has limited resolution; make the change unambiguous.
	const now = new Date(Date.now() + 2_000)
	await utimes(manifestPath, now, now)
	const refreshed = JSON.parse((await get('/catalog')).body)
	check('manifest edits are picked up live', Array.isArray(refreshed.manifest?.lines?.__probe), JSON.stringify(Object.keys(refreshed.manifest?.lines ?? {})))
} finally {
	await writeFile(manifestPath, original, 'utf8')
}
const restored = JSON.parse((await get('/catalog')).body)
check('manifest restores after the probe', restored.manifest?.lines?.__probe === undefined)

// --- self-healing lookup ------------------------------------------------------
//
// A miss recomputes the closure once before answering 404, so a stale index can
// never hide a file that is really there. That must not become a way to reach
// files the model does not reference.
{
	const before = JSON.parse((await get('/catalog')).body).closure
	const stray = await get('/asset/LICENSE')
	check('a present-but-unreferenced file stays 404', stray.status === 404, String(stray.status))
	const after = JSON.parse((await get('/catalog')).body).closure
	check('a miss recomputes the closure', after.rebuilds > before.rebuilds, `${before.rebuilds} -> ${after.rebuilds}`)
	check(
		'a miss never widens the closure',
		after.healed === 0 && after.size === before.size,
		`size ${before.size} -> ${after.size}, healed ${after.healed}`,
	)
	const stillThere = await get('/asset/textures/texture_01.png')
	check('referenced assets still resolve after a miss', stillThere.status === 200, String(stillThere.status))
}

// --- concurrent first load ----------------------------------------------------
//
// A page load asks for the catalog, then fires 44 expression requests and the
// model's assets at once. That burst used to race the reference-closure rebuild
// and 404 on a texture that was sitting right there on disk, so it is worth a
// dedicated test against a *fresh* plugin instance.
{
	const raceRegistrations = []
	const raceCtx = {
		logger: { info: () => {}, warn: () => {} },
		effect: (fn) => fn(),
		on: () => {},
		webServer: {
			register: (registered) => {
				raceRegistrations.push(registered)
				return () => {}
			},
		},
	}
	apply(raceCtx, {})
	const raceRoute = raceRegistrations[0]
	const raceServer = http.createServer((req, res) => {
		Promise.resolve(raceRoute.handler(req, res)).catch((error) => res.writeHead(500).end(String(error)))
	})
	await new Promise((resolve) => raceServer.listen(0, '127.0.0.1', resolve))
	const raceBase = `http://127.0.0.1:${raceServer.address().port}/api/dsh-pet`

	const raceCatalog = await (await fetch(`${raceBase}/catalog`)).json()
	const racePaths = [
		'/asset/c_0120.model3.json',
		'/asset/model/c_0120.moc3',
		'/asset/model/c_0120.physics3.json',
		'/asset/textures/texture_00.png',
		'/asset/textures/texture_01.png',
		...Object.values(raceCatalog.expressions).map((file) => `/asset/${file}`),
	]
	const raceResponses = await Promise.all(racePaths.map((path) => fetch(`${raceBase}${path}`)))
	const failed = racePaths.filter((_, index) => raceResponses[index].status !== 200)
	check(
		`concurrent first load serves all ${racePaths.length} assets`,
		failed.length === 0,
		failed.length === 0 ? '' : `${failed.length} failed, first: ${failed[0]}`,
	)
	const bodies = await Promise.all(raceResponses.map((response) => response.arrayBuffer()))
	check('every concurrent asset body is non-empty', bodies.every((body) => body.byteLength > 0))
	raceServer.close()
}

server.close()
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURE(S): ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
