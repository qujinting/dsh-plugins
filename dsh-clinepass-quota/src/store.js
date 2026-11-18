/**
 * API Key 的读取与来源解析。
 *
 * 这个插件**不写**任何凭据：key 的增删由 DSH 的凭据存储负责（设置里配一次，
 * 所有插件共用）。这里只做两件事：
 *
 * 1. 解析：`config.apiKey` → 环境变量 → 插件目录下手工放置的
 *    `credentials.json`（最后的兜底，只读）；
 * 2. 掩码：任何回到界面或日志的地方都只出现 `maskKey` 的结果。
 *
 * 兜底文件之所以保留读能力，是因为它给了部署一个「不碰凭据库也能临时换 key」
 * 的出口（放一个文件即可）；但插件自己从不创建或修改它。
 *
 * @module dsh-clinepass-quota/store
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** 兜底文件名。 */
const FILE_NAME = 'credentials.json'

/** 低于这个长度基本是粘贴事故，掩码时整体遮掉。 */
const MIN_KEY_LENGTH = 8

/**
 * 一个 API Key 的掩码：短 key 全遮，长 key 保留头尾。
 * @param apiKey - 原始 key。
 * @returns 可安全展示的字符串。
 */
export function maskKey(apiKey) {
	if (typeof apiKey !== 'string' || apiKey.length === 0) return ''
	if (apiKey.length <= MIN_KEY_LENGTH * 2) return '•'.repeat(Math.max(4, apiKey.length))
	return `${apiKey.slice(0, 6)}${'•'.repeat(6)}${apiKey.slice(-4)}`
}

/**
 * 只读的兜底存储：从 `dataDir/credentials.json` 里取一个 key。
 */
export class KeyStore {
	/**
	 * @param options - 构造参数。
	 * @param options.dataDir - 绝对目录。
	 * @param options.logger - Cordis logger（可选）。
	 */
	constructor({ dataDir, logger }) {
		this.directory = dataDir
		this.file = path.join(dataDir, FILE_NAME)
		this.logger = logger
		/** @type {{ apiKey: string, updatedAt: string } | undefined} */
		this.entry = undefined
		/** 读取失败的原因；非空表示这一层不可用。 */
		this.problem = undefined
		/** @type {Promise<void>} */
		this.ready = this.#load()
	}

	/**
	 * 读磁盘。文件不存在是正常情况，不产生错误。
	 * @returns 完成信号。
	 */
	async #load() {
		try {
			const raw = await readFile(this.file, 'utf8')
			const parsed = JSON.parse(raw)
			if (parsed !== null && typeof parsed === 'object' && typeof parsed.apiKey === 'string' && parsed.apiKey.length > 0) {
				this.entry = { apiKey: parsed.apiKey, updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '' }
			} else {
				this.problem = `${this.file} 里没有可用的 apiKey 字段`
			}
		} catch (error) {
			if (error?.code === 'ENOENT') return
			this.problem = `读取 ${this.file} 失败：${error?.message ?? String(error)}`
			this.logger?.warn?.(`clinepass-quota: ${this.problem}`)
		}
	}
}

/**
 * 没有凭据服务时的同步回落链：环境变量 → 兜底文件。
 *
 * @param params - 解析参数。
 * @param params.envNames - 依次尝试的环境变量名。
 * @param params.env - 环境变量表（默认 `process.env`）。
 * @param params.stored - 兜底文件条目。
 * @returns `{ apiKey, source, sourceDetail }` 或 `{ source: 'missing' }`。
 */
export function resolveKey({ envNames, env = process.env, stored }) {
	for (const name of envNames) {
		const value = env?.[name]
		if (typeof value === 'string' && value.trim().length > 0) {
			return { apiKey: value.trim(), source: 'env', sourceDetail: `环境变量 ${name}` }
		}
	}
	if (stored !== undefined && typeof stored.apiKey === 'string' && stored.apiKey.length > 0) {
		return { apiKey: stored.apiKey, source: 'file', sourceDetail: '插件目录 data/credentials.json（手工放置）' }
	}
	return { source: 'missing', sourceDetail: `未配置（可写在 config.apiKey、凭据 ${envNames.join(' / ')}）` }
}
