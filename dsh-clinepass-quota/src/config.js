/**
 * 配置投影：把 Loader 校验过的 `config` 折成一组确定可用的值。
 *
 * 不声明 `Config` schema 是有意的 —— 这个插件的每个字段都有合理默认值，
 * 而一个字段写错最坏的结果应该是「回落到默认并打一行 warning」，不是让
 * 整条插件行加载失败。缺省、部分、多余字段都按正常情况处理。
 *
 * @module dsh-clinepass-quota/config
 */

/** Cline 的公开 API 根地址；`baseUrl` 可覆盖它（自建代理 / 测试桩）。 */
export const DEFAULT_BASE_URL = 'https://api.cline.bot/api/v1'

/** 依次尝试的两个环境变量，顺序与 CodexBar / magpie 一致。 */
export const DEFAULT_KEY_ENV = ['CLINEPASS_API_KEY', 'CLINE_API_KEY']

/** 插件目录名，用于日志前缀。 */
export const PLUGIN_NAME = 'dsh-clinepass-quota'

/**
 * 读取一个可选的、非空字符串。
 * @param value - 原始配置值。
 * @returns 去空白后的字符串，或 undefined。
 */
function nonEmptyString(value) {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	return trimmed.length === 0 ? undefined : trimmed
}

/**
 * 读取一个带上下界的整数，越界时报告并回落。
 * @param value - 原始配置值。
 * @param fallback - 缺省值。
 * @param minimum - 闭区间下界。
 * @param maximum - 闭区间上界。
 * @param label - 用于告警的字段名。
 * @param warn - 告警出口。
 * @returns 解析后的整数。
 */
function boundedInteger(value, fallback, minimum, maximum, label, warn) {
	if (value === undefined) return fallback
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		warn(`${label} 必须是 ${String(minimum)}–${String(maximum)} 之间的整数，已回落到 ${String(fallback)}`)
		return fallback
	}
	return value
}

/**
 * 把配置投影成插件选项。
 *
 * @param config - 组合条目的配置对象。
 * @param warn - 被拒绝的值的出口。
 * @returns 解析后的选项。
 */
export function readOptions(config, warn = () => {}) {
	const source = config !== null && typeof config === 'object' ? config : {}

	// 尾部斜杠在拼接时统一处理，这里只去掉它，避免出现 `//users/me`。
	const rawBaseUrl = nonEmptyString(source.baseUrl) ?? DEFAULT_BASE_URL
	const baseUrl = rawBaseUrl.replace(/\/+$/u, '')

	// 环境变量：允许用一个字符串覆盖默认的两个候选名。
	const envSource = source.apiKeyEnv ?? source.apiKeyEnvs
	const apiKeyEnv = Array.isArray(envSource)
		? envSource.map((name) => nonEmptyString(name)).filter((name) => name !== undefined)
		: nonEmptyString(envSource) === undefined
			? [...DEFAULT_KEY_ENV]
			: [nonEmptyString(envSource)]

	return {
		baseUrl,
		// 配置里直接写死的 key 优先级最高：显式胜于约定。
		apiKey: nonEmptyString(source.apiKey),
		apiKeyEnv: apiKeyEnv.length === 0 ? [...DEFAULT_KEY_ENV] : apiKeyEnv,
		// 相对路径按插件目录解析（与 secret-broker 的 dataDir 语义一致）。
		dataDir: nonEmptyString(source.dataDir),
		toolName: validToolName(nonEmptyString(source.toolName) ?? 'clinepass_quota', warn),
		cacheSeconds: boundedInteger(source.cacheSeconds, 60, 0, 3600, 'cacheSeconds', warn),
		timeoutMs: boundedInteger(source.timeoutMs, 15_000, 1000, 120_000, 'timeoutMs', warn),
		// `micro` 是 Cline 官方返回的单位（百万分之一美元）；改成 `usd` 只为兼容代理。
		balanceUnit: source.balanceUnit === 'usd' ? 'usd' : 'micro',
		showCredits: source.showCredits !== false,
		headerBadge: source.headerBadge !== false,
		registerTool: source.registerTool !== false,
		registerRoutes: source.registerRoutes !== false,
	}
}

/**
 * 校验工具名。
 * @param name - 候选工具名。
 * @param warn - 告警出口。
 * @returns 合法的工具名。
 */
function validToolName(name, warn) {
	if (/^[a-z][a-z0-9_]*$/u.test(name)) return name
	warn(`toolName "${name}" 不合法（须匹配 ^[a-z][a-z0-9_]*$），已回落到 clinepass_quota`)
	return 'clinepass_quota'
}
