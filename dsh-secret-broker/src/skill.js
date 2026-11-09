/**
 * The `secret-broker` skill: the long-form playbook.
 *
 * The prompt section states the convention and the current key list; it cannot
 * carry the worked examples, the failure table, or the reasoning behind the
 * filters without bloating every request. That is what a skill is for — and it
 * is registered into the registry's global layer rather than left on disk so it
 * reaches every session whatever preset it runs.
 *
 * @module dsh-secret-broker/skill
 */

/** Catalog description, capped by `dsh-tool-skill` before it reaches the model. */
const DESCRIPTION = [
	'用用户录入的敏感数据（API token、密码、连接串）执行命令，而自己永远看不到值。',
	'值以环境变量形式只在该变量名出现在命令文本中时注入子进程，工具结果里出现的值会被替换为 «redacted:KEY»。',
	'需要某个键时先查清单，缺了就让用户在 设置 → 密钥 里录入。',
].join('')

/** The full playbook, returned when the model loads the skill. */
const CONTENT = `# 密钥代理（secret-broker）

## 0. 先决事实（不要重新调研）

- 本机装有一个原生工具 **\`secret_list\`**：列出当前会话可用的键、环境变量名、作用域与描述。
  它的输出**永远不含值**。
- 值由主机在**命令执行的那一刻**注入子进程环境变量。你在会话里只会看到键名。
- 结果里一旦出现某个已知的值，主机在写进会话日志之前就会把它替换成 \`«redacted:KEY»\`。
  看到这个标记说明那条命令在输出密钥 —— 换一种用法，不要绕过。
- 用户界面在 **设置 → 密钥**（DSH 桌面 GUI 左下角设置）。你无法从会话里创建或读取值。

## 1. 何时用

用：需要 token 才能访问的 API、私有仓库、数据库连接串、需要密码的 CLI、
任何「用户手上有凭据、但你不该看到凭据」的自动化。

不用：用户直接在对话里贴出来的明文（那不是密钥代理的职责）；本来就不敏感的配置。

## 2. 注入规则（必须遵守）

环境变量名 = \`DSH_SECRET_\` + 键名大写、非字母数字替换为 \`_\`。
例：键 \`gh-token\` → \`DSH_SECRET_GH_TOKEN\`；键 \`DB_PASS\` → \`DSH_SECRET_DB_PASS\`。

**只有命令文本里出现该变量名时，那一个变量才会被注入。** 这是刻意的：

| 命令 | 结果 |
|---|---|
| \`curl -H "Authorization: Bearer $env:DSH_SECRET_API_TOKEN" …\` | 注入 \`API_TOKEN\` |
| \`Get-ChildItem env:\` | **什么都不注入**（也什么都不该看到） |
| \`npm run deploy\` | 不注入（除非命令里点名或加标记） |
| \`pwsh -File .\\deploy.ps1\` | 不注入 —— 用下面的标记 |

脚本场景用标记注释解锁（可以写在命令的任意一行）：

\`\`\`powershell
# secret-broker: DB_PASS, API_TOKEN
pwsh -File .\\migrate.ps1
\`\`\`

\`# secret-broker: all\` 表示注入当前会话全部可用键（能不用就不用）。

## 3. 常见用法

\`\`\`powershell
# 私有仓库（token 不进 URL 的日志里就换成 credential helper，但这条最快）
git clone https://x-access-token:$env:DSH_SECRET_GH_TOKEN@github.com/owner/repo.git

# 带 Bearer 的 REST 调用
curl -sS -H "Authorization: Bearer $env:DSH_SECRET_API_TOKEN" https://api.example.com/v1/items

# npm 私有 registry
npm config set //registry.npmjs.org/:_authToken=$env:DSH_SECRET_NPM_TOKEN

# docker 登录（避免密码进 argv）
$env:DSH_SECRET_REGISTRY_PASS | docker login registry.example.com -u ci --password-stdin

# 连接串拼接
$env:PGPASSWORD = $env:DSH_SECRET_DB_PASS
psql -h db.internal -U app -d appdb -c 'select 1'
\`\`\`

要点：**不要把值放进 argv 里会被别处记录的位置**（进程列表、构建日志、URL 查询串）。
能走 stdin 或环境变量的就走它们。

## 4. 作用域

- **全局**：所有会话都能用。适合长期 token。
- **会话级**：只有录入时选中的那个会话能用，同名时覆盖全局。适合临时凭据、某个项目的专用 key。
- 子代理（subagent）有自己的会话 id，**不会**继承父会话的会话级密钥；全局密钥它可以用。
- 查看当前生效集合：调用 \`secret_list\`。

## 5. 缺键怎么办

不要在会话里让用户把值贴出来，也不要猜。正确做法：

> 需要 \`GITHUB_TOKEN\`（用于私有仓库只读拉取）。请在 **设置 → 密钥** 里新增：键 \`GITHUB_TOKEN\`，
> 作用域选「全局」（或当前会话），值粘贴 token。加完告诉我，我继续。

用户加完后再调一次 \`secret_list\` 确认，然后继续。

## 6. 红线

- 不 echo / 不 \`Write-Output $env:...\` / 不重定向到文件 / 不写进工作区 / 不提交 / 不放进给用户的回复。
- 不用 \`Get-ChildItem env:\` 之类的方式枚举环境变量。
- 不把值写进脚本文件、配置文件、.env 文件 —— 那等于把值落到磁盘上，绕过了整套设计。
- 看到 \`«redacted:KEY»\` 就停下来换用法，不要去构造能绕过脱敏的输出形式。

## 7. 排错

| 症状 | 原因 | 处置 |
|---|---|---|
| \`$env:DSH_SECRET_X\` 是空 | 命令里没出现该变量名（或键名拼错） | 直接用 \`$env:DSH_SECRET_X\` 写进命令；先 \`secret_list\` 核对变量名 |
| 脚本里取不到值 | 命令没点名，标记也没加 | 加 \`# secret-broker: X\` |
| 输出变成 \`«redacted:X»\` | 命令把值打印出来了 | 改成不输出值（例如只打印长度、或直接用于请求） |
| \`secret_list\` 少了某个键 | 键是会话级且属于别的会话，或还没录入 | 换作用域录入，或让用户在当前会话下录入 |
| 存储只读 / 报解密失败 | DPAPI 解不开（换了 Windows 账户或机器） | 让用户在同一账户下运行；数据目录里的 \`secrets.dpapi\` 需人工恢复 |
| 写入报「正被另一个进程写入」 | 另一个 DSH 进程正在写 | 稍后重试 |
`

/** The runtime skill registration handed to `ctx.skills.register`. */
export const SECRET_BROKER_SKILL = {
	name: 'secret-broker',
	description: DESCRIPTION,
	whenToUse: [
		'需要用用户录入的 token / 密码 / 连接串执行命令或调用 API 时；',
		'需要确认某个键是否存在、环境变量名叫什么时；',
		'用户说「用我的密钥」「我有 token」但没有把值贴出来时。',
	].join(''),
	/** Non-empty so the registry accepts the definition; the real provenance is the provider label. */
	source: 'dsh-secret-broker',
	content: CONTENT,
}
