#!/usr/bin/env node
/**
 * 命令行自检：不经过 DSH，直接用一把 Cline API Key 敲一次上游。
 *
 * 用法：
 *
 *   # PowerShell
 *   $env:CLINEPASS_API_KEY = 'cpk_...' ; node tools/check.mjs
 *
 *   # bash
 *   CLINEPASS_API_KEY=cpk_... node tools/check.mjs
 *
 *   # 或者让它去读插件数据目录里兜底保存的那个 key
 *   node tools/check.mjs --from-file
 *
 * key 永远不会被打印，只会显示掩码。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchSnapshot } from '../src/api.js'
import { maskKey } from '../src/store.js'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * 解析 `--flag value` 形式的参数。
 * @returns 参数表。
 */
function parseArgs() {
	const argv = process.argv.slice(2)
	const options = { fromFile: false, baseUrl: undefined, envNames: ['CLINEPASS_API_KEY', 'CLINE_API_KEY'], showCredits: true }
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--from-file') options.fromFile = true
		else if (arg === '--base-url') options.baseUrl = argv[++index]
		else if (arg === '--env') options.envNames = [argv[++index]]
		else if (arg === '--no-credits') options.showCredits = false
		else if (arg === '--help' || arg === '-h') options.help = true
	}
	return options
}

/**
 * 取 key：环境变量优先，其次插件的兜底文件。
 * @param options - 解析后的参数。
 * @returns `{ apiKey, source }` 或 `{ source: 'missing' }`。
 */
async function readKey(options) {
	if (!options.fromFile) {
		for (const name of options.envNames) {
			const value = process.env[name]
			if (typeof value === 'string' && value.trim().length > 0) return { apiKey: value.trim(), source: `环境变量 ${name}` }
		}
	}
	try {
		const raw = await readFile(path.join(ROOT, 'data', 'credentials.json'), 'utf8')
		const parsed = JSON.parse(raw)
		if (typeof parsed?.apiKey === 'string' && parsed.apiKey.length > 0) {
			return { apiKey: parsed.apiKey, source: 'data/credentials.json' }
		}
	} catch {
		// 没有文件就是没有。
	}
	return { source: 'missing' }
}

const options = parseArgs()
if (options.help === true) {
	console.log('用法: [CLINEPASS_API_KEY=...] node tools/check.mjs [--from-file] [--base-url URL] [--env NAME] [--no-credits]')
	process.exit(0)
}

const key = await readKey(options)
if (key.source === 'missing') {
	console.error(`没有找到 API Key：请设置 ${options.envNames.join(' 或 ')}，或先跑一次 --from-file。`)
	process.exit(2)
}

const baseUrl = (options.baseUrl ?? 'https://api.cline.bot/api/v1').replace(/\/+$/u, '')
console.log(`key  ${maskKey(key.apiKey)}（来自 ${key.source}）`)
console.log(`上游 ${baseUrl}`)

try {
	const snapshot = await fetchSnapshot({
		baseUrl,
		apiKey: key.apiKey,
		timeoutMs: 20_000,
		balanceUnit: 'micro',
		showCredits: options.showCredits,
	})
	console.log(`查询于 ${snapshot.fetchedAt}（${String(snapshot.durationMs)} ms）`)
	if (snapshot.account?.email !== undefined) console.log(`账户 ${snapshot.account.email}`)
	if (snapshot.hasPlan) {
		for (const window of snapshot.windows) {
			console.log(`  ${window.label}：剩余 ${String(window.percentRemaining)}%，已用 ${String(window.percentUsed)}%${window.resetsAt === undefined ? '' : `，重置于 ${window.resetsAt}`}`)
		}
	} else {
		console.log('  该账户没有 ClinePass 订阅（usage-limits 返回 404 或没有配额窗口）')
	}
	if (snapshot.credits !== undefined) console.log(`按量付费余额 $${snapshot.credits.usd.toFixed(2)}`)
	for (const note of snapshot.notes) console.log(`注意：${note}`)
	process.exit(snapshot.hasPlan ? 0 : 1)
} catch (error) {
	console.error(`失败：${error?.message ?? error}`)
	process.exit(1)
}
