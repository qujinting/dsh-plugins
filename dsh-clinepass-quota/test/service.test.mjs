import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { QuotaService } from '../src/service.js'
import { KeyStore } from '../src/store.js'

/** 一份可用的选项对象（字段与 readOptions 的输出一致）。 */
function optionsOf(overrides = {}) {
	return {
		baseUrl: 'https://api.example.test/api/v1',
		apiKey: undefined,
		apiKeyEnv: ['CLINEPASS_API_KEY'],
		dataDir: undefined,
		toolName: 'clinepass_quota',
		cacheSeconds: 60,
		timeoutMs: 5_000,
		balanceUnit: 'micro',
		showCredits: true,
		headerBadge: true,
		registerTool: true,
		registerRoutes: true,
		...overrides,
	}
}

/**
 * 计数的 fetch 替身。
 * @param state - 可变的响应状态。
 */
function countingFetch(state) {
	const calls = []
	const fetchImpl = async (url) => {
		calls.push(url)
		if (state.status !== 200) return { ok: false, status: state.status, text: async () => '' }
		const path = new URL(url).pathname
		if (path.endsWith('/balance')) return { ok: true, status: 200, text: async () => JSON.stringify({ balance: 2_000_000 }) }
		if (path.endsWith('/users/me')) return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'u1' }) }
		return { ok: true, status: 200, text: async () => JSON.stringify({ limits: state.limits }) }
	}
	return { calls, fetchImpl, state }
}

async function withStore(fn) {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'cpq-svc-'))
	try {
		const store = new KeyStore({ dataDir: dir })
		await store.ready
		return await fn(store, dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

test('没有 key 时 state 给出可读原因，且不请求上游', async () => {
	await withStore(async (store) => {
		const { calls, fetchImpl } = countingFetch({ status: 200, limits: [] })
		const service = new QuotaService({ store, options: optionsOf(), fetchImpl })
		const state = await service.state()
		assert.equal(state.ok, false)
		assert.match(state.error, /还没有配置 Cline API Key/u)
		assert.equal(state.key.configured, false)
		assert.equal(calls.length, 0)
	})
})

test('有 key 时返回三档窗口，第二次命中缓存', async () => {
	await withStore(async (store) => {
		const { calls, fetchImpl } = countingFetch({
			status: 200,
			limits: [
				{ type: 'five_hour', percentUsed: 40 },
				{ type: 'weekly', percentUsed: 67 },
				{ type: 'monthly', percentUsed: 12 },
			],
		})
		const service = new QuotaService({ store, options: optionsOf({ apiKey: 'cpk_0123456789' }), fetchImpl })

		const first = await service.state()
		assert.equal(first.ok, true)
		assert.equal(first.cache.cached, false)
		assert.deepEqual(first.snapshot.windows.map((window) => window.key), ['five_hour', 'weekly', 'monthly'])
		assert.equal(first.snapshot.credits.usd, 2)
		const afterFirst = calls.length
		assert.equal(afterFirst, 3)

		const second = await service.state()
		assert.equal(second.cache.cached, true)
		assert.equal(calls.length, afterFirst, '缓存命中不应再发请求')

		const forced = await service.state({ force: true })
		assert.equal(forced.cache.cached, false)
		assert.equal(calls.length, afterFirst * 2)
	})
})

test('并发调用合并成一次真实请求', async () => {
	await withStore(async (store) => {
		const { calls, fetchImpl } = countingFetch({ status: 200, limits: [{ type: 'weekly', percentUsed: 10 }] })
		const service = new QuotaService({ store, options: optionsOf({ apiKey: 'cpk_0123456789' }), fetchImpl })
		const [a, b, c] = await Promise.all([service.refresh(), service.refresh(), service.refresh()])
		assert.equal(a, b)
		assert.equal(b, c)
		assert.equal(calls.length, 3, '三次并发只应产生一轮请求（配额 + 身份 + 余额）')
	})
})

test('失败时保留上一次成功快照并标记 authFailed', async () => {
	await withStore(async (store) => {
		const harness = countingFetch({ status: 200, limits: [{ type: 'weekly', percentUsed: 10 }] })
		const service = new QuotaService({ store, options: optionsOf({ apiKey: 'cpk_0123456789' }), fetchImpl: harness.fetchImpl })
		const ok = await service.state()
		assert.equal(ok.ok, true)

		// 上游开始 401。
		harness.state.status = 401
		const failed = await service.state({ force: true })
		assert.equal(failed.ok, false)
		assert.equal(failed.authFailed, true)
		assert.match(failed.error, /API Key 被拒绝|HTTP 401/u)
		assert.equal(failed.snapshot, ok.snapshot, '旧快照必须留着')
	})
})

test('凭据服务里的 key 优先于环境变量，且只用掩码回给调用方', async () => {
	await withStore(async (store) => {
		const refs = new Map([['CLINEPASS_API_KEY', 'cpk_from_credentials_9999']])
		const credentials = {
			resolve: async (ref) => (refs.has(ref) ? { value: refs.get(ref), source: 'file' } : undefined),
			describe: async (ref) => ({ configured: refs.has(ref), writable: true }),
		}
		const { fetchImpl, calls } = countingFetch({ status: 200, limits: [{ type: 'weekly', percentUsed: 50 }] })
		const service = new QuotaService({
			store,
			options: optionsOf({ apiKeyEnv: ['CLINEPASS_API_KEY'] }),
			getCredentials: () => credentials,
			fetchImpl,
		})

		const state = await service.state()
		assert.equal(state.ok, true)
		assert.equal(state.key.source, 'credentials')
		assert.match(state.key.sourceDetail, /凭据存储 CLINEPASS_API_KEY/u)
		assert.doesNotMatch(state.key.mask, /from_credentials/u)
		assert.match(state.key.mask, /^cpk_fr•+9999$/u)
		assert.equal(calls.length, 3)
	})
})

test('插件没有写入口：服务不暴露任何保存/清除方法', async () => {
	await withStore(async (store) => {
		const service = new QuotaService({ store, options: optionsOf({ apiKey: 'cpk_0123456789' }), fetchImpl: countingFetch({ status: 200, limits: [] }).fetchImpl })
		assert.equal(service.saveKey, undefined)
		assert.equal(service.clearKey, undefined)
	})
})
