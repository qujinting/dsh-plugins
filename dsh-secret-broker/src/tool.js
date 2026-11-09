/**
 * The model-facing discovery tool.
 *
 * The prompt section already names the keys, so why a tool at all? Because the
 * prompt is assembled once per step from a cached prefix and the model may be
 * looking at a list that predates a key the user just added — and because
 * "which keys can I use, and what is each one for?" is a question worth being
 * able to re-ask mid-turn. It is also the one place the model can learn that a
 * key it wants does *not* exist, which is the prompt to ask the user for it.
 *
 * The output schema has no value field. That is not a policy the implementation
 * follows — it is the shape of the type, so no future edit can accidentally
 * widen it into a leak.
 *
 * @module dsh-secret-broker/tool
 */

import { scopeLabel } from './store.js'

/** Cap on how many keys one call renders, so the tool result stays readable. */
const MAX_RENDERED = 100

/**
 * Build the tool definition.
 *
 * @param options - resolved plugin options.
 * @param options.toolName - the registered tool name.
 * @param options.keyPrefix - the environment variable prefix.
 * @param options.store - the secret store.
 * @returns the definition accepted by `ctx.tools.register`.
 */
export function secretListTool(options) {
	return {
		name: options.toolName,
		description: [
			'列出当前会话可用的敏感数据键（secret-broker）。',
			'返回**用户设置的键名**、它派生的环境变量名、作用域与描述；**永远不返回值本身**。',
			'跟用户交流时用键名（如 `gh-token`），写命令时用变量名（`$env:DSH_SECRET_GH_TOKEN`）——两者是同一个东西的两个名字，别把派生名当成新 key 介绍给用户。',
			'键分全局 / 工程 / 会话三级，越具体越优先（会话 > 工程 > 全局），同名键被更具体的覆盖。',
			'在 shell 工具里用 `$env:<环境变量名>` 引用，主机只在该变量名出现在命令文本中时才注入它的值。',
			'让按路径调用的脚本拿到值时，在命令里加 `# secret-broker: KEY` 标记。',
			'需要某个键但列表里没有时，请让用户在 设置 → 密钥 中录入，不要自己创建或猜测值。',
		].join(''),
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					sessionId: { type: 'string' },
					keys: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								key: { type: 'string' },
								env: { type: 'string' },
								scope: { type: 'string' },
								description: { type: 'string' },
								updatedAt: { type: 'string' },
							},
							required: ['key', 'env', 'scope', 'description', 'updatedAt'],
						},
					},
					notes: { type: 'string' },
				},
				required: ['keys'],
			},
			render: (_args, value) => [{ type: 'text', text: renderResult(value, options) }],
		},
		isConcurrencySafe: () => true,
		async execute(_args, exec) {
			await options.store.ready
			const header = exec?.agent?.session?.header
			const sessionId = header?.id
			const entries = options.store.effective(sessionId, header?.cwd)
			const notes = []
			if (options.store.locked) notes.push('密钥存储当前为只读：加密文件无法解密。')
			if (!options.store.writable && !options.store.locked) notes.push('密钥存储当前不可写，请检查数据目录。')
			return {
				...(typeof sessionId === 'string' ? { sessionId } : {}),
				keys: entries.slice(0, MAX_RENDERED).map((entry) => ({
					key: entry.key,
					env: entry.env,
					scope: entry.scope,
					description: entry.description,
					updatedAt: entry.updatedAt,
				})),
				...(notes.length > 0 ? { notes: notes.join(' ') } : {}),
			}
		},
	}
}

/**
 * Render the tool result for the model.
 * @param value - the validated tool value.
 * @param options - resolved plugin options.
 * @returns the text block body.
 */
function renderResult(value, options) {
	const lines = []
	if (value.keys.length === 0) {
		lines.push('当前没有可用密钥。需要时请让用户在 设置 → 密钥 中录入（可选全局 / 工程 / 会话）。')
	} else {
		lines.push(`当前可用密钥 ${String(value.keys.length)} 个（值不会被返回）。左边是用户设置的名字，右边是它在命令里的变量名：`)
		for (const entry of value.keys) {
			const detail = entry.description.trim()
			lines.push(`- 键 ${entry.key} → 变量 ${entry.env}（${scopeLabel(entry.scope)}）${detail.length > 0 ? ` — ${detail}` : ''}`)
		}
		lines.push('')
		lines.push(`用法：在 shell 命令里写 \`$env:${options.keyPrefix}...\`；变量名必须出现在命令文本中才会注入。脚本场景加 \`# secret-broker: KEY\` 标记。`)
	}
	if (value.notes !== undefined && value.notes.length > 0) lines.push(`注意：${value.notes}`)
	return lines.join('\n')
}
