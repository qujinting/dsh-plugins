/**
 * ClinePass 额度的唯一数据源：`api.cline.bot` 的三个只读接口。
 *
 * 1. `GET /users/me/plan/usage-limits` —— 订阅配额本体。三档窗口
 *    （5 小时滚动 / 周 / 月），每档给 `percentUsed` 与可选的 `resetsAt`。
 *    没有 ClinePass 订阅的账户拿到 404，这是「该 key 没有订阅」的唯一信号。
 * 2. `GET /users/me` —— 账户身份，顺便拿到查余额要用的 id。
 * 3. `GET /users/{id}/balance` —— 按量付费余额，单位是**百万分之一美元**。
 *
 * 这个模块只做「请求 + 归一化」，不做缓存、不读配置、不碰磁盘：调用方拿到的
 * 永远是一个自洽的快照对象，或者一个带原因的异常。三档窗口的键名、字段名各
 * 家实现并不一致（下划线 / 驼峰、数组 / 对象），所以解析层刻意宽容：认不出的
 * 字段就当没有，认不出的窗口原样保留，绝不因为一个未知字段丢掉整份数据。
 *
 * @module dsh-clinepass-quota/api
 */

/** 窗口的规范顺序与中文标签。名字来自接口的 `type` 字段。 */
export const WINDOW_ORDER = ['five_hour', 'weekly', 'monthly']

/** 已知窗口的展示标签。 */
export const WINDOW_LABEL = {
	five_hour: '5 小时',
	weekly: '本周',
	monthly: '本月',
}

/** 接口返回的窗口别名 → 规范名。 */
const WINDOW_ALIASES = {
	five_hour: 'five_hour',
	five_hours: 'five_hour',
	'5h': 'five_hour',
	'5_hour': 'five_hour',
	rolling_5h: 'five_hour',
	weekly: 'weekly',
	week: 'weekly',
	'7d': 'weekly',
	monthly: 'monthly',
	month: 'monthly',
	'30d': 'monthly',
}

/**
 * 把一段文本里出现的 key 抹掉。
 *
 * 这些错误串最终会流进 `notes` → 工具结果 → **session log**，而上游的响应体
 * （错误页、网关、代理）完全可能在里面原样回显 Authorization。所以任何要带
 * 上游原文出去的地方，都先过一遍这里。
 *
 * @param text - 待清洗的文本。
 * @param apiKey - 当前使用的 key。
 * @returns 清洗后的文本。
 */
export function redactText(text, apiKey) {
	if (typeof text !== 'string' || text.length === 0) return text
	// 太短的串做替换只会误伤，真正的 key 都比这长。
	if (typeof apiKey !== 'string' || apiKey.length < 12) return text
	return text.split(apiKey).join(`${apiKey.slice(0, 6)}«redacted»`)
}

/** 一个 key 没权限/没订阅时抛出的错误类型，路由据此给 4xx 而不是 5xx。 */export class QuotaAuthError extends Error {
	/**
	 * @param message - 面向人的原因。
	 * @param status - 上游 HTTP 状态。
	 */
	constructor(message, status) {
		super(message)
		this.name = 'QuotaAuthError'
		this.status = status
	}
}

/**
 * 发起一次带 Bearer 鉴权的 GET，返回状态码与已解析的 JSON。
 *
 * @param params - 请求参数。
 * @param params.baseUrl - API 根地址（不带尾部斜杠）。
 * @param params.path - 以 `/` 开头的路径。
 * @param params.apiKey - Cline API Key。
 * @param params.timeoutMs - 超时毫秒数。
 * @param params.fetchImpl - 可注入的 fetch（测试用）。
 * @returns 状态码与解析后的负载（无 body 时为 undefined）。
 */
async function requestJson({ baseUrl, path, apiKey, timeoutMs, fetchImpl }) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	let response
	try {
		response = await fetchImpl(`${baseUrl}${path}`, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: 'application/json',
				'User-Agent': 'dsh-clinepass-quota',
			},
			signal: controller.signal,
			cache: 'no-store',
		})
	} catch (error) {
		const reason = error?.name === 'AbortError' ? `请求超时（${String(timeoutMs)} ms）` : (error?.message ?? String(error))
		throw new Error(`连接 ${baseUrl} 失败：${reason}`)
	} finally {
		clearTimeout(timer)
	}

	const text = await response.text()
	let payload
	if (text.trim().length > 0) {
		try {
			payload = JSON.parse(text)
		} catch {
			payload = undefined
			if (response.ok) throw new Error(redactText(`${path} 返回了非 JSON 内容（HTTP ${String(response.status)}）：${text.slice(0, 200)}`, apiKey))
		}
	}
	return { status: response.status, payload, text }
}

/**
 * 从任意层级里找额度数组，找不到再尝试对象形式。
 *
 * @param payload - usage-limits 的解析结果。
 * @returns 归一化前的条目数组（可能为空）。
 */
export function findLimitEntries(payload) {
	if (payload === null || payload === undefined) return []
	const containers = [
		payload,
		payload?.data,
		payload?.result,
		payload?.usage,
	]
	for (const container of containers) {
		if (container === null || container === undefined) continue
		for (const field of ['limits', 'usageLimits', 'usage_limits', 'windows', 'plan']) {
			const value = container?.[field]
			if (Array.isArray(value)) return value
			if (value !== null && typeof value === 'object') {
				// 对象形式：`{ five_hour: {...}, weekly: {...} }`。
				return Object.entries(value).map(([key, entry]) => (
					entry !== null && typeof entry === 'object' ? { type: key, ...entry } : { type: key, percentUsed: entry }
				))
			}
		}
	}
	return Array.isArray(payload) ? payload : []
}

/**
 * 读一个数字字段，字符串数字也算。
 * @param value - 原始值。
 * @returns 有限数字，或 undefined。
 */
function numberOrUndefined(value) {
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value === 'string' && value.trim().length > 0) {
		const parsed = Number(value)
		if (Number.isFinite(parsed)) return parsed
	}
	return undefined
}

/**
 * 把一条窗口记录折成快照里的窗口对象。
 *
 * `percentUsed` 优先；没有就由 `used` / `limit` 现算。结果被夹在 0–100，
 * 因为上游偶尔会返回 100.4 这种值，而进度条只接受闭区间。
 *
 * @param entry - 单条原始记录。
 * @returns 归一化窗口，或 undefined（既没有百分比也没有用量）。
 */
export function normalizeWindow(entry) {
	if (entry === null || typeof entry !== 'object') return undefined

	const rawKey = String(entry.type ?? entry.window ?? entry.name ?? entry.key ?? 'unknown')
	const key = WINDOW_ALIASES[rawKey.toLowerCase()] ?? rawKey

	let percentUsed = numberOrUndefined(
		entry.percentUsed ?? entry.percent_used ?? entry.usedPercent ?? entry.used_percent ?? entry.usagePercent,
	)
	if (percentUsed === undefined) {
		const used = numberOrUndefined(entry.used ?? entry.usage ?? entry.tokensUsed ?? entry.tokens_used)
		const limit = numberOrUndefined(entry.limit ?? entry.quota ?? entry.max ?? entry.tokensLimit ?? entry.tokens_limit)
		if (used !== undefined && limit !== undefined && limit > 0) percentUsed = (used / limit) * 100
	}
	if (percentUsed === undefined) return undefined

	const clamped = Math.min(100, Math.max(0, percentUsed))
	const resetsAt = entry.resetsAt ?? entry.resets_at ?? entry.resetAt ?? entry.reset_at ?? entry.resetTime

	return {
		key,
		label: WINDOW_LABEL[key] ?? key,
		percentUsed: round(clamped),
		percentRemaining: round(100 - clamped),
		...(typeof resetsAt === 'string' && resetsAt.length > 0 ? { resetsAt } : {}),
	}
}

/**
 * 保留一位小数，去掉无意义的 `.0`。
 * @param value - 原始数值。
 * @returns 四舍五入后的数值。
 */
function round(value) {
	return Math.round(value * 10) / 10
}

/**
 * 按规范顺序排序窗口，未知窗口排在已知窗口之后（保持原始顺序）。
 *
 * @param windows - 归一化窗口数组。
 * @returns 排序后的新数组。
 */
export function sortWindows(windows) {
	const known = new Map(WINDOW_ORDER.map((key, index) => [key, index]))
	return [...windows].sort((left, right) => {
		const leftIndex = known.get(left.key) ?? WINDOW_ORDER.length
		const rightIndex = known.get(right.key) ?? WINDOW_ORDER.length
		return leftIndex - rightIndex
	})
}

/**
 * 读账户 id：三个字段名在不同版本里都出现过。
 * @param payload - `/users/me` 的负载。
 * @returns id 或 undefined。
 */
export function accountIdOf(payload) {
	const source = payload?.data ?? payload
	const id = source?.id ?? source?.clineUserId ?? source?.cline_user_id ?? source?.subject ?? source?.userId ?? source?.user_id
	return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * 读余额并换算成美元。
 *
 * 官方接口给的是百万分之一美元，`balanceUnit: 'usd'` 时才原样使用。**不做
 * 分位取整**：微美元就是这个值的真实精度，把 $0.190123 显示成 $0.19 会让
 * 用户以为自己只剩两毛钱，而实际还差一点。
 *
 * @param payload - `/users/{id}/balance` 的负载。
 * @param unit - `micro` 或 `usd`。
 * @returns 美元金额（最多六位小数），或 undefined。
 */
export function balanceUsdOf(payload, unit) {
	const source = payload?.data ?? payload
	const raw = numberOrUndefined(source?.balance ?? source?.credits ?? source?.creditBalance ?? source?.credit_balance)
	if (raw === undefined) return undefined
	const usd = unit === 'usd' ? raw : raw / 1_000_000
	// 除以 1e6 会带出二进制浮点的尾巴，按微美元归整一次只去噪、不改精度。
	return Math.round(usd * 1_000_000) / 1_000_000
}

/**
 * 把美元金额写成展示文本：小于 1 美元时给足微美元精度。
 *
 * 小数位不写死：`$0.190123` 写成 `$0.19` 会让用户以为只剩两毛，而固定六位
 * 的 `$0.190000` 又显得是设备读数。所以先按六位取，再裁掉尾零 —— 有多少
 * 精度就显示多少，最多到微美元。
 *
 * @param usd - 金额。
 * @returns 展示文本（不含 `$`）。
 */
export function formatUsd(usd) {
	if (typeof usd !== 'number' || !Number.isFinite(usd)) return '—'
	if (usd === 0) return '0.00'
	if (Math.abs(usd) >= 1) return usd.toFixed(2)
	const six = usd.toFixed(6)
	const trimmed = six.replace(/0+$/u, '')
	return trimmed.endsWith('.') ? six : trimmed
}

/**
 * 查询一次完整快照。三个请求里只有第一个是必需的。
 *
 * @param options - 查询参数。
 * @param options.baseUrl - API 根地址。
 * @param options.apiKey - Cline API Key。
 * @param options.timeoutMs - 单请求超时。
 * @param options.balanceUnit - 余额单位。
 * @param options.showCredits - 是否查余额。
 * @param options.fetchImpl - 可注入的 fetch。
 * @returns 快照对象。
 */
export async function fetchSnapshot(options) {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch
	if (typeof fetchImpl !== 'function') throw new Error('当前运行时没有可用的 fetch')

	const startedAt = Date.now()
	const notes = []

	const limitsResponse = await requestJson({
		baseUrl: options.baseUrl,
		path: '/users/me/plan/usage-limits',
		apiKey: options.apiKey,
		timeoutMs: options.timeoutMs,
		fetchImpl,
	})

	if (limitsResponse.status === 401 || limitsResponse.status === 403) {
		throw new QuotaAuthError(
			`API Key 被拒绝（HTTP ${String(limitsResponse.status)}）。请确认它是在 app.cline.bot 的 Settings → API Keys 里创建的。`,
			limitsResponse.status,
		)
	}

	/** 快照骨架：后面每个可选调用只往里填字段。 */
	const snapshot = {
		fetchedAt: new Date().toISOString(),
		durationMs: 0,
		baseUrl: options.baseUrl,
		hasPlan: false,
		windows: [],
		account: undefined,
		credits: undefined,
		notes,
	}

	if (limitsResponse.status === 404) {
		// 文档与两家第三方实现都把这个 404 当作「该账户没有 ClinePass」。
		notes.push('该 API Key 的账户没有 ClinePass 订阅（usage-limits 返回 404）。')
	} else if (limitsResponse.status === 200) {
		const entries = findLimitEntries(limitsResponse.payload)
		const windows = entries.map(normalizeWindow).filter((entry) => entry !== undefined)
		snapshot.windows = sortWindows(windows)
		snapshot.hasPlan = windows.length > 0
		if (windows.length === 0) notes.push('接口返回 200，但响应里没有可识别的配额窗口。')
	} else {
		throw new Error(redactText(
			`usage-limits 返回 HTTP ${String(limitsResponse.status)}${limitsResponse.text ? `：${limitsResponse.text.slice(0, 200)}` : ''}`,
			options.apiKey,
		))
	}

	// 身份与余额是装饰性的：拿不到不该让整份快照失败。
	try {
		const meResponse = await requestJson({
			baseUrl: options.baseUrl,
			path: '/users/me',
			apiKey: options.apiKey,
			timeoutMs: options.timeoutMs,
			fetchImpl,
		})
		if (meResponse.status === 200) {
			const id = accountIdOf(meResponse.payload)
			const source = meResponse.payload?.data ?? meResponse.payload
			const email = typeof source?.email === 'string' ? source.email : undefined
			const name = typeof source?.name === 'string' ? source.name : undefined
			snapshot.account = {
				...(id === undefined ? {} : { id }),
				...(email === undefined ? {} : { email }),
				...(name === undefined ? {} : { name }),
			}
			if (options.showCredits && id !== undefined) {
				const balanceResponse = await requestJson({
					baseUrl: options.baseUrl,
					path: `/users/${encodeURIComponent(id)}/balance`,
					apiKey: options.apiKey,
					timeoutMs: options.timeoutMs,
					fetchImpl,
				})
				if (balanceResponse.status === 200) {
					const usd = balanceUsdOf(balanceResponse.payload, options.balanceUnit)
					if (usd !== undefined) snapshot.credits = { usd }
					else notes.push('余额接口返回 200，但响应里没有可识别的 balance 字段。')
				} else if (balanceResponse.status !== 404) {
					notes.push(`余额查询返回 HTTP ${String(balanceResponse.status)}。`)
				}
			}
		} else if (meResponse.status !== 404) {
			notes.push(`账户信息查询返回 HTTP ${String(meResponse.status)}。`)
		}
	} catch (error) {
		notes.push(`账户/余额信息未取到：${error?.message ?? String(error)}`)
	}

	snapshot.durationMs = Date.now() - startedAt
	return snapshot
}
