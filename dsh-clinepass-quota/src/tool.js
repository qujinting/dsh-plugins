/**
 * 模型侧入口：`clinepass_quota`。
 *
 * 同一个操作两个调用者（工具与设置页），实现只有 `QuotaService.state()` 一处，
 * 参数含义也一致 —— 见 references/user-actions.md。工具名、参数与返回的形状
 * 都刻意窄：一个布尔开关，加一份结构化快照 + 一段可直接读的文本。
 *
 * @module dsh-clinepass-quota/tool
 */

import { formatUsd } from './api.js'

/**
 * 把 ISO 时间写成简短的本地时间。
 * @param value - ISO 字符串或空。
 * @returns 可读时间，或 undefined。
 */
function timeText(value) {
	if (typeof value !== 'string' || value.length === 0) return undefined
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return value
	return date.toLocaleString('zh-CN', { hour12: false })
}

/**
 * 构造工具定义。
 *
 * @param params - 构造参数。
 * @param params.toolName - 注册名。
 * @param params.service - 额度服务。
 * @param params.options - 已解析的插件选项。
 * @returns `ctx.tools.register` 接受的定义。
 */
export function clinepassQuotaTool({ toolName, service, options }) {
	return {
		name: toolName,
		description: [
			'查询当前 ClinePass 订阅的剩余额度。',
			'返回三档窗口（5 小时滚动、周、月）的已用/剩余百分比与重置时间，以及按量付费余额（credits，美元）。',
			'用法：直接调用即可；缓存默认 60 秒，需要绕过缓存拿最新值时传 `refresh: true`。',
			'ClinePass 是 $9.99/月的定额订阅，配额按窗口滚动，与按量付费余额是两套：余额为 0 不等于订阅到期。',
			`没有 ClinePass 订阅的 API Key 会返回 404，工具会明确说明「该账户没有订阅」，此时不要反复重试。`,
			'需要用户配置 key 时，指向 设置 → ClinePass 额度（也可写在 config.apiKey 或 DSH 凭据 ',
			`${options.apiKeyEnv.join(' / ')}）。`,
		].join(''),
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				refresh: {
					type: 'boolean',
					description: '绕过 60 秒缓存，强制重新查询一次。',
				},
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					ok: { type: 'boolean' },
					queryTime: { type: 'string' },
					hasPlan: { type: 'boolean' },
					windows: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								window: { type: 'string' },
								label: { type: 'string' },
								percentUsed: { type: 'number' },
								percentRemaining: { type: 'number' },
								resetsAt: { type: 'string' },
							},
							required: ['window', 'label', 'percentUsed', 'percentRemaining'],
						},
					},
					creditsUsd: { type: 'number' },
					account: { type: 'string' },
					keySource: { type: 'string' },
					notes: { type: 'string' },
					error: { type: 'string' },
				},
				required: ['ok'],
			},
			render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const state = await service.state({ force: args?.refresh === true })
			const snapshot = state.snapshot
			if (state.ok !== true || snapshot === undefined) {
				return {
					ok: false,
					...(state.error === undefined ? {} : { error: state.error }),
					keySource: state.key.sourceDetail,
				}
			}
			const notes = []
			if (state.cache.cached === true && state.cache.ageSeconds !== undefined) {
				notes.push(`结果来自 ${String(state.cache.ageSeconds)} 秒前的缓存；需要最新值请传 refresh: true。`)
			}
			if (Array.isArray(snapshot.notes) && snapshot.notes.length > 0) notes.push(...snapshot.notes)
			const account = snapshot.account?.email ?? snapshot.account?.name ?? snapshot.account?.id
			return {
				ok: true,
				queryTime: snapshot.fetchedAt,
				hasPlan: snapshot.hasPlan === true,
				windows: (snapshot.windows ?? []).map((window) => ({
					window: window.key,
					label: window.label,
					percentUsed: window.percentUsed,
					percentRemaining: window.percentRemaining,
					...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
				})),
				...(snapshot.credits === undefined ? {} : { creditsUsd: snapshot.credits.usd }),
				...(account === undefined ? {} : { account }),
				keySource: state.key.sourceDetail,
				...(notes.length === 0 ? {} : { notes: notes.join(' ') }),
			}
		},
	}
}

/**
 * 把工具结果渲染成模型直接读的文本。
 * @param value - 已校验的工具输出。
 * @returns 文本块内容。
 */
function renderResult(value) {
	if (value.ok !== true) {
		const lines = ['ClinePass 额度查询失败。']
		if (value.error !== undefined) lines.push(`原因：${value.error}`)
		if (value.keySource !== undefined) lines.push(`Key 来源：${value.keySource}`)
		lines.push('请让用户在 设置 → ClinePass 额度 里配置 API Key（或在 app.cline.bot 的 Settings → API Keys 新建）。')
		return lines.join('\n')
	}

	const lines = [`ClinePass 额度（查询于 ${timeText(value.queryTime) ?? value.queryTime}）`]
	if (value.account !== undefined) lines.push(`账户：${value.account}`)
	if (value.hasPlan === true && value.windows.length > 0) {
		for (const window of value.windows) {
			const reset = timeText(window.resetsAt)
			lines.push(
				`- ${window.label}：剩余 ${String(window.percentRemaining)}%，已用 ${String(window.percentUsed)}%`
				+ (reset === undefined ? '' : `，重置于 ${reset}`),
			)
		}
	} else {
		lines.push('- 该 API Key 的账户没有 ClinePass 订阅（没有可用的配额窗口）。')
	}
	if (value.creditsUsd !== undefined) lines.push(`按量付费余额：$${formatUsd(value.creditsUsd)}`)
	if (value.keySource !== undefined) lines.push(`Key 来源：${value.keySource}`)
	if (value.notes !== undefined && value.notes.length > 0) lines.push(`注意：${value.notes}`)
	return lines.join('\n')
}
