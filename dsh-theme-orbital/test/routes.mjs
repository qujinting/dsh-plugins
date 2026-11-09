// Route checks: exercise the four `/api/dsh-theme/*` assets plus the composed
// stylesheet and diagnostics route against mock HTTP objects. These are the
// endpoints the browser half actually calls, so their status codes matter.
import { readOptions, handleRoute, resolveMedia } from '../lib/index.js'

const failures = []

const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) failures.push(label)
}

function mockRequest({ url = '/api/dsh-theme/status', method = 'GET', remoteAddress = '127.0.0.1', headers = {} } = {}) {
	return { url, method, headers, socket: { remoteAddress } }
}

function mockResponse() {
	const state = { status: undefined, headers: undefined, body: undefined, finished: false }
	return {
		state,
		writeHead(status, headers) {
			state.status = status
			state.headers = headers ?? {}
		},
		end(body) {
			state.body = body
			state.finished = true
		},
		get headersSent() {
			return state.status !== undefined
		},
	}
}

function call(request) {
	const response = mockResponse()
	handleRoute(readOptions({}), request, response)
	return response.state
}

// --- status -----------------------------------------------------------------

{
	const result = call(mockRequest())
	check('status answers 200', result.status === 200)
	check('status is JSON', /application\/json/u.test(result.headers['content-type']))
	const body = JSON.parse(result.body)
	check('status names the plugin', body.name === 'dsh-theme-orbital')
	check('status reports the config', body.animation === 'hud' && body.durationMs === 1500)
	check('status reports the title-bar mode', body.titleBar === 'hide')
	check('status reports the film tail trim', body.introTailMs === 1500)
	check('status reports a revision', typeof body.revision === 'string' && body.revision.length > 0)
	check('status lists every served file', Object.keys(body.files).sort().join(',') === 'boot.html,boot.js,palette.json,theme.css')
}

// --- assets -----------------------------------------------------------------

for (const [suffix, type] of [
	['/theme.css', 'text/css'],
	['/palette.json', 'application/json'],
	['/boot.html', 'text/html'],
	['/boot.js', 'text/javascript'],
]) {
	const result = call(mockRequest({ url: `/api/dsh-theme${suffix}` }))
	check(`${suffix} answers 200`, result.status === 200, String(result.status))
	check(`${suffix} has the right content type`, new RegExp(type, 'u').test(result.headers['content-type'] ?? ''))
	check(`${suffix} carries an ETag`, /^"[^"]+"$/u.test(result.headers.etag ?? ''))
	if (suffix === '/palette.json') {
		const palette = JSON.parse(result.body)
		check('palette route serves valid JSON', typeof palette.alias === 'object')
	}
	if (suffix === '/boot.js') {
		check('boot controller route serves the controller', result.body.includes('__dshThemePlayVeil'))
	}
}

// --- composed stylesheet ----------------------------------------------------

{
	const first = call(mockRequest({ url: '/api/dsh-theme/injected.css' }))
	check('injected.css answers 200', first.status === 200)
	check('injected.css is CSS', /text\/css/u.test(first.headers['content-type'] ?? ''))
	check('injected.css carries the marker', first.body.startsWith('/* dsh-theme-orbital'))
	check('injected.css contains the token layer', first.body.includes('--dsw-alias-bg-base:#050A14 !important'))
	check('injected.css contains the authored sheet', first.body.includes('#dsh-theme-veil'))
	const revision = /rev:([^*]+) \*\//u.exec(first.body)[1]
	const again = call(mockRequest({ url: `/api/dsh-theme/injected.css?rev=${encodeURIComponent(revision)}` }))
	check('unchanged revision answers 304', again.status === 304 && again.body === undefined)
	const conditional = call(mockRequest({ url: '/api/dsh-theme/injected.css', headers: { 'if-none-match': first.headers.etag } }))
	check('matching If-None-Match answers 304', conditional.status === 304)
	const other = call(mockRequest({ url: '/api/dsh-theme/injected.css?rev=stale' }))
	check('stale revision answers the full stylesheet', other.status === 200 && other.body.includes('#dsh-theme-veil'))
}

// --- method / guard behaviour ----------------------------------------------

{
	const post = call(mockRequest({ url: '/api/dsh-theme/status', method: 'POST' }))
	check('non-GET answers 405', post.status === 405)
	check('405 advertises the allowed methods', post.headers.allow === 'GET, HEAD')

	const head = call(mockRequest({ url: '/api/dsh-theme/theme.css', method: 'HEAD' }))
	check('HEAD answers 200 without a body', head.status === 200 && head.body === undefined)

	const remote = call(mockRequest({ remoteAddress: '10.0.0.7' }))
	check('non-loopback answers 403', remote.status === 403)

	const missing = call(mockRequest({ url: '/api/dsh-theme/nope.css' }))
	check('unknown asset answers 404', missing.status === 404)

	const traversal = call(mockRequest({ url: '/api/dsh-theme/%2e%2e/package.json' }))
	check('traversal is not served', traversal.status === 404)

	const bare = call(mockRequest({ url: '/api/dsh-theme' }))
	check('bare prefix answers 404', bare.status === 404)
}

// --- media ------------------------------------------------------------------

{
	const intro = resolveMedia(readOptions({}).introVideo)
	check('default intro film resolves', intro !== undefined && intro.type === 'video/mp4')
	check('traversal outside the package is refused', resolveMedia('../package.json') === undefined)
	check('non-video extensions are refused', resolveMedia('package.json') === undefined)
	check('missing media is refused', resolveMedia('videos/nope.mp4') === undefined)

	const head = call(mockRequest({ url: '/api/dsh-theme/video/intro', method: 'HEAD' }))
	check('intro film HEAD answers 200', head.status === 200, String(head.status))
	check('intro film advertises byte ranges', head.headers['accept-ranges'] === 'bytes')
	check('intro film HEAD carries a length', Number(head.headers['content-length']) > 1000)

	const ranged = mockResponse()
	handleRoute(readOptions({}), mockRequest({ url: '/api/dsh-theme/video/intro', method: 'HEAD', headers: { range: 'bytes=0-99' } }), ranged)
	check('range HEAD answers 206', ranged.state.status === 206)
	check('range answers a content-range', /^bytes 0-99\/\d+$/u.test(ranged.state.headers['content-range'] ?? ''))

	const invalid = call(mockRequest({ url: '/api/dsh-theme/video/intro', method: 'GET', headers: { range: 'bytes=abc' } }))
	check('malformed range answers 416', invalid.status === 416)

	const disabled = call(mockRequest({ url: '/api/dsh-theme/video/bg' }))
	check('unconfigured wallpaper answers 404', disabled.status === 404)
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURE(S): ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
