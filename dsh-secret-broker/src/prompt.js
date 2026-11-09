/**
 * What every session is told about the broker.
 *
 * A tool sits in the request catalog of every step, but a tool alone only
 * answers "what is here?" — it does not tell the model that a value it needs
 * might already exist, or how to use one without ever seeing it. That is what
 * this section is for, and it has to reach *every* session regardless of agent
 * preset, which is why it is registered in the global prompt layer by the host
 * half rather than written into a user's memory file.
 *
 * Two pieces:
 *
 * - a static half stating the convention (`$env:DSH_SECRET_<KEY>`), the two
 *   filters that decide what a shell call receives, the marker that unlocks a
 *   script, and the rules that keep a value out of a transcript;
 * - a dynamic half naming the keys that exist right now, so a fresh session
 *   knows it can use one before it has called any tool.
 *
 * The dynamic half is a prompt *variable* rather than baked-in text because it
 * changes while the host is running. The trade is one KV-cache invalidation per
 * key-set change — rare, and cheaper than a model that does not know the key
 * exists.
 *
 * @module dsh-secret-broker/prompt
 */

import { scopeLabel } from './store.js'

/** Stable section name; the global layer rejects a duplicate. */
export const PROMPT_SECTION_NAME = 'secret-broker:routing'

/**
 * Placement: beside the other tool-owned sections (`chrome-cdp` sits at 2250),
 * well before the environment-bearing suffix at 10000.
 */
export const PROMPT_SECTION_ORDER = 2260

/** Variable name for the live key list. Prompt variables allow `[a-z0-9_]` only. */
export const KEYS_VARIABLE = 'secret_broker_keys'

/**
 * Strip sequences the prompt renderer treats as syntax.
 *
 * A user's description lands in the prompt verbatim. Braces cannot re-trigger
 * interpolation (the renderer never rescans an inserted value), but a stray
 * `{{` in a rendered prompt is still a trap for anything downstream that does.
 *
 * @param text - the raw text.
 * @returns the text with brace pairs removed.
 */
function plain(text) {
	return String(text).replace(/\{\{|\}\}/g, '')
}

/**
 * Build the static section body.
 *
 * @param options - resolved plugin options.
 * @param options.toolName - the registered discovery tool name.
 * @param options.keyPrefix - the environment variable prefix.
 * @returns the prompt section text.
 */
export function promptSectionText(options) {
	return [
		'## 敏感数据：只给键名，不给值',
		'',
		`本机装有一个密钥代理（secret-broker）。用户在界面上以「键 → 值」录入敏感数据，值只在**命令真正执行的那一刻**由主机注入子进程环境变量；你只会看到键名，永远看不到值。`,
		'',
		`环境变量名规则：\`${options.keyPrefix}<键名大写，非字母数字转 _>\`。例如键 \`gh-token\` 对应 \`${options.keyPrefix}GH_TOKEN\`。`,
		'',
		`**跟用户交流时用键名**（如 \`gh-token\`），**写命令时用变量名**（\`$env:${options.keyPrefix}GH_TOKEN\`）。键名是用户起的，变量名是它派生出来的——别把派生名当成新东西介绍给用户。`,
		'',
		'用法（shell 工具里）：',
		'',
		'```powershell',
		`git clone https://x-access-token:$env:${options.keyPrefix}GH_TOKEN@github.com/owner/repo.git`,
		`curl -H "Authorization: Bearer $env:${options.keyPrefix}API_TOKEN" https://api.example.com/v1/items`,
		'```',
		'',
		'注入规则（**必须遵守，否则取不到值**）：',
		'',
		`- 只有命令文本里出现该变量名时才会注入。所以 \`Get-ChildItem env:\` 什么也拿不到，这是设计如此。`,
		`- 键分**全局 / 工程 / 会话**三级：全局对所有会话生效；工程按会话的工作目录匹配（子目录也算，最深的优先）；会话级只对那一个会话生效。越具体越优先，同名时覆盖。`,
		`- 要让一个按路径调用的脚本拿到值，在命令里加一行标记注释：\`# secret-broker: KEY1, KEY2\`（\`# secret-broker: all\` 表示全部）。`,
		'',
		'红线：',
		'',
		'- 不要把值打印、回显、重定向进文件、写进工作区、提交进 git、或放进给用户的回复里。',
		'- 不要用 `Write-Output $env:...`、`echo $env:...` 之类的方式查看值；要确认它存在就打印长度或做一次真实调用。',
		'- 结果里一旦出现已知的值，会被主机替换成 `«redacted:KEY»`；看到它就说明那条命令试图输出密钥，换一种用法。',
		'- 需要新密钥时，请让用户在 **设置 → 密钥** 里录入，不要试图自己创建或猜测。',
		'',
		'当前可用的键（含可用环境变量名）：',
		'',
		`{{${KEYS_VARIABLE}}}`,
		'',
		`需要完整键名与描述时调用 \`${options.toolName}\` 工具；它的输出里永远没有值。`,
	].join('\n')
}

/**
 * Render the live key list.
 *
 * Must always return a non-empty string: a registered variable with no value
 * makes prompt assembly throw, which would take down every request in the
 * session.
 *
 * @param store - the secret store.
 * @param sessionId - the viewing session, when there is one.
 * @param cwd - that session's working directory, when it has one.
 * @returns one line per effective key, or a placeholder.
 */
export function renderKeyList(store, sessionId, cwd) {
	const entries = store.effective(sessionId, cwd)
	if (entries.length === 0) return '（尚未录入任何密钥）'
	return entries
		.map((entry) => {
			const detail = plain(entry.description).trim()
			// The user's own name leads: it is the word they will use, and the model
			// has to map it to the variable it writes. The variable is right there as
			// the operational half of the same line.
			return `- 键 \`${plain(entry.key)}\` → 变量 \`${plain(entry.env)}\`（${scopeLabel(entry.scope)}）${detail.length > 0 ? ` — ${detail}` : ''}`
		})
		.join('\n')
}
