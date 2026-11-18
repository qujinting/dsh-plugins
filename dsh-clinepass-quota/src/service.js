/**
 * 插件的内存状态：key 解析、最近一次快照、缓存与并发去重。
 *
 * ## key 从哪来
 *
 * DSH 的凭据服务（`ctx.credentials`）才是这个安装里存放 API Key 的地方：
 * 设置页写进去、按名字解析、轮换后下一次读取就生效。所以解析顺序是
 *
 * 1. `config.apiKey` —— 组合条目里写死的值，显式胜于一切；
 * 2. `ctx.credentials.resolve(name)` —— 依次试 `CLINEPASS_API_KEY`、
 *    `CLINE_API_KEY`（`config.apiKeyEnv` 可改）。它自己已经层叠了密钥存储
 *    与进程环境变量，所以同一个 key 只要在任一插件里配过一次，这里就能用；
 * 3. 插件目录下的 `credentials.json` —— 只读兜底，给部署留一个「不碰凭据库
 *    也能临时换 key」的出口（见 `store.js`）。插件自己从不写它。
 *
 * ## 缓存
 *
 * 设置页和标题栏徽章会在挂载时各自读一次，用户也可能连点刷新，而上游是每
 * 5 小时才动一次的配额。默认 60 秒窗口（`config.cacheSeconds`）。同一时刻
 * 只有一个真实请求在飞，后来者拿到同一个 Promise。
 *
 * @module dsh-clinepass-quota/service
 */

import { QuotaAuthError, fetchSnapshot } from './api.js'
import { maskKey, resolveKey } from './store.js'

/** 凭据服务不可用时的兜底名字，保证设置页的「保存」总有地方写。 */
const FALLBACK_REF = 'CLINEPASS_API_KEY'

/**
 * 额度服务。
 */
export class QuotaService {
	/**
	 * @param options - 构造参数。
	 * @param options.store - 本地 key 存储（兜底）。
	 * @param options.options - 已解析的插件选项。
	 * @param options.logger - Cordis logger。
	 * @param options.getCredentials - 取当前 `ctx.credentials`（可能没有）。
	 * @param options.fetchImpl - 可注入的 fetch（测试用）。
	 */
	constructor({ store, options, logger, getCredentials, fetchImpl }) {
		this.store = store
		this.options = options
		this.logger = logger
		this.getCredentials = getCredentials ?? (() => undefined)
		this.fetchImpl = fetchImpl
		/** 依次尝试的凭据名；空列表时退回 FALLBACK_REF，保证总能写入。 */
		this.refs = Array.isArray(options.apiKeyEnv) && options.apiKeyEnv.length > 0
			? [...options.apiKeyEnv]
			: [FALLBACK_REF]
		/** @type {object | undefined} 最近一次成功的快照。 */
		this.snapshot = undefined
		/** @type {number} 快照写入的时间戳。 */
		this.fetchedAt = 0
		/** @type {Promise<object> | undefined} 正在飞行的请求。 */
		this.inFlight = undefined
		/** @type {{ message: string, status?: number } | undefined} */
		this.lastError = undefined
	}

	/**
	 * 当前的凭据服务实例（可能不存在）。
	 * @returns credentials 服务或 undefined。
	 */
	#credentials() {
		try {
			const service = this.getCredentials()
			return service !== undefined && service !== null ? service : undefined
		} catch {
			return undefined
		}
	}

	/**
	 * 按优先级解析出实际使用的 key。
	 * @returns `{ apiKey, source, sourceDetail }` 或 `{ source: 'missing' }`。
	 */
	async resolve() {
		if (typeof this.options.apiKey === 'string' && this.options.apiKey.length > 0) {
			return { apiKey: this.options.apiKey, source: 'config', sourceDetail: '插件配置 config.apiKey' }
		}

		const credentials = this.#credentials()
		if (credentials !== undefined && typeof credentials.resolve === 'function') {
			for (const name of this.refs) {
				try {
					const hit = await credentials.resolve(name)
					if (hit !== undefined && hit !== null && typeof hit.value === 'string' && hit.value.length > 0) {
						return {
							apiKey: hit.value,
							source: 'credentials',
							sourceDetail: `凭据存储 ${name}${typeof hit.source === 'string' ? `（${hit.source}）` : ''}`,
						}
					}
				} catch (error) {
					// 一个名字解析失败不该挡住下一个候选名。
					this.logger?.warn?.(`clinepass-quota: 解析凭据 ${name} 失败：${error?.message ?? String(error)}`)
				}
			}
		}

		// 没有凭据服务（或里面没有）时，回到环境变量 + 本地文件的同步链路。
		return resolveKey({
			configKey: undefined,
			envNames: this.refs,
			stored: this.store.entry,
		})
	}

	/**
	 * 当前 key 的公开描述（永不包含值）。
	 * @returns key 描述。
	 */
	async keyInfo() {
		const resolved = await this.resolve()
		if (resolved.source === 'missing') {
			return {
				configured: false,
				source: 'missing',
				sourceDetail: `未配置（可写在 config.apiKey、凭据 ${this.refs.join(' / ')} 或设置页）`,
				mask: '',
			}
		}
		return {
			configured: true,
			source: resolved.source,
			sourceDetail: resolved.sourceDetail,
			mask: maskKey(resolved.apiKey),
		}
	}

	/**
	 * 读完整状态：key 描述 + 快照（缓存优先）。
	 *
	 * 永远不抛异常：失败信息放在 `error` 里，页面与工具各自决定怎么显示。
	 *
	 * @param params - 调用参数。
	 * @param params.force - 忽略缓存。
	 * @returns 状态对象。
	 */
	async state({ force = false } = {}) {
		const key = await this.keyInfo()
		const now = Date.now()
		const ttlMs = this.options.cacheSeconds * 1000
		const ageMs = this.fetchedAt === 0 ? undefined : now - this.fetchedAt

		if (key.configured === false) {
			return {
				ok: false,
				key,
				snapshot: undefined,
				cache: { cached: false, ageSeconds: undefined },
				cacheSeconds: this.options.cacheSeconds,
				error: `还没有配置 Cline API Key。${key.sourceDetail}`,
			}
		}

		if (!force && this.snapshot !== undefined && ageMs !== undefined && ageMs < ttlMs) {
			return {
				ok: true,
				key,
				snapshot: this.snapshot,
				cache: { cached: true, ageSeconds: Math.round(ageMs / 1000) },
				cacheSeconds: this.options.cacheSeconds,
			}
		}

		try {
			const snapshot = await this.refresh()
			return {
				ok: true,
				key,
				snapshot,
				cache: { cached: false, ageSeconds: 0 },
				cacheSeconds: this.options.cacheSeconds,
			}
		} catch (error) {
			this.logger?.warn?.(`clinepass-quota: 查询失败：${error?.message ?? String(error)}`)
			return {
				ok: false,
				key,
				// 失败时把上一份成功快照一起带回去：一个 401 不该让页面上原本
				// 正确的数字变成空白。
				snapshot: this.snapshot,
				cache: { cached: true, ageSeconds: ageMs === undefined ? undefined : Math.round(ageMs / 1000) },
				cacheSeconds: this.options.cacheSeconds,
				error: error?.message ?? String(error),
				...(error instanceof QuotaAuthError ? { authFailed: true } : {}),
			}
		}
	}

	/**
	 * 强制查一次网络并更新缓存（并发调用共享同一个请求）。
	 *
	 * `inFlight` 必须在任何 `await` 之前同步赋值，否则三个同时到达的调用会各
	 * 自通过检查、各发一轮请求 —— 去重就形同虚设。
	 *
	 * @returns 快照。
	 */
	refresh() {
		if (this.inFlight !== undefined) return this.inFlight
		const task = this.#runRefresh()
		this.inFlight = task
		return task
	}

	/**
	 * `refresh()` 的实际执行体。
	 * @returns 快照。
	 */
	async #runRefresh() {
		try {
			const resolved = await this.resolve()
			if (resolved.source === 'missing') throw new Error(`还没有配置 Cline API Key。${resolved.sourceDetail}`)
			const snapshot = await fetchSnapshot({
				baseUrl: this.options.baseUrl,
				apiKey: resolved.apiKey,
				timeoutMs: this.options.timeoutMs,
				balanceUnit: this.options.balanceUnit,
				showCredits: this.options.showCredits,
				...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
			})
			this.snapshot = snapshot
			this.fetchedAt = Date.now()
			this.lastError = undefined
			return snapshot
		} catch (error) {
			this.lastError = {
				message: error?.message ?? String(error),
				...(error?.status === undefined ? {} : { status: error.status }),
			}
			throw error
		} finally {
			this.inFlight = undefined
		}
	}

	/**
	 * 让下一次读取重新查网络。
	 */
	invalidate() {
		this.fetchedAt = 0
	}
}

/** 导出给测试与日志用的兜底引用名。 */
export { FALLBACK_REF }
