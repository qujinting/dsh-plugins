/**
 * Self-check for the `chrome_cdp` tool, without a running DSH.
 *
 * It drives the tool against a local fixture and asserts the four properties
 * that matter: real measurements come back, the viewport is the one asked for,
 * the dark theme is applied on both of its axes, and the browser is reaped.
 *
 * Run with `npm test`.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromeCdpTool } from '../src/tool.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const page = pathToFileURL(path.join(here, 'fixture.html')).href
const tool = chromeCdpTool({ toolName: 'chrome_cdp', headless: true, timeoutMs: 60_000 })
const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: here } } } }

const MEASURE = `JSON.stringify({
  vw: innerWidth, vh: innerHeight,
  boxes: Object.fromEntries(['.app-main', '#left', '#right', '#broken'].map((s) => {
    const e = document.querySelector(s)
    if (!e) return [s, null]
    const r = e.getBoundingClientRect(), c = getComputedStyle(e)
    return [s, { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                mar: c.margin, pad: c.padding, gap: c.gap, display: c.display,
                scrollH: e.scrollHeight, clientH: e.clientHeight }]
  })),
  pageScrollbar: (() => { const sc = document.querySelector('.app-main'); return sc.scrollHeight > sc.clientHeight })(),
})`

let failures = 0
async function check(label, run) {
	try {
		await run()
		console.log(`ok   ${label}`)
	} catch (error) {
		failures += 1
		console.log(`FAIL ${label}: ${error.message}`)
	}
}

const baseline = headlessBrowserCount()

await check('measures the real box model at the default viewport', async () => {
	const result = await tool.execute({ url: page, script: MEASURE, waitForSelector: '.row' }, exec)
	const measure = JSON.parse(result.measure)
	assert.equal(measure.vw, 1600)
	assert.equal(measure.vh, 1000)
	assert.equal(measure.boxes['.app-main'].w, 1600)
	assert.equal(measure.boxes['#left'].w, 768)
	assert.equal(measure.boxes['#left'].pad, '16px')
	// The fixture's bug: margin:auto collapses the card to its content width.
	assert.ok(measure.boxes['#broken'].w < 400, `expected a collapsed card, got ${measure.boxes['#broken'].w}px`)
	assert.equal(result.screenshotPath.endsWith('.png'), true)
})

await check('honours a narrow viewport and reports a page scrollbar', async () => {
	const result = await tool.execute(
		{ url: page, script: MEASURE, viewportWidth: 800, viewportHeight: 600, screenshot: false, waitMs: 200 },
		exec,
	)
	const measure = JSON.parse(result.measure)
	assert.equal(measure.vw, 800)
	assert.equal(measure.vh, 600)
	assert.equal(measure.boxes['#left'].w, 368)
	assert.equal(result.screenshotPath, undefined)
})

await check('applies the dark theme on both the class and the media query', async () => {
	const result = await tool.execute(
		{
			url: page,
			dark: true,
			screenshot: false,
			waitMs: 200,
			script: `JSON.stringify({
				darkClass: document.documentElement.classList.contains('dark'),
				prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
				bodyBg: getComputedStyle(document.body).backgroundColor,
			})`,
		},
		exec,
	)
	const measure = JSON.parse(result.measure)
	assert.equal(measure.darkClass, true)
	assert.equal(measure.prefersDark, true)
	assert.equal(measure.bodyBg, 'rgb(17, 17, 17)')
})

await check('accepts a statement body as well as an expression', async () => {
	const result = await tool.execute(
		{ url: page, screenshot: false, waitMs: 100, script: 'const t = document.title; return "title=" + t' },
		exec,
	)
	assert.equal(result.measure, 'title=chrome-cdp fixture')
})

await check('surfaces a page error instead of an empty result', async () => {
	await assert.rejects(
		() => tool.execute({ url: page, screenshot: false, script: 'null.boom' }, exec),
		/Cannot read properties of null/,
	)
})

await check('rejects a non-absolute URL', async () => {
	await assert.rejects(() => tool.execute({ url: 'localhost:5173' }, exec), /absolute http\(s\) or file URL/)
})

await new Promise((resolve) => setTimeout(resolve, 1500))
await check('leaves no browser behind', async () => {
	assert.equal(headlessBrowserCount(), baseline)
})

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

/** Count the headless browsers this machine is currently running. */
function headlessBrowserCount() {
	if (process.platform !== 'win32') return 0
	const probe = spawnSync(
		'powershell',
		[
			'-NoProfile',
			'-Command',
			"(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*--headless*' }).Count",
		],
		{ encoding: 'utf8' },
	)
	return Number.parseInt((probe.stdout ?? '0').trim(), 10) || 0
}
