/**
 * Smoke test: the gateway's own logic needs no server, and one optional live
 * pass proves the transport against the real REA MCP server.
 *
 * Run `node test/smoke.mjs`, or `REA_LIVE=1 node test/smoke.mjs` to also speak
 * the protocol to `npx -y rea-agents@6.8.0 mcp` (slow on a cold cache).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { McpStdioClient, spawnTarget } from '../src/client.js'
import { readOptions } from '../src/index.js'
import { candidates, readState, resolveDataDir, resolveLaunch, vendorInstall, writeState } from '../src/install.js'
import { normaliseScriptPath } from '../src/route.js'
import { reaCallTool, reaToolsTool } from '../src/tools.js'

const CATALOG = [
	{
		name: 'decompile_function',
		title: 'Decompile function',
		description: 'Decompile one function from a native binary and return pseudo-code.',
		inputSchema: { type: 'object', properties: { path: { type: 'string' }, address: { type: 'string' } }, required: ['path', 'address'] },
	},
	{
		name: 'inspect_apk_signature',
		title: 'Inspect APK signature',
		description: 'Report signing certificates and digests for an APK.',
		inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
	},
	{
		name: 'trace_web_source_location',
		title: 'Trace web source location',
		description: 'Trace a runtime location back into a web bundle.',
		inputSchema: { type: 'object', properties: {} },
	},
]

const options = readOptions({})
const activity = () => {}
const fakeClient = {
	start: async () => CATALOG,
	call: async (name, args) => ({
		content: [{ type: 'text', text: `${name} ${JSON.stringify(args)}` }, { type: 'image', data: '' }],
	}),
}

// 1. Ranking surfaces the tool the keyword names.
{
	const tool = reaToolsTool(options, fakeClient, activity)
	const value = await tool.execute({ query: 'decompile' }, {})
	assert.equal(value.total, CATALOG.length)
	assert.equal(value.rows[0].name, 'decompile_function')
	assert.deepEqual(value.rows[0].required, ['path', 'address'])
	assert.equal(value.rows[0].inputSchema, undefined, 'schemas stay out unless asked for')
	const rendered = tool.output.render({}, value)[0].text
	assert.match(rendered, /<rea-catalog total="3"/)
}

// 2. `exact` returns one row with its full schema.
{
	const tool = reaToolsTool(options, fakeClient, activity)
	const value = await tool.execute({ exact: 'inspect_apk_signature' }, {})
	assert.equal(value.matchCount, 1)
	assert.match(value.rows[0].inputSchema, /"required"/)
}

// 3. An unknown exact name fails with the recoverable instruction.
{
	const tool = reaToolsTool(options, fakeClient, activity)
	await assert.rejects(() => tool.execute({ exact: 'nope' }, {}), /no REA tool named "nope"/)
}

// 4. The dispatcher forwards arguments and reports that images were dropped.
{
	const tool = reaCallTool(options, fakeClient, activity)
	const value = await tool.execute({ tool: 'decompile_function', arguments: { path: 'a', address: '0x1' } }, {})
	assert.equal(value.tool, 'decompile_function')
	assert.match(value.text, /"path":"a"/)
	assert.equal(value.imageCount, 1)
	assert.match(tool.output.render({}, value)[0].text, /forwards text only/)
}

// 5. An unknown tool name is refused instead of forwarded.
{
	const tool = reaCallTool(options, fakeClient, activity)
	await assert.rejects(() => tool.execute({ tool: 'made_up' }, {}), /not a REA tool in the running catalog/)
}

// 6. Windows package runners go through cmd.exe, everything else spawns directly.
{
	const shim = spawnTarget('npx', ['-y', 'rea-agents@6.8.0', 'mcp'])
	if (process.platform === 'win32') {
		assert.match(shim.file, /cmd\.exe$/i)
		assert.deepEqual(shim.argv.slice(0, 3), ['/d', '/c', 'npx'])
	} else {
		assert.equal(shim.file, 'npx')
	}
	const direct = spawnTarget('node', ['server.mjs'])
	assert.equal(direct.file, 'node')
	assert.deepEqual(direct.argv, ['server.mjs'])
}

// 7. Launch resolution: an explicit path wins, then the vendor install, then the command.
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rea-test-'))
	try {
		const script = path.join(dir, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs')
		fs.mkdirSync(path.dirname(script), { recursive: true })
		fs.writeFileSync(script, '// stub\n')
		fs.writeFileSync(
			path.join(dir, 'node_modules', 'rea-agents', 'package.json'),
			JSON.stringify({ name: 'rea-agents', version: '6.8.0' }),
		)

		const options = readOptions({ command: 'npx', args: ['-y', 'rea-agents@6.8.0', 'mcp'], dataDir: dir })
		assert.equal(vendorInstall(dir).version, '6.8.0')
		const fromVendor = resolveLaunch(dir, {}, options)
		assert.equal(fromVendor.origin, 'vendor')
		assert.equal(fromVendor.version, '6.8.0')

		const external = path.join(dir, 'elsewhere', 'rea.mjs')
		fs.mkdirSync(path.dirname(external), { recursive: true })
		fs.writeFileSync(external, '// stub\n')
		writeState(dir, { reaScript: external })
		assert.equal(readState(dir).reaScript, external)
		const fromState = resolveLaunch(dir, readState(dir), options)
		assert.equal(fromState.origin, 'configured')
		assert.equal(fromState.script, external)

		const rows = candidates(dir, readState(dir), options)
		assert.deepEqual(rows.map((row) => row.origin), ['configured', 'vendor', 'command'])
		assert.equal(rows[0].available, true)
		assert.equal(rows[1].available, true)

		// A path that no longer exists stops counting as configured.
		assert.equal(resolveLaunch(dir, { reaScript: path.join(dir, 'gone.mjs') }, options).origin, 'vendor')
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
}

// 8. Path input from the settings page is normalised before it is trusted.
{
	assert.equal(normaliseScriptPath('').ok, false)
	assert.equal(normaliseScriptPath('rea.mjs').ok, false)
	assert.equal(normaliseScriptPath('relative/rea.mjs').ok, false)
	const parsed = normaliseScriptPath('  "C:\\tools\\rea-agents\\scripts\\rea.mjs"  ')
	assert.equal(parsed.ok, true)
	assert.equal(parsed.path, path.resolve('C:\\tools\\rea-agents\\scripts\\rea.mjs'))
}

// 9. The data directory follows the live profile, then an explicit override.
{
	const options = readOptions({})
	const fromProfile = resolveDataDir(options, 'C:\\profiles\\desktop')
	assert.equal(fromProfile, path.join(path.resolve('C:\\profiles\\desktop'), 'data', 'dsh-rea'))
	const explicit = resolveDataDir({ dataDir: 'C:\\explicit\\rea' }, 'C:\\profiles\\desktop')
	assert.equal(explicit, path.resolve('C:\\explicit\\rea'))
}

console.log('unit: ok')

if (process.env.REA_LIVE === '1') {
	const command = process.env.REA_COMMAND ?? 'npx'
	const args = process.env.REA_ARGS?.split(' ').filter((part) => part.length > 0) ?? ['-y', 'rea-agents@6.8.0', 'mcp']
	const client = new McpStdioClient({
		resolveLaunch: async () => ({ command, args }),
		startupTimeoutMs: 240_000,
		callTimeoutMs: 240_000,
		logger: (message) => console.error(message),
	})
	try {
		const catalog = await client.start()
		console.log(`live: ${catalog.length} tools from the running server`)
		assert.ok(catalog.length > 100, 'the live server should publish its full catalog')
		assert.ok(catalog.every((tool) => typeof tool.name === 'string' && tool.name.length > 0))
		const grouped = catalog.filter((tool) => /decompile|inspect|trace/.test(tool.name))
		assert.ok(grouped.length > 0)
	} finally {
		await client.dispose()
	}
	console.log('live: ok')
}
