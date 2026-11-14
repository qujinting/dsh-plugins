# dsh-web-search

[English](README.md) | 简体中文

> **DSH 插件（DSH plugin）** ｜ DeepSeek Harness `ctx.web` 搜索供应商，替换内置的 `web-search-deepseek`。
>
> ![DSH plugin](https://img.shields.io/badge/DSH-plugin-4b5563)
> ![license](https://img.shields.io/badge/license-MIT-blue)
> ![node](https://img.shields.io/badge/node-%E2%89%A522-3c873a)

一个 DSH（DeepSeek Harness）插件：**用你当前选中的模型来联网搜索**，替代内置的 `web-search-deepseek`。

内置搜索供应商（`@deepseek-ai/dsh-web-search-deepseek`）把模型写死成 `deepseek-v4-flash`，
并且只认 DeepSeek 官方的 Anthropic 兼容端点（`https://api.deepseek.com/anthropic/v1`）——
所以它只花 DeepSeek 官方的额度，也不跟随你在 UI 里选的模型。

本插件注册一个 id 为 `clinepass` 的搜索供应商，它：

1. 从**当前会话的请求头**读出这一步实际使用的 `provider` / `model`；
2. 从 `llm-pi-ai` 设置里取出这条路由的 `baseURL` / `apiKeyEnv`（也就是 Web「模型」页面写入的那份配置）；
3. 发一次 OpenAI 兼容的 `POST {baseURL}/chat/completions`，在 `tools` 里带上网关的**供应商端执行搜索工具**（`vercel:perplexity_search` 等）；
4. 把模型回答末尾的 `Sources:` 段落解析成 `ctx.web` 需要的来源列表。

搜索跑在你的 ClinePass（或任何 OpenAI 兼容网关）额度上，不碰 DeepSeek 官方 key，也不额外消耗主对话的上下文。

> **0.3.3**：只支持 dsh 0.2.x（`engines.dsh = >=0.2.0-rc.2 <0.3.0`，实测 0.2.2-rc.1），0.1.x 兼容分支已删除；
> 补上 web seam 在 0.2.2 新增的可选 `ready()`；`web.searchProvider` 被别人改走时不再静默（见《限制与注意事项》）。

## 为什么必须改配置而不只是装插件

`ctx.web` 的供应商选择是「显式 id 优先」：`@deepseek-ai/dsh-base` 把 `web` 那一行写死为
`searchProvider: deepseek-official`，所以仅仅注册一个新供应商是不会被选中的。
本插件打包成一个 bundle（`dsh.bundle.patch`），它的 `cordis.patch.yml` 同时做两件事：

```yaml
- id: web
  config:
    searchProvider: clinepass
    fetchProvider: http          # patch 会整体替换 config，所以这行必须重述

- insert:
    - id: dsh-web-search
      name: 'dsh-web-search'
      config: {}
```

内置的 `web-search-deepseek` 仍然挂着（不再是选中项），需要时可以随时切回去。

## 安装

本插件只支持 **dsh 0.2.x**：`package.json` 的 `engines.dsh` 是 `>=0.2.0-rc.2 <0.3.0`（预发布版也参与匹配），
实测在 **0.2.2-rc.1** 上跑通。0.1.x 的兼容分支已在 0.3.3 移除。启动器会用这个范围在安装与激活时校验，
不满足就直接拒绝，不会装上一个跑不起来的插件。

### 用内置插件管理器（推荐）

```powershell
# 从 npm
dsh plugin --profile desktop add dsh-web-search

# 或从本地 checkout
dsh plugin --profile desktop add file:D:/project/qujinting/dsh-plugins/dsh-web-search
```

- **0.2.0-rc.2 起 `dsh` 命令随桌面版打包**，不再要求你另装 Node / pnpm；第一次用先点菜单栏的
  **「Manage dsh command」** 把它装进 PATH，之后上面两条命令照常用（`--profile` 换成要装的 profile，桌面版是 `desktop`）。
- 插件管理器会跑 pnpm：把包装进 `<DSH_HOME>/profiles/desktop/node_modules`，并把 `dsh-web-search`
  追加进该 profile 的 `dsh.profile.bundles`（它自己会先备份 `package.json.bak-install-<时间戳>`）。
- **重启 dsh 后生效**（bundle 清单在启动时组装）。
- 装完的配置页在 **左侧「插件」→ 已安装 → `dsh-web-search` → 组件行 `dsh-web-search` 的「配置」**。
- 注意：`dsh plugin add file:` 是把代码**装进 pnpm store（硬链接）**，不是目录联接。改完本仓库代码要再跑一次
  add 命令才生效（开发时用下面那条 junction 路线更省事）。

### 开发：目录联接（改代码即生效）

```powershell
# 1) 把本目录联进 profile，并把 dsh-web-search 写进 bundles（会备份 package.json）
node install.mjs --profile desktop

# 2) 给本目录建依赖闭包：一条 junction 指向已安装 DSH 的 node_modules
node tools/link-dependency-root.mjs
```

这些裸导入（`@deepseek-ai/dsh-web`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-credentials`、
`@deepseek-ai/dsh-launch-environment`）由 harness 提供的**前提是本包在 `peerDependencies` 里声明了它们**：对 out-of-tree 的联接
包，dsh 只有在“本目录到盘根之间某个 `package.json` 把它列为 peer”时，才把这个名字映射到 harness 安装目录里那份；否则退回
Node 原生查找，向上找到本目录的 `node_modules` 却没有就报
`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'`。四个包在 `peerDependenciesMeta` 里都是 `optional`，
所以 pnpm 一个都不装，运行时用的始终是 harness 那份（不会出现两份实例）。

第 2 步因此是**开发**需要（纯 Node 工具与测试从本目录解析），不是加载器需要。`link-dependency-root.mjs` 建一条指向已安装 DSH
的 junction，要求那份安装是**解包**的（`resources/app/dsh/node_modules` 之类）；发行版桌面端是打包的 `resources/app.asar`，
此时该工具会直接报出打包载荷，并让你改用它的抽取兄弟：

```powershell
node tools/link-harness-runtime.mjs    # 从 resources/app.asar 抽出闭包到 node_modules/
```

### 卸载

```powershell
dsh plugin --profile desktop remove dsh-web-search    # 插件管理器路线
node install.mjs --profile desktop --uninstall        # junction 路线
```

两者都会移除包与 bundles 条目（并备份 `package.json`）。重启后 `web.searchProvider` 回到 `deepseek-official`，
内置行为完全恢复——插件不改动任何原生文件。

### 设置模型：0.2.x 只有一套

- **host 半边**：插件的 Config 条目**就是**它的设置项。`src/index.js` 调
  `settings.configure({ auto: false }, ctx.fiber)`，意思是「本插件自己画卡片，别用 schema 自动生成一页」。
- **可编辑字段**：`src/config.js` 里标 `.volatile()` 的 8 个字段（`enabled` / `provider` / `model` / `tool` /
  `timeoutMs` / `maxTokens` / `maxSources` / `instructions`）；写入落在 profile 的 `cordis.patch.yml`。
- **读值**：volatile 字段解析成稳定引用，`.get()` 取当前值，`normalizeConfig()` 在每个边界统一摊平——所以设置一改
  下次搜索就生效，不用重启。
- **读别人的命名空间**（`llm-pi-ai` 解路由、`agent-default-model` 兜底模型）：只能走 `settings.describe()` 的
  `{ ns, value }` 投影。注意 `describe()` 只投影**至少有一个 volatile 字段**的条目——这两个都有；某天谁丢了
  volatile，插件会表现为「路由解不出 → 供应商不可用」，而不是静默用错值。
- **卡片**：浏览器半边往 `plugins.row.config` 注册，key 是 `<包名>#<行 id>`（即 `dsh-web-search#dsh-web-search`，
  和插件页 `rowConfigKey()` 的拼法一致）；页面把 `{ view, form }` 当 prop 传进来，`form` 提供 `state` 与
  `mutate(ops, revision)`，返回 `false` 表示 revision 冲突。

### 0.3.1 修过的那个坑，与 0.3.3 的清理

0.3.0 只把**自己这一条 Config** 迁到「Config 即设置项」的模型，**读别人的命名空间**那条路忘了迁：
`readSettings()` 仍在调 `settings.get(ns)`，而 0.2.x 的 `@deepseek-ai/dsh-settings` 里没有 `get`
（`installSection` 也没有），异常被 `try/catch` 吞掉后一律返回 `undefined`。后果是 `llm-pi-ai` 永远读不到，
`resolveTarget()` 拿不到 `baseURL` / `apiKeyEnv`，`available()` 恒为 `false`：

```
Error: configured web provider "clinepass" is registered but unavailable
    (WEB_PROVIDER_CONFIGURED_UNAVAILABLE)
```

0.3.1 给 `readSettings()` 补上了 `describe()` 读法；**0.3.3 起只保留这一条读法**，`get()` 分支已删除——
它在本机之所以“看起来能用”，是因为本地装了把 legacy settings API 补回去的补丁（`dsh-purge`）；干净安装上没有 `get`，
plugin 依赖它就是依赖自己的兜底路径。现在两条路径合一，干净安装与打了补丁的安装行为一致。

**升级后仍然报这个错、又不能马上重装插件时**，可以先在 profile 的 `cordis.patch.yml` 里把路由钉死
（`provider` / `model` 是 volatile 字段，写在 patch 里同样生效；`baseURL` / `apiKeyEnv` 是普通字段，
所以它们本来就只能从 patch 配，卡片里没有这两栏）：

```yaml
- id: dsh-web-search
  config:
    provider: clinepass
    model: cline-pass/deepseek-v4.1-flash
    baseURL: https://api.cline.bot/api/v1
    api: openai-completions
    apiKeyEnv: CLINEPASS_API_KEY
```

代价是这条搜索不再跟随 UI 里选的模型；把插件升级后删掉这段即可恢复跟随。

## 配置

设置命名空间：`dsh-web-search`（会出现在 Web 的「设置 → 插件配置」里，可热改）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后本供应商报告为不可用。 |
| `tool` | `vercel:perplexity_search` | 发给网关的供应商端搜索工具 id（4 选 1）。按每次检索计费；提示词里的搜索次数上限只是**建议**，本格式没有硬上限，模型可能检索更多次。 |
| `provider` / `model` | 空（跟随会话） | 钉死路由与模型，不再跟随 UI 选择。 |
| `baseURL` / `api` / `apiKeyEnv` / `apiKey` | 空 | 钉死端点与凭据。 |
| `headers` | 空 | 额外请求头，合并优先级：`llm-pi-ai` < `routes[provider]` < 本节。 |
| `routes` | `{}` | 按 LLM 路由 id 覆写 `api` / `baseURL` / `apiKeyEnv` / `apiKey` / `headers` / `tool`。 |
| `fallback.provider` / `fallback.model` | 空 | 会话模型不可用时的兜底路由（同样走 `routes` / `llm-pi-ai` 解析）。 |
| `timeoutMs` | `90000` | 单次搜索超时；一次搜索就是一次完整的模型回合。注意 `dsh-tool-web` 自己的 `searchTimeoutMs`（base 里是 60000）才是模型侧的实际外框——实测最慢一次 30.7s。 |
| `maxTokens` | `8192` | 搜索回合的输出上限。实测一次问答的 `completion_tokens` 是 **3535 / 4176**（含推理 token），4096 已经顶到天花板；一旦 `finish_reason` 变成 `length`，被截掉的往往正是末尾的 `Sources:` 段。8192 = 实测的 2 倍余量，既不会截断，也仍然有限（回答会变成调用方 agent 的上下文，之后每轮都要按输入 token 重付）。 |
| `temperature` | 未设置 | 不写就不发这个字段（部分推理模型会拒绝它）。 |
| `maxSources` | `10` | 返回给 seam 的来源上限；`dsh-tool-web` 的 `searchMaxResults` 还会再截一次。 |
| `instructions` | 空 | 追加到 **user 消息**末尾的额外要求（**不是** system prompt——见下）。 |

> 这里**没有**「把搜索记录写进会话日志」的开关：DSH 会因此拒绝加载整份会话，原因见《为什么不再写会话日志事件》。

绝大多数情况什么都不用配：会话模型是 `clinepass` 这类 OpenAI 兼容网关时，路由信息全部来自
`llm-pi-ai.providers.<route>`（`api` / `baseURL` / `apiKeyEnv`），通过 `settings.describe()` 的
`{ ns, value }` 投影读（见《0.3.1 修过的那个坑，与 0.3.3 的清理》）。

## 工具选择与花费

AI Gateway 的 **Chat Completions** API（也就是本插件走的这条）文档里只列了 4 个服务端搜索工具，
本插件也只提供这 4 个；改 `tool` 即可切换：

| 工具 | 搜索后端 | 必填 config | 单价（网关侧） | 适合 |
|---|---|---|---|---|
| `vercel:perplexity_search` | Perplexity Search API | `query` | **$5 / 1000 次** | 通用首选：自带引用、支持时效/地区/语言/域名过滤、`maxResults` 1–20 |
| `vercel:parallel_search` | Parallel AI Search | `objective` | **$5 / 1000 次**（含 10 条，超出 $1/1000） | 研究型问题：LLM 优化的摘录，`mode` 可选 `one-shot` / `agentic` |
| `vercel:exa_search` | Exa | `query` | **$7 / 1000 次**（≤10 条） | 要按域名 / 日期 / 类型（`news`、`research paper`…）筛选，或要更省 token 的摘录 |
| `vercel:tako_search` | Tako | `query` | **$7 / 1000 次**（instant/fast）、**$12 / 1000 次**（deep） | 只有需要它的实时知识图谱（金融 / 体育 / 天气 / 宏观 / 政治）时才值 |

**为什么不提供 `browserbase_search` / `browserbase_fetch`**：Vercel 只为 AI SDK 表面提供
`gateway.tools.browserbaseSearch()`，Chat Completions 的 server-tool 表里没有这两个 id。实测 ClinePass 端点**接受**
`vercel:browserbase_search`（HTTP 200），但一次请求里模型自己搜了 **34 次**、烧掉 17.6 万 prompt token、计费
**$0.2645**，最后只给出 1314 字符、**0 条引用**的回答（内容基本是"我再搜一下"）。因此从选项里去掉。

### 计费是按「调用次数」，不是按请求

一次 `web_search` 里模型可以自己决定搜几次，网关在 `message.provider_metadata.gateway.gatewayToolCalls` 里
报告次数。同一类问题实测（`gatewayCost`，**每次 `web_search`**）：

| 工具 | 搜索次数 | 来源 | `gatewayCost` |
|---|---|---|---|
| `vercel:perplexity_search` | 6 → **4** | 17 → 10 | $0.0430 → **$0.0298** |
| `vercel:parallel_search` | 4 → **2** | 17 → 10 | $0.0361 → **$0.0202** |
| `vercel:browserbase_search`（已移除） | 34 | 0 | $0.2645 |

右列是加上 system prompt 里的「最多 3 次搜索」之后的实测值；`$5/1000` 是按**每次检索**收的，
所以 6 次检索光工具费就 $0.03——**搜索次数才是成本主因**，比输出长度重要得多。
指令是建议性的：实测仍有 4 次的情况（不是硬上限；Chat Completions 格式没有"最多用几次"的字段）。

另外：`dsh-tool-web` 会把 `queries` 数组里的每个 query **并发**各跑一次搜索，
所以一次 `web_search({queries:[q1,q2,q3,q4]})` 就是 4 次模型回合。想省钱就用单条 query。

### 每次搜索都把 query 交给网关当默认值

`tools[]` 这一项不是裸 id，而是带上本次搜索的输入（`gateway.js` 的 `toolEntry()`）：

```json
{ "type": "vercel:perplexity_search", "config": { "query": "…", "max_results": 10 } }
```

perplexity / exa / tako 用 `query`，parallel 用 `objective`（各自 schema 的必填字段），
结果条数用 `max_results`（exa 是 `num_results`）。文档说 config 是"开发者默认值、会覆盖模型生成的值"，
这样检索锚定在 harness 真正收到的那条 query 上，而不是让模型自己改写。**未知的 tool id 仍然只发裸 id**——
给不认识的 schema 编 config 只会让请求开始报错。

## 工作原理（细节）

```
agent 调 web_search(queries)
        │  dsh-tool-web 逐条 query 并发调用 ctx.web.search()
        ▼
ctx.web  (searchProvider = clinepass)
        ▼
CurrentModelSearchProvider.search()
   ├─ 选模型   agent.session.requestHeader().config  →  agent.options  →  settings['agent-default-model']
   ├─ 解路由   settings['llm-pi-ai'].providers[provider]  +  本插件 routes/显式钉死
   ├─ 取凭据   ctx.credentials.resolve(apiKeyEnv)  →  launchEnvironment
   ├─ 发请求   POST {baseURL}/chat/completions
   │            tools:[{type:'vercel:perplexity_search', config:{query, max_results}}]
   │            （供应商端执行：网关自己跑检索，模型侧仍然只有一轮 assistant 输出）
   └─ 解析     message.content 末尾的 Sources: 段落 → markdown 链接 + 裸 URL → 去重、取标题、截断
```

### 来源是怎么拿到的

网关只在 `usage.gateway_cost` / `message.provider_metadata.gateway.gatewayToolCalls` 里报告检索次数，
**不返回结构化的 citation 块**——真实 URL 就在回答正文里。所以搜索指令要求模型以固定形状收尾：

```
Sources:
- [页面标题](https://完整.url)
```

解析器优先从这个段落取链接（markdown 标签当标题），取不到才回退到全文扫描；
并把该段落从正文里剥掉，避免同一批 URL 在工具结果里出现两遍。

### 诚实性标记

- `gatewayToolCalls` 存在且为 0：正文追加「网关未实际执行搜索，请视为未经验证」；
- `finish_reason === 'length'`：正文追加「已触及输出上限，回答与来源列表可能不完整」。

## 已验证到哪一步

- **单元测试** `npm test`：**59 项，全绿、0 skipped**。解析 7 项（中文标点、markdown 链接、裸 URL、去重、截断、标题、
  非法 scheme）；路由 15 项（会话跟随、切换模型、`describe()` 唯一读法、`agent-default-model` 兜底、协议不兼容、
  显式钉死、按路由覆盖、fallback、可用性判定、坏 URL、没有 settings 服务时不崩）；搜索路径与修复工具 15 项
  （搜索不写会话事件、不可用路由不碰会话、schema 不再暴露写入开关、`tools[].config`、四个工具各自的字段映射、
  未知 tool id 只发裸 id、system prompt 的次数上限、未支持事件识别、信封标记、帧结构保持、dry-run、
  活跃会话与 `session.lock` 保护、只扫描当前代际）；**host 半边 7 项**（`configure({auto:false})`、活引用、
  无 settings 服务时退回组合条目、`ready()` 与 `available()` 一致且不抛、选中的是别人时给出的诊断文案、
  挂载时与 `web` 条目变更时各报一次、`normalizeConfig` 摊平引用、volatile 字段就是卡片那 8 个）；
  **浏览器半边 13 项**（注册 `plugins.row.config` 且只等 `configForms`、写入计划器、默认值即清除覆盖、
  只提供文档里的四个工具、次数上限只是建议、样式表只读主题 token 且全部命名空间化、页面视图渲染 8 个字段、
  summary 视图不渲染表单、未服务/加载中/只读降级、布尔字段是「左标签 + 右开关」、工具是单选 radio 且无 `<select>`、
  被覆盖字段带 Tag 与「恢复默认」）。渲染类测试要 `react-dom`：放在 `.card-test-modules/` 下
  （`npm install --prefix .card-test-modules --no-save react@18 react-dom@18`，已在 `.gitignore` 里）就自动生效，
  缺了则优雅跳过；本机现在是 **59 通过 + 0 跳过**。
- **真实 dsh 0.2.2-rc.1 验收（0.3.3）**：桌面版内核 `@deepseek-ai/dsh-desktop-runtime 0.2.2-rc.1` 上：
  - host 半边：`include:dsh-web-search` 为 `enabled: true / fiberPhase: active`；`ctx.web.registerSearchProvider`、
    `WebRuntime.Config { searchProvider, fetchProvider }`（两个字段仍 volatile）、`settings.configure({auto:false}, fiber)`
    全部存在；`settings.describe()` 仍返回 `{ ns, value, user, writable }`，`llm-pi-ai` 的 `providers.clinepass`
    与 `agent-default-model` 都能从投影里读到。
  - **真发一次 `web_search`**：返回带真实来源的回答，说明「注册 → 会话模型跟随 → 从 `llm-pi-ai` 解端点与
    `apiKeyEnv` → 凭据解析 → 网关请求 → 解析来源」整条链在 0.2.2-rc.1 上通。此时 `deepseek-official` 也注册着
    （`include:web-search-deepseek` 同样 active），没有撞 `WEB_PROVIDER_AMBIGUOUS`，即 bundle 层的
    `searchProvider: clinepass` 覆盖生效。
  - client 半边：`Slots.listSubTree` 显示 `plugins.row.config` 里的 occupant `dsh-web-search#dsh-web-search`、
    `active: true`——说明 `window.__ModuleLoader__.load` 工厂执行、`require('react')` 从基座模块表解析成功；页面派发用的 key
    （`rowConfigKey(pkg.name, row.rowId)`) 与注册 key 完全相同。这条测量早于 0.3.5，0.3.5 已去掉
    `@deepseek-ai/dsh-client-ui-primitives` 的 require（见下面《卡片的外观来自宿主》）。
  - 0.2.2 的 web seam 新增了**可选**的 `ready(llmProvider)` / `web.searchReady()`，`dsh-tool-web` 用它决定
    这一步要不要把 `web_search` 交给模型；0.3.3 实现了它（见《限制与注意事项》）。
- **真实 0.2.x settings 实现（0.3.1 的回归验证，0.3.3 保留）**：不启动整个 harness，而是直接把**真实的**
  `SettingsForms.prototype.describe`（未打桩，只喂给它一个 `configEditor.configuration()` 的替身）跑在**真实的**
  `@deepseek-ai/dsh-llm-pi-ai` 的 Config schema 与本机 profile 的真实路由值上：`describe()` 输出
  `[{ ns: 'llm-pi-ai', value: { providers: { clinepass: { baseURL: 'https://api.cline.bot/api/v1' } } } }]`。
  喂给 0.3.0 的 `resolveTarget()` 时 `available() === false`（就是那条 `registered but unavailable`），
  修好后同一个 ctx `available() === true`、端点 `https://api.cline.bot/api/v1/chat/completions`、
  来源 `session request header`。
- **真实 GUI 验收（0.2.0-rc.2，与内置卡片逐项对齐）**：用本机 Chrome 走 CDP 直连正在运行的 `dsh web`（临时 profile +
  用本机 `client-connection/browser-session` 签名密钥铸的会话 cookie，密钥不出本机），把这张卡和内置「网页搜索」卡
  放在**同一页**逐项量：折叠态 header padding 14/16、gap 12、标题 15px/600、摘要 13px；展开态 body 的
  border-top / margin 16 / padding-bottom 8、字段 padding 12、label 13px/500、hint 12px、
  控件 530×36（radius 8 / border 1px / padding 12 / font 13）、footer 与保存按钮（font 13、padding 5/14、
  bg = label-primary、文字 = bg-layer-3）**逐项相同**；切到 `body[data-ds-dark-theme]` 后 token 一起变，
  控制台 **0 error、0 warning**。开关行与单选组的形态也对着内置 Subagent 卡量过：开关行
  `justify-content:space-between` / `align-items:flex-start` / `gap:16px`、开关贴右；单选组框
  radius 8 / padding 10 / gap 6 / max-height 280、行内 padding 6 / radius 6、原生 radio 13×13。
  **0.2.x 改掉的名字只有图标**（`IconChevronDownOutline14` → `Medium` / `Regular`），0.3.3 已经把用到它的那张
  0.1.x 卡片连同整条兼容分支一起删掉，所以不再需要回退链。
  **本轮（0.3.3）没有复测像素**：卡片改动只在 DOM 层面用真实 React 渲染断言（见上面的渲染测试），
  截图级复测要单独授权。
- **真实 seam 集成** `node test/live-gateway.mjs`：用真实的 `WebRuntime`（`@deepseek-ai/dsh-web`）注册本供应商，
  按 `searchProvider: clinepass` 选中，向 `api.cline.bot` 实发一次搜索，断言来源非空且 `maxResults` 生效。
- **真实网关实测（搜索次数与 tools[].config）**：走插件自己的 `searchWithGateway` 打真实网关，
  perplexity 与 parallel 各自 200 / `finish_reason: stop`、来源各 10 条、没有截断提示；
  `gatewayToolCalls` 分别为 4 与 2，`gatewayCost` 分别为 **$0.0298 / $0.0202**
  （加「最多 3 次搜索」之前的同一类问题是 6 / 4 次、$0.0430 / $0.0361）。
- **真实 DSH 端到端**：临时 profile（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` + 本插件）跑一次真实任务，
  带回真实来源链接。端到端跑通后**不再产生** `web/clinepass-search-request` 事件；早期版本写进会话日志的那些事件已用
  `tools/repair-session-events.mjs` 补上 `ignorable: true`（见《为什么不再写会话日志事件》），会话可以正常重新加载。

## 限制与注意事项

- **不写任何会话日志事件。** 早期版本每次搜索都会追加一条 `web/clinepass-search-request`（v0.1.0 里叫
  `web/current-model-search-request`），这会让会话在下次 resume 时被**整份**拒绝加载；该行为已删除，也没有重新打开的开关。
  已被写坏的会话用下一节的工具修复。
- **只对 OpenAI 兼容且支持供应商端工具的路由生效。** 路由声明了非 chat-completions 协议（例如 `anthropic-messages`）时，
  本供应商直接报告不可用——这是有意的：让网关工具 id 发给不懂它的端点只会得到难懂的错误。
- **切到非网关模型时 `web_search` 不再出现在工具列表里。** 0.3.3 实现了 web seam 的可选钩子
  `ready(llmProvider)`：`dsh-tool-web` 在每一步用 `ctx.web.searchReady()` 决定要不要把 `web_search` 交给模型，
  路由解不出（例如当前模型是非 chat-completions 协议）时工具直接不出现，而不是让模型调了再吃一个
  `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`。想在这种情况下仍有搜索能力，两种做法：在设置里配
  `fallback.provider` / `fallback.model` 钉一个网关路由兜底；或把 profile 的 `cordis.patch.yml` 里
  `web.searchProvider` 改回 `deepseek-official`。
- **`web.searchProvider` 被改走时插件会静默失效——0.3.3 起会打一条警告。** 供应商选择是「显式 id 优先」，
  而内置的「网页搜索」设置页（`@deepseek-ai/dsh-client-ui-settings-web-search`）的 Search API 开关写的就是
  `web.searchProvider`。一旦在那里切到 DeepSeek，profile 的设置覆盖会压过本插件的 bundle 层，
  搜索看起来照常成功、其实走的是内置供应商。插件在挂载时与每次 `settings/updated`（ns = `web`）时比对一次选中项，
  不指向 `clinepass` 就往 host 日志写一条带修法的警告（不会再静默）。
- **凭据只从 `ctx.credentials` 与启动环境读。** 密钥不会进日志、不会进会话记录（记录里只有路由、耗时、费用、检索次数）。
- **`web_fetch` 不受影响**，仍然走内置的 `http` 供应商。
- **供应商端工具是一次完整的模型回合**：延迟实测 8–15 秒，费用按上面那张表计。
- **四个 harness 导入靠 `peerDependencies` 声明才会解析。** dsh 0.2.2 只在本包 manifest 把它们列为 peer 时，才把 out-of-tree
  包的裸 `@deepseek-ai/*` 名字映射到安装目录；删掉这些声明，即使 harness 里就有这个包，插件加载期照样报
  `ERR_MODULE_NOT_FOUND`。版本对齐请改 `engines.dsh`，不要给 peer 写版本范围——运行时用的只有 harness 那一份。
- 开发用的 `node_modules` 保持**可选**：需要给纯 Node 工具与测试用时，跑 `node tools/link-dependency-root.mjs`（解包安装）或
  `node tools/link-harness-runtime.mjs`（打包 `resources/app.asar`）。后者会把 junction 换成真目录，之后想回到 junction 就重跑
  `link-dependency-root.mjs`；机器上还装着别的 Electron 包时记得显式传 `--asar`。
- 插件不修改任何原生包文件，卸载后原样恢复。

## 为什么不再写会话日志事件

早期版本每次搜索都会往会话日志追加一条 `web/clinepass-search-request`。**这个行为已经删除**，因为它会让会话彻底打不开：

- DSH 的会话读取是 fail-closed 的：`session-persistence` 的 `validateStoredEvents()` 遇到
  `KNOWN_SESSION_EVENT_TYPES` 之外、信封上没有 `ignorable: true` 的事件时，会拒绝解释**整份**日志，报
  `SessionFormatUnsupportedError`（「unknown to this harness and not marked ignorable; refusing to interpret the log」）；
- 白名单由 harness 仓库自己生成，外部插件声明的事件按构造就不在其中；
- 而 `Session.append()` 的第三个参数只接受 surface 元数据（`surfaceOp` / `sourceEventSeqs`），
  **插件没有任何途径**给自定义事件写上 `ignorable: true`——写的时候一声不响，下次 resume 才会发现会话已经打不开。

所以只要「会话必须能恢复」，插件唯一安全的选择就是**不写自定义事件**：本插件现在只读 seam，不落任何持久数据。
诊断信息（路由、耗时、`gatewayCost`）不再进会话日志；需要长期账单统计请在外层采集（例如网关后台）。

### 修复已经被写坏的会话

仓库带一个修复工具 `tools/repair-session-events.mjs`：它只处理**当前代际**的 `session.v3.jsonl.zstd`，
找出白名单之外且没有 `ignorable: true` 的事件，原样保留帧结构与其它每一行，只给这些信封补上 `ignorable: true`
（这正是「纯信息性记录」应有的标记）；写盘前先备份、写盘后再解码自检，自检失败自动用备份回滚。

```powershell
npm run repair-sessions          # 只扫描：列出会被拒绝加载的会话
npm run repair-sessions:apply    # 修复（不带 --apply 时是 dry-run，不写盘）
node tools/repair-session-events.mjs repair --session 80bad975-cea1-48af-b509-f2849e8841b0 --apply
```

- 默认扫描 `$DSH_HOME`（或 `~/.dsh`）下的全部会话；`--home <dir>` 换根目录，`--session <id>` 只处理一个会话。
- 工具不依赖开发用的那份 `node_modules` junction：它按 `$DSH_HOME/profiles/**/node_modules` 和 DSH 自身的安装目录
  去找 `@deepseek-ai/dsh-session`（白名单必须来自真正读日志的那个 harness），所以别人 clone 下来就能直接跑。
- 最近 5 分钟内被写过的会话、或目录里存在 `session.lock` 的会话会被跳过（可能还开着）：**先把 harness 停掉再跑**；
  确认无风险时用 `--force` 覆盖这两道保护。
- 备份写在原文件旁边：`session.v3.jsonl.zstd.bak-<时间戳>`（harness 不会读取这个文件名，可随时删除）。
- 历史代际（`session.jsonl.zstd`、`session.v2.jsonl.zstd` 等）不会被扫描——它们由 harness 自己的迁移链处理。

## 卡片（浏览器半边）

这个插件是**双面**的：host 半边注册供应商，浏览器半边贡献一张设置卡（0.2.x 只有这一张）。

- `lib/client.js` 往 `plugins.row.config` 注册，key 是 `dsh-web-search#dsh-web-search`
  （页面用 `rowConfigKey(pkg.name, row.rowId)` 拼同一个 key）。
- 页面（插件管理器）自己画标题、图标、面包屑、折叠与位置，并把该条目的 `form`（`state` + `mutate`）当 prop 传进来；
  列表里还会调用 `summary` 视图要一句摘要，所以这张卡在**行未展开时**只返回一句话。

卡片可改的字段：`enabled`、`tool`（文档里的 4 个网关搜索工具）、`maxSources`、`timeoutMs`、`maxTokens`、
`provider` / `model`（钉死路由，可选）、`instructions`。改完点保存；字段恢复成默认值时写的是 `unset`
（清除覆盖、重新继承），每个被覆盖的字段旁边有单独的「恢复默认」。

控件形态跟内置卡片对齐：布尔字段是**左标签 + 右开关**的一行（内置 Subagent 卡 toggle row 的形态，开关贴最右）；
`tool` 是**单选列表**而不是 `<select>` —— 全部选项一次看得见，分组框的边框 / 圆角 / padding / 行距照内置
Subagent 卡的选择列表来（原生 radio，不做自定义绘制）。

浏览器半边是**手写的** `lib/client.js`，按所有插件 bundle 的加载格式（`window.__ModuleLoader__.load({ id, factory })`）
写死，所以本仓库没有构建步骤、也不依赖 npm 上的任何运行时包；基座模块表里它只取 `react` 一个，
跨插件协作一律走 cordis 服务或槽位（`ctx.slots` 与 `ctx.configForms`）。

> 改了浏览器半边的**内容**只要刷新页面（必要时 Ctrl+Shift+R）就生效：bundle 由 Host 每次从磁盘读，
> 实测改完在已运行的 `dsh web` 里直接看到新样式与新文案。只有**增删 bundle 本身**
> （`dsh.profile.bundles` / profile `package.json` 的组合变化）才需要重启。

### 卡片的外观来自宿主，不是自己画的

DSH 里**没有**「声明式配置卡」这种接口。slot 契约写得很直白：*a card draws its own internals; the tab only
decides which namespaces to dispatch and stacks what comes back*；一个 Host 已服务、但没有卡片认领的
namespace **什么都不渲染**（`tab-store` 的原话：*A served namespace no card claims renders nothing*）。
所以卡片必须由插件自己贡献，这里没有可选项。

内置卡片共用的那层 chrome（`PluginCard` + `card-form` 字段套件 + 对应的 CSS module）在
`@deepseek-ai/dsh-client-ui-settings-plugins` 内部，而那个包的客户端 bundle 只导出 `apply` 与 `inject`
（`lib/client.js` 末尾就是 `exports.apply` / `exports.inject` 两行），**仓库外的包 import 不到它**。

真正共享的是 shell 自己建立的基座模块表 `PLATFORM_MODULES`：

`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`

**这张卡只取其中 `react` 一个。** 把 Harness Client 包当模块 import 正是 dsh 插件指南明确不让做的事——那些 id 会无预告变化，
而且一个抛异常的组件会把整个 slot entry 变成空白——所以两个真正带行为的控件改成自己画：

1. 「已覆盖」徽标与布尔开关，样式照内置 **Tag** 与 **Switch** 的规则来：几何、颜色、选中/未选中时的滑块规则逐值照抄，
   连结构都是同一个 `<button role="switch" aria-checked>`，键盘与读屏看到的就是熟悉的那个控件；
2. 其余 chrome 全部用宿主的主题 token（`--dsw-alias-*`）写，规则与内置卡片**一条对一条**（数值取自带内的
   `PluginCard.module.css` / `fields.module.css`，不是目测），并以 `style[data-plugin-css]` 注入、域名限定在 `.dswwsc-*`。
   好处是换主题、切深浅色时卡片跟着变：颜色全是 token，样式表里**没有任何十六进制或 rgba 字面量**
   （单元测试对这条做断言）。

> 明确没有采用的三条路：直接 import 那个内部包（导不出来）；借用它已注入的哈希类名（`.YyYd_a_card` 之类）——
> 后者在任何一次宿主重构后都会静默失效；以及 `require('@deepseek-ai/dsh-client-ui-primitives')`——0.3.5 已去掉。

## 开发

```powershell
# 本仓库是纯 ESM JS（无构建步骤）。测试要把 DSH 的模块闭包解析出来：
npm run link-root             # 给 node_modules 建一条指向已安装 DSH 的 junction（不复制文件）

# 渲染测试要 react-dom（源码包里没有，Web UI 是预构建产物）：
npm install --prefix .card-test-modules --no-save react@18 react-dom@18

npm test                      # 单元测试（不花钱）
node test/live-gateway.mjs    # 真实网关 + 真实 seam（会花一次搜索的钱）
```

`link-root` 按 `$DSH_HARNESS_MODULES` / `$DSH_HARNESS_INSTALL` 环境变量或常见安装根
（`%LOCALAPPDATA%\Programs`、`Program Files`、`D:\apps`……）自动找 DSH，依次探测
`resources/app/dsh/node_modules` 等几种闭包布局，并要求本插件的全部裸导入都以
**可读的 package.json** 存在（悬空链接不算数），然后建 `node_modules` 联接并当场验证解析。
DSH 升级后重跑一次即可，联接跟着新安装走；也可以 `npm run link-root -- --json` 拿机器可读结果。

发行版桌面端把闭包**打包**在 `resources/app.asar` 里，junction 伸不进去：此时 `link-root` 会直接报出这个 asar，改用抽取的那条：

```powershell
npm run link-runtime -- --asar "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar"
```

渲染测试会在 `DSH_CARD_TEST_MODULES`、`.card-test-modules/`（git 已忽略）、`$DSH_HOME/profiles/*`
这几处依次找 `react` / `react-dom`；都找不到时这 13 项优雅跳过，其余测试照跑。

> `tools/link-harness-runtime.mjs` 是**打包**安装的路线，不是解包安装上 `link-root` 的替代品：它按 `app.asar` 抽真目录，会先
> **拆掉** `node_modules` 上的 junction。0.3.3 之前就踩过一次：它自动探测到了机器上另一个 Electron 包的 `app.asar`，
> 抽出来的闭包里没有 `@deepseek-ai/*`，插件当场加载失败。所以要显式传 `--asar <path>`（或 `DSH_HARNESS_ASAR`），确保用的是
> **这份** DSH 的载荷。

| 文件 | 作用 |
|---|---|
| `src/index.js` | 插件入口：`name` / `inject` / `apply` / `configure({auto:false})` / 选中项诊断。 |
| `src/config.js` | schemastery 配置 schema、volatile 字段与常量。 |
| `src/route.js` | 选模型 + 解端点 + 取凭据（无网络调用，只走 `settings.describe()`）。 |
| `src/gateway.js` | 那一次 HTTP 请求、错误分类、回答与来源的组装。 |
| `src/parse.js` | `Sources:` 段落切分、markdown/裸 URL 提取、去重与标题。 |
| `src/prompt.js` | 搜索指令（固定收尾形状是解析契约的一部分）。 |
| `src/provider.js` | `WebSearchProvider` 实现：`available()` / `ready()` / `search()`（只读 seam，不写会话日志）。 |
| `cordis.patch.yml` | bundle 层：改 `web.searchProvider` + 插入插件行。 |
| `lib/client.js` | 浏览器半边：手写的加载器 bundle，注册 `plugins.row.config` 卡片。 |
| `tools/repair-session-events.mjs` | 扫描/修复被自定义会话事件写坏的会话日志（补 `ignorable: true`，带备份与自检）。 |
| `tools/link-dependency-root.mjs` | 给本目录建 `node_modules` junction 指向已安装 DSH；要求该安装是解包的（`resources/app/…`）。 |
| `tools/link-harness-runtime.mjs` | 从打包的 `app.asar` 抽出闭包（发行版桌面端即此布局）；会拆掉 junction。 |
| `install.mjs` | 装/卸到某个 profile。 |

## 标注为 DSH 插件

这个仓库用三层标记说明它是 DSH（DeepSeek Harness）的插件项目，前三层是机器可读的：

| 层 | 位置 | 值 |
|---|---|---|
| 清单角色 | `package.json` → `dsh` | `{ "bundle": { "patch": "./cordis.patch.yml" } }` —— profile 启动器据此把这行当作 bundle 层加载。 |
| 浏览器半边 | `package.json` → `dsh.client` | `{ "platform": "web" }` + 导出 `./client` —— client-modules 据此把它当浏览器插件挂进 boot graph，设置页的卡片就来自这里。 |
| 包身份 | `package.json` → `name` / `version` / `author` / `license` | 具名且带版本，才会出现在 DSH 的插件清单（`dsh_plugin_packages` 请求字段）里。 |
| 检索关键词 | `package.json` → `keywords` | `dsh-plugin`、`dsh`、`deepseek-harness`、`web-search`、`search-provider`、`clinepass`、`vercel-ai-gateway`、`openai-compatible`。 |
| 仓库主题 | GitHub repo topics | `dsh-plugin`、`deepseek-harness`、`dsh`、`web-search`、`clinepass`、`vercel-ai-gateway`、`openai-compatible`。 |

以上四项本仓库都已应用（topics 与 description 已通过 GitHub API 写入）。
需要在新 fork / 新仓库上重做时，GitHub 的 topic 与 description 需要仓库权限，`gh` 未安装时用 API 设置：

```powershell
$token = "<你的 GitHub PAT，需要 repo 权限>"
$repo  = "qujinting/dsh-web-search"

# topics
curl.exe -X PUT -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" `
  "https://api.github.com/repos/$repo/topics" `
  -d '{"names":["dsh-plugin","deepseek-harness","dsh","web-search","clinepass","vercel-ai-gateway","openai-compatible"]}'

# description
curl.exe -X PATCH -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" `
  "https://api.github.com/repos/$repo" `
  -d '{"description":"DSH plugin: web_search provider that searches with the session\u0027s selected model via gateway-native search tools (vercel:perplexity_search), replacing the built-in DeepSeek-only provider."}'
```

## 许可

MIT，见 [LICENSE](LICENSE)。
