import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	QuotaAuthError,
	accountIdOf,
	balanceUsdOf,
	fetchSnapshot,
	findLimitEntries,
	formatUsd,
	normalizeWindow,
	redactText,
	sortWindows,
} from '../src/api.js'

/**
 * 造一个 fetch 替身：按 path 后缀返回预设响应，并记录调用。
 * @param routes - `{ '/path': { status, body } }`
 * @returns `{ fetchImpl, calls }`
 */
function fakeFetch(routes) {
	const calls = []
	const fetchImpl = async (url) => {
		calls.push(url)
		const path = new URL(url).pathname
		const match = Object.keys(routes).find((key) => path.endsWith(key))
		if (match === undefined) {
			return { ok: false, status: 404, text: async () => '' }
		}
		const { status, body } = routes[match]
		return {
			ok: status >= 200 && status < 300,
			status,
			text: async () => (body === undefined ? '' : JSON.stringify(body)),
		}
	}
	return { calls, fetchImpl }
}

const baseOptions = {
	baseUrl: 'https://api.example.test/api/v1',
	apiKey: 'cpk_test_key_1234',
	timeoutMs: 5_000,
	balanceUnit: 'micro',
	showCredits: true,
}

test('三个窗口按 5h / week / month 排序，并算出剩余百分比', async () => {
	const { fetchImpl, calls } = fakeFetch({
		'/users/me/plan/usage-limits': {
			status: 200,
			body: {
				limits: [
					{ type: 'monthly', percentUsed: 8.5 },
					{ type: 'five_hour', percentUsed: 37, resetsAt: '2026-11-18T10:00:00Z' },
					{ type: 'weekly', percent_used: '20' },
				],
			},
		},
		'/users/me': { status: 200, body: { id: 'user_1', email: 'a@b.c' } },
		'/users/user_1/balance': { status: 200, body: { balance: 1_234_567 } },
	})

	const snapshot = await fetchSnapshot({ ...baseOptions, fetchImpl })

	assert.equal(snapshot.hasPlan, true)
	assert.deepEqual(snapshot.windows.map((window) => window.key), ['five_hour', 'weekly', 'monthly'])
	assert.deepEqual(snapshot.windows[0], {
		key: 'five_hour',
		label: '5 小时',
		percentUsed: 37,
		percentRemaining: 63,
		resetsAt: '2026-11-18T10:00:00Z',
	})
	assert.equal(snapshot.windows[2].percentRemaining, 91.5)
	// 余额保留微美元精度：$1.234567 不该被减到 $1.23。
	assert.equal(snapshot.credits.usd, 1.234567)
	assert.equal(snapshot.account.email, 'a@b.c')
	assert.equal(calls.length, 3)
})

test('对象形式的窗口也能读', () => {
	const entries = findLimitEntries({ data: { usageLimits: { five_hour: { percentUsed: 10 }, weekly: { used: 5, limit: 10 } } } })
	assert.equal(entries.length, 2)
	const normalized = entries.map(normalizeWindow)
	assert.equal(normalized[0].percentUsed, 10)
	assert.equal(normalized[1].percentUsed, 50)
})

test('百分号被夹在 0–100，缺百分比的窗口被丢掉', () => {
	assert.equal(normalizeWindow({ type: 'weekly', percentUsed: 140 }).percentUsed, 100)
	assert.equal(normalizeWindow({ type: 'weekly', percentUsed: -20 }).percentRemaining, 100)
	assert.equal(normalizeWindow({ type: 'weekly' }), undefined)
	assert.equal(normalizeWindow(undefined), undefined)
})

test('未知窗口保留顺序且排在已知窗口之后', () => {
	const windows = [
		{ key: 'monthly', label: '本月', percentUsed: 1, percentRemaining: 99 },
		{ key: 'daily', label: 'daily', percentUsed: 1, percentRemaining: 99 },
		{ key: 'five_hour', label: '5 小时', percentUsed: 1, percentRemaining: 99 },
	]
	assert.deepEqual(sortWindows(windows).map((window) => window.key), ['five_hour', 'monthly', 'daily'])
})

test('404 表示没有订阅，但余额仍会查（两套账独立）', async () => {
	const { fetchImpl, calls } = fakeFetch({
		'/users/me/plan/usage-limits': { status: 404 },
		'/users/me': { status: 200, body: { id: 'user_1' } },
		'/users/user_1/balance': { status: 200, body: { balance: 5_000_000 } },
	})
	const snapshot = await fetchSnapshot({ ...baseOptions, fetchImpl })
	assert.equal(snapshot.hasPlan, false)
	assert.deepEqual(snapshot.windows, [])
	assert.equal(snapshot.notes.length, 1)
	assert.match(snapshot.notes[0], /没有 ClinePass 订阅/u)
	// 没有订阅的账户仍可能有用量计费余额，所以这一步照查。
	assert.equal(calls.some((url) => url.includes('/balance')), true)
	assert.equal(snapshot.credits.usd, 5)
})

test('401 抛出 QuotaAuthError', async () => {
	const { fetchImpl } = fakeFetch({ '/users/me/plan/usage-limits': { status: 401 } })
	await assert.rejects(fetchSnapshot({ ...baseOptions, fetchImpl }), (error) => {
		assert.ok(error instanceof QuotaAuthError)
		assert.equal(error.status, 401)
		return true
	})
})

test('余额与身份失败不影响配额', async () => {
	const { fetchImpl } = fakeFetch({
		'/users/me/plan/usage-limits': { status: 200, body: { limits: [{ type: 'weekly', percentUsed: 12 }] } },
		'/users/me': { status: 500 },
	})
	const snapshot = await fetchSnapshot({ ...baseOptions, fetchImpl })
	assert.equal(snapshot.windows.length, 1)
	assert.equal(snapshot.credits, undefined)
	assert.match(snapshot.notes.join(' '), /账户信息查询返回 HTTP 500/u)
})

test('balanceUnit: usd 不再除以一百万', () => {
	assert.equal(balanceUsdOf({ balance: 3.5 }, 'usd'), 3.5)
	assert.equal(balanceUsdOf({ balance: 3_500_000 }, 'micro'), 3.5)
	assert.equal(balanceUsdOf({ data: { credits: 12 } }, 'usd'), 12)
	assert.equal(balanceUsdOf({}, 'micro'), undefined)
})

test('余额不按分取整，展示裁掉尾零但不丢精度', () => {
	// 190123 微美元 = $0.190123：两位小数会写成 $0.19，那是错的。
	assert.equal(balanceUsdOf({ balance: 190_123 }, 'micro'), 0.190123)
	assert.equal(formatUsd(0.190123), '0.190123')
	assert.equal(formatUsd(0.19), '0.19')
	assert.equal(formatUsd(1.234567), '1.23')
	assert.equal(formatUsd(0), '0.00')
	assert.equal(formatUsd(0.000123), '0.000123')
	assert.equal(formatUsd(0.0000004), '0.000000')
	assert.equal(formatUsd(undefined), '—')
})

test('账户 id 兼容几种字段名', () => {
	assert.equal(accountIdOf({ id: 'a' }), 'a')
	assert.equal(accountIdOf({ clineUserId: 'b' }), 'b')
	assert.equal(accountIdOf({ data: { subject: 'c' } }), 'c')
	assert.equal(accountIdOf({}), undefined)
})

test('redactText 只抹完整 key，太短的串不动', () => {
	const secret = 'sk_1234567890abcdef'
	assert.equal(redactText(`token ${secret} invalid`, secret), 'token sk_123«redacted» invalid')
	assert.equal(redactText('nothing to redact', secret), 'nothing to redact')
	// 短于 12 字符时按「不是 key」处理，避免误伤普通文本。
	assert.equal(redactText('abc', 'abc'), 'abc')
	assert.equal(redactText(undefined, secret), undefined)
})

test('上游在错误体里回显 key 时，错误文本里只剩 «redacted»', async () => {
	// 真实场景：网关或错误页把 Authorization 原样写回了响应体，而这段文本
	// 会进 notes → 工具结果 → session log。
	const secret = 'sk_067abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
	const inlineFetch = async () => ({
		ok: false,
		status: 500,
		text: async () => JSON.stringify({ error: `invalid credential ${secret}` }),
	})
	await assert.rejects(
		fetchSnapshot({ ...baseOptions, apiKey: secret, fetchImpl: inlineFetch }),
		(error) => {
			assert.equal(error.message.includes(secret), false, '错误串里不能出现完整 key')
			assert.match(error.message, /«redacted»/u)
			return true
		},
	)
})
