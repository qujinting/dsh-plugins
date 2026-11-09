# dsh-web-search-clinepass

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
    - id: web-search-clinepass
      name: 'dsh-web-search-clinepass'
      config: {}
```

内置的 `web-search-deepseek` 仍然挂着（不再是选中项），需要时可以随时切回去。

## 安装

按 dsh 版本选一条路。两条路装的是同一个 bundle，区别只在**谁改 profile 清单**，以及装完卡片出现在哪。

### dsh 0.1.7 及以后（含 0.2.0，用内置插件管理器）

```powershell
# 从 npm
dsh plugin --profile web add dsh-web-search-clinepass

# 或从本地 checkout
dsh plugin --profile web add file:D:/project/qujinting/dsh-plugins/dsh-web-search-clinepass
```

- **0.2.0-rc.2 起 `dsh` 命令随桌面版打包**，不再要求你另装 Node / pnpm；第一次用先点菜单栏的
  **「Manage dsh command」** 把它装进 PATH，之后上面两条命令照常用（`--profile` 换成要装的 profile，桌面版是 `desktop`）。
- 插件管理器会跑 pnpm：把包装进 `<DSH_HOME>/profiles/web/node_modules`，并把 `dsh-web-search-clinepass`
  追加进该 profile 的 `dsh.profile.bundles`（它自己会先备份 `package.json.bak-install-<时间戳>`）。
- **重启 dsh 后生效**（bundle 清单在启动时组装）。可用 `dsh --profile web --dump-config` 先看拼装结果，不会启动服务。
- 装完的配置页在 **左侧「插件」→ 已安装 → `dsh-web-search-clinepass` → 组件行 `web-search-clinepass` 的「配置」**。
  0.1.7 把带配置的插件页搬到了插件管理器页；「设置 → 插件」现在只剩只读的插件列表。
- 注意：`dsh plugin add file:` 是把代码**装进 pnpm store（硬链接）**，不是目录联接。改完本仓库代码要再跑一次
  add 命令才生效（或者干脆用下面 0.1.5 那条 junction 路线做开发）。
- 卸载：`dsh plugin --profile web remove dsh-web-search-clinepass`。

### dsh 0.1.5

```powershell
# 1) 装进 web profile（在插件目录里执行）
node install.mjs --profile web

# 2) 看拼装结果（不会启动服务）
dsh --profile web --dump-config

# 3) 重启 web 服务后生效
dsh web
```

`install.mjs` 只做两件可逆的事：

- 在 `<DSH_HOME>/profiles/web/node_modules/dsh-web-search-clinepass` 建一个目录联接（junction）指向本目录；
- 把 `dsh-web-search-clinepass` 追加到该 profile `package.json` 的 `dsh.profile.bundles`，并写一条 `file:` 依赖；
  改写前会自动备份 `package.json.bak-install-<时间戳>`。

它建的是**目录联接**，所以改本仓库代码后刷新页面（浏览器半边）或重启（host 半边）即可，不用重装。
配置页在 **设置 → 插件 → 插件配置**，设置写在 `<DSH_HOME>/settings.yaml` 的 `web-search-clinepass:` 段。

手动安装（等价，供参考）：

```powershell
# 在 <DSH_HOME>/profiles/web 下
New-Item -ItemType Junction -Path node_modules\dsh-web-search-clinepass -Target D:\project\qujinting\dsh-plugins\dsh-web-search-clinepass
# 然后把 dsh-web-search-clinepass 加进 package.json 的 dsh.profile.bundles 末尾
```

### 卸载

0.1.7：`dsh plugin --profile web remove dsh-web-search-clinepass`
0.1.5：`node install.mjs --profile web --uninstall`

两者都会移除包与 bundles 条目（并备份 `package.json`）。重启后 `web.searchProvider` 回到 `deepseek-official`，
内置行为完全恢复——插件不改动任何原生文件。

### 一个包，两套 settings API

dsh 0.1.7 重做了设置：插件的 Config 条目**就是**它的设置项，可编辑字段要标 `.volatile()`，写入落在 profile 的
`cordis.patch.yml`；0.1.5 则是 `settings.installSection()` 注册一个 plugin-owned section，落在 `settings.yaml`。
本插件用一个包同时支持两者。**dsh 0.2.0-rc.2 沿用 0.1.7 那一套**——`configure({ auto })` 在，`installSection()`
与 `get(ns)` 都不在——所以下表 0.1.7 那一列同时就是 0.2.0 的行为，本插件没有为它加分支：

| | dsh 0.1.5 | dsh 0.1.7+ |
|---|---|---|
| host 半边 | `settings.installSection(ctx, 'web-search-clinepass', Config, …)` | `settings.configure({ auto: false }, ctx.fiber)` + 条目自身 Config |
| 可编辑字段 | 整个 section 都进表单 | 只有标了 `.volatile()` 的字段（`src/config.js` 的 `editable()` 包装；老版 schemastery 没有这个方法就自动退化成普通字段） |
| 读值 | section 解析结果（普通值） | volatile 引用，`.get()` 取当前值；`normalizeConfig()` 在每个边界统一摊平 |
| 读**别人的**命名空间（`llm-pi-ai` / `agent-default-model`，用来解路由和兜底模型） | `settings.get(ns)` | `settings.describe()` 返回的 `{ ns, value }` 投影（0.1.7 的服务**没有** `get`）；见「0.3.1 修的那个坑」 |
| 卡片槽位 | `settings.plugin.item` + `ctx.settingsScope` | `plugins.row.config`（key = `<包名>#<行 id>`）+ 页面传入的 `form`（`state` + `mutate`） |
| 卡片位置 | 设置 → 插件 → 插件配置 | 左侧「插件」→ 已安装 → 该包 → 组件行「配置」 |
| 设置落在 | `<DSH_HOME>/settings.yaml` | `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` |

分流全靠**服务探测**，没有版本号判断：host 半边看 settings 服务上有没有 `configure`（有就新、没有就旧），
`readSettings()` 同样先问 `get`、没有再问 `describe`（`src/route.js`）；
浏览器半边分别 `ctx.inject(['settingsScope'], …)` 与 `ctx.inject(['configForms'], …)`，两边的 `inject` 只会有
一边被满足，所以只会注册一张卡片。

### 0.3.1 修的那个坑：0.1.7 上 `web_search` 报 "registered but unavailable"

0.3.0（也就是「同时支持两套 settings」那版）只把**自己这一条的 Config** 迁到了 0.1.7 的模型，
**读别人的命名空间**那条路忘了迁：`readSettings()` 仍然只调 `settings.get(ns)`，而 0.1.7 的
`@deepseek-ai/dsh-settings` 里根本没有 `get`（`installSection` 也没了），异常被 `try/catch` 吞掉后一律返回
`undefined`。后果是 `llm-pi-ai` 永远读不到，`resolveTarget()` 拿不到 `baseURL` / `apiKeyEnv`，
`available()` 恒为 `false`，于是每次搜索都变成：

```
Error: configured web provider "clinepass" is registered but unavailable
    (WEB_PROVIDER_CONFIGURED_UNAVAILABLE)
```

只发生在 dsh 0.1.7+ 上；0.1.5 因为 `get` 还在，行为不变。修法是给 `readSettings()` 加上 0.1.7 的读法
（`settings.describe()` 的 `{ ns, value }` 投影，内部已经把 volatile 引用摊平）：

```js
if (typeof settings.get === 'function') { /* 0.1.5 */ }
return describedSettings(settings, ns);      // 0.1.7: describe() 里按 ns 找 value
```

**升级后仍然报这个错、又不能马上重装插件时**，可以先在 profile 的 `cordis.patch.yml` 里把路由钉死
（`provider` / `model` 是 volatile 字段，写在 patch 里同样生效；`baseURL` / `apiKeyEnv` 是普通字段，
所以它们本来就只能从 patch 配，卡片里没有这两栏）：

```yaml
- id: web-search-clinepass
  config:
    provider: clinepass
    model: cline-pass/deepseek-v4.1-flash
    baseURL: https://api.cline.bot/api/v1
    api: openai-completions
    apiKeyEnv: CLINEPASS_API_KEY
```

代价是这条搜索不再跟随 UI 里选的模型；把插件升到 0.3.1 后删掉这段即可恢复跟随。

## 配置

设置命名空间：`web-search-clinepass`（会出现在 Web 的「设置 → 插件配置」里，可热改）。

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
`llm-pi-ai.providers.<route>`（`api` / `baseURL` / `apiKeyEnv`）——0.1.5 通过 `settings.get('llm-pi-ai')` 读，
0.1.7 通过 `settings.describe()` 读（见《0.3.1 修的那个坑》）。

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

- **单元测试** `npm test`：**61 项，全绿、0 skipped**。解析与路由解析 **22 项**（中文标点、markdown 链接、去重、截断、会话跟随、切换模型、协议不兼容、显式钉死、fallback、
  以及 0.1.7 的读法：只有 `describe()` 没有 `get()` 时仍能解出路由与端点、`agent-default-model` 同样可读、投影里没有该命名空间时仍判不可用），
  搜索路径与修复工具 15 项（搜索不写会话事件、不可用路由不碰会话、schema 不再暴露写入开关、请求体带 `tools[].config`、
  四个工具各自的 config 字段映射、未知 tool id 只发裸 id、system prompt 的搜索次数上限、未支持事件识别、
  信封标记、帧结构保持、dry-run、活跃会话与 `session.lock` 保护、只扫描当前代际），
  **host 半边 5 项**（0.1.7 走 `configure({auto:false})` 并读活引用、0.1.5 走 `installSection` 且优先用 section、
  两套都没有时退回组合条目、`normalizeConfig` 摊平引用/透传普通值、可编辑字段标记为 volatile），
  浏览器半边 19 项（两条注册路径各一项：0.1.7 的 `plugins.row.config` 键 `<包>#<行>`、0.1.5 的 `settings.plugin.item` 且等 ledger；
  0.1.7 页面视图渲染字段、summary 视图不需要 form、未服务的条目渲染空、只读条目禁用全部按钮；写入计划器、默认值即清除覆盖、
  默认折叠只渲染 header、命名空间缺失时的降级渲染、样式表只读主题 token 且全部命名空间化、Tag/Switch/chevron 走基座模块、
  折叠 chevron 依次回退 `IconChevronDownOutline14` → `IconChevronDownOutlineMedium` → `IconChevronDownOutlineRegular`，
  三个名字都没有时只少画一个图标、header 照常渲染、
  布尔字段是「左标签 + 右开关」的 toggle row、搜索工具是单选 radio 列表且页面里没有 select、只提供文档里的四个工具、
  搜索工具那一栏明说次数上限只是建议）。
  其中 12 项渲染测试需要 `react-dom`，缺失时优雅跳过；`npm run link-runtime -- --with-react` 会把它一并装好，
  所以本机现在报的是 **61 通过 + 0 跳过**（此前闭包来自旧的全局 dsh 安装，只能跑出 49 通过 + 10 跳过）。
- **真实 dsh 0.2.0-rc.2 验收（0.3.2）**：桌面版 0.2.0-rc.2（内核 `@deepseek-ai/dsh` / `dsh-web` / `dsh-settings`
  同为 0.2.0-rc.2）上**不改一行代码**即可运行。host 半边：`include:web-search-clinepass` 正常挂载，
  `ctx.web.registerSearchProvider` 与 `settings.configure({ auto: false }, owner)` 签名未变，`settings.describe()`
  仍返回 `{ ns, value, user, writable }`（即 `readSettings()` 的 0.1.7 那条读法继续有效），`llm-pi-ai` 命名空间与
  `providers.clinepass` 的 `api` / `baseURL` / `apiKeyEnv` 完好，真发一次 `web_search` 返回带来源的回答。
  client 半边：用 CDP 走真实 GUI（左侧「插件」→ 已安装 → 组件行右侧的配置按钮）确认卡片仍渲染出**全部 8 个字段**
  （1 开关 / 4 单选 / 3 数字 / 3 文本 / 1 文本域 + 三颗底部按钮），`plugins.row.config` 槽由 plugin manager 声明并
  渲染 `dsh-web-search-clinepass#web-search-clinepass`，控制台 0 error；基座 `Tag({ tone })` 与
  `Switch({ checked, onChange, label, disabled })` 签名未变，卡片用到的 12 个 `--dsw-alias-*` token 在 0.2.0 全部存在。
  **0.2.0 唯一改掉的名字是图标**：`IconChevronDownOutline14` 被 `IconChevronDownOutlineMedium` / `Regular` 取代
  （在整个载荷里 0 次出现），它只出现在 0.1.5 那张卡的 header 里，所以此前不触发；0.3.2 起按名字依次回退。
- **真实 0.1.7 settings 实现（0.3.1 的回归验证）**：不启动整个 harness，而是直接把**真实的**
  `SettingsForms.prototype.describe`（未打桩，只喂给它一个 `configEditor.configuration()` 的替身）跑在**真实的**
  `@deepseek-ai/dsh-llm-pi-ai` 的 Config schema 与本机 profile 的真实路由值上：`describe()` 输出
  `[{ ns: 'llm-pi-ai', value: { providers: { clinepass: { baseURL: 'https://api.cline.bot/api/v1' } } } }]`。
  再把这同一个 ctx 分别喂给 HEAD（0.3.0）与修好后的 `resolveTarget()`：
  0.3.0 在 0.1.7 服务下 `available() === false`（就是那条 `registered but unavailable`），修好后同一个 ctx
  `available() === true`、端点 `https://api.cline.bot/api/v1/chat/completions`、来源 `session request header`；
  0.1.5 的 `get(ns)` ctx 在修改前后都照常解出。**未做**的验证：真实 GUI 里重启 harness 后再跑一次 `web_search`
  （插件是 `file:` 装进 profile 的硬链接副本，改仓库代码要重新 `dsh plugin add` + 重启才生效）。
- **真实 GUI 验收（与内置卡片逐项对齐）**：用本机 Chrome 走 CDP 直连正在运行的 `dsh web`（临时 profile + 用本机
  `client-connection/browser-session` 签名密钥铸的会话 cookie，密钥不出本机），把这张卡和内置「网页搜索」卡放在**同一页**逐项量：
  折叠态两张卡都是 **564×75**（header padding 14/16、gap 12、标题 15px/600、摘要 13px、chevron 14×14 且 `viewBox="0 0 14 14"`）；
  展开态 body 的 border-top / margin 16 / padding-bottom 8、字段 padding 12、label 13px/500、hint 12px、
  控件 530×36（radius 8 / border 1px / padding 12 / font 13）、footer 与保存按钮（font 13、padding 5/14、
  bg = label-primary、文字 = bg-layer-3）**逐项相同**；「未保存」Tag 就是同一个基座组件，实测 49×19 / 11px / radius 999px 与内置一致；
  切到 `body[data-ds-dark-theme]` 后两张卡的 token 一起变（卡片 44,44,46 / 边框 67,69,74 / 控件 53,54,56 / 文字 249,250,251），
  控制台 **0 error、0 warning**；位置始终在内置四张卡片（终端 / Agent 循环 / Subagent / 网页搜索）之后。
  两个控件的形态也在同一页对着内置 Subagent 卡量过：开关行 `justify-content:space-between` / `align-items:flex-start` /
  `gap:16px`、开关外框 36×20 且贴右（右间距 0px），与内置的 toggle row 完全一致；搜索工具的单选组框
  （border 1px rgba(0,0,0,.16)、radius 8、padding 10、gap 6、max-height 280、overflow auto）与内置 Subagent 卡
  的选择列表 fieldset **逐项相同**，行内 padding 6 / radius 6 / gap 8 / 原生 radio 13×13 也一致；
  4 个选项同一个 `name`、只有一个是 checked，页面里 `<select>` 数量为 0。
- **真实 GUI 验收（dsh 0.1.7，隔离实例）**：另起一个 `DSH_HOME`（临时目录、临时 profile、3091 端口）跑真实的
  `dsh 0.1.7-rc.2 web`，装上本插件后用 CDP 走完真实路径：左侧「插件」列出 `dsh-web-search-clinepass v0.3.0`（已安装 1 个）→
  组件行 `web-search-clinepass` 的「配置」→ 页面渲染出本卡的 **8 个字段 / 4 个单选（默认项选中）/ 1 个开关行 /
  6 个文本框 / 三颗底部按钮**，样式表已注入 `style[data-plugin-css]`；改为 `vercel:parallel_search` 点保存后显示
  「已保存（1 项）。」，且 profile 的 `cordis.patch.yml` 里确实出现
  `- id: web-search-clinepass\n  config:\n    tool: vercel:parallel_search`；
  全过程 **0 error、0 warning**。（验证用的临时实例与临时 home 已删除，没有碰你正在跑的那个 dsh。）
- **真实 seam 集成** `node test/live-gateway.mjs`：用真实的 `WebRuntime`（`@deepseek-ai/dsh-web`）注册本供应商，
  按 `searchProvider: clinepass` 选中，向 `api.cline.bot` 实发一次搜索，断言来源非空且 `maxResults` 生效。
- **真实网关实测（搜索次数与 tools[].config）**：走插件自己的 `searchWithGateway` 打真实网关，
  perplexity 与 parallel 各自 200 / `finish_reason: stop`、来源各 10 条、没有截断提示；
  `gatewayToolCalls` 分别为 4 与 2，`gatewayCost` 分别为 **$0.0298 / $0.0202**
  （加「最多 3 次搜索」之前的同一类问题是 6 / 4 次、$0.0430 / $0.0361）。
- **真实 DSH 端到端**：临时 profile（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` + 本插件）跑一次真实任务，带回真实来源链接。
  端到端跑通后**不再产生** `web/clinepass-search-request` 事件；早期版本写进会话日志的那些事件已用
  `tools/repair-session-events.mjs` 补上 `ignorable: true`（见《为什么不再写会话日志事件》），会话可以正常重新加载。

## 限制与注意事项

- **不写任何会话日志事件。** 早期版本每次搜索都会追加一条 `web/clinepass-search-request`（v0.1.0 里叫
  `web/current-model-search-request`），这会让会话在下次 resume 时被**整份**拒绝加载；该行为已删除，也没有重新打开的开关。
  已被写坏的会话用下一节的工具修复。
- **只对 OpenAI 兼容且支持供应商端工具的路由生效。** 路由声明了非 chat-completions 协议（例如 `anthropic-messages`）时，
  本供应商直接报告不可用——这是有意的：让网关工具 id 发给不懂它的端点只会得到难懂的错误。
- **切到非网关模型时 `web_search` 会报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`。**
  两种处理：在设置里配 `fallback.provider` / `fallback.model` 钉一个网关路由兜底；
  或把 profile 的 `cordis.patch.yml` 里 `web.searchProvider` 改回 `deepseek-official`。
- **凭据只从 `ctx.credentials` 与启动环境读。** 密钥不会进日志、不会进会话记录（记录里只有路由、耗时、费用、检索次数）。
- **`web_fetch` 不受影响**，仍然走内置的 `http` 供应商。
- **供应商端工具是一次完整的模型回合**：延迟实测 8–15 秒，费用按上面那张表计。
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

这个插件是**双面**的，而且两套设置模型各有一张卡：

- **dsh 0.1.7**：`lib/client.js` 往 `plugins.row.config` 注册，key 是 `dsh-web-search-clinepass#web-search-clinepass`。
  页面（插件管理器）自己画标题、图标、面包屑，并把该条目的 `form`（`state` + `mutate`）当 prop 传进来；
  列表里还会调用 `summary` 视图要一句摘要，所以这张卡在**行未展开时**返回一句话。
- **dsh 0.1.5**：往 `settings.plugin.item` 注册，key 是 `web-search-clinepass`，自己绑 `ctx.settingsScope`；
  卡片是 `<li>` + 带 `aria-expanded` 的 header 按钮（标题 / 摘要 / 未保存标记 / chevron），**默认折叠**，
  保存成功后自动收起，失败则保持展开。

0.1.5 那张卡的**排序规则**：设置页按 ledger 顺序渲染，而本插件的 `apply` 比设置插件自己注册卡片更早，
所以「立刻注册」会把这张卡顶到所有内置卡片之前。实现改为**等 ledger 里已经有卡片再入列** ——
于是它排在本机加载时已有的那些配置之后，而不是钉死在最后（之后再注册的卡片依然排在它后面）。
0.1.7 不涉及这个问题：位置由插件页面自己决定。

卡片可改的字段：`enabled`、`tool`（文档里的 4 个网关搜索工具）、`maxSources`、`timeoutMs`、`maxTokens`、
`provider` / `model`（钉死路由，可选）、`instructions`。改完点保存；字段恢复成默认值时写的是 `unset`
（清除覆盖、重新继承），每个被覆盖的字段旁边有单独的「恢复默认」。

控件形态跟内置卡片对齐：布尔字段是**左标签 + 右开关**的一行（内置 Subagent 卡 toggle row 的形态，开关贴最右）；
`tool` 是**单选列表**而不是 `<select>` —— 全部选项一次看得见，分组框的边框 / 圆角 / padding / 行距照内置
Subagent 卡的选择列表来（原生 radio，不做自定义绘制）。

浏览器半边是**手写的** `lib/client.js`，按所有插件 bundle 的加载格式（`window.__ModuleLoader__.load({ id, factory })`）
写死，所以本仓库没有构建步骤、也不依赖 npm 上的任何运行时包；它用基座模块表里的 `react` 与
`@deepseek-ai/dsh-client-ui-primitives`，跨插件协作一律走 cordis 服务或槽位（`ctx.slots`、0.1.5 的
`ctx.settingsScope`、0.1.7 的 `ctx.configForms` 探测）。

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
**`@deepseek-ai/dsh-client-ui-primitives`**、`@deepseek-ai/dsh-client-ui-dockkit`

于是这张卡的做法是：

1. `require('@deepseek-ai/dsh-client-ui-primitives')` —— 拿到的是内置卡片用的**同一个实例**，用它渲染
   「未保存」`Tag`、布尔字段的 `Switch`、header 的 `IconChevronDownOutline14`；
2. 其余 chrome 全部用宿主的主题 token（`--dsw-alias-*`）写，规则与内置卡片**一条对一条**（数值取自带内的
   `PluginCard.module.css` / `fields.module.css`，不是目测），并以 `style[data-plugin-css]` 注入、域名限定在 `.dswwsc-*`。
   好处是换主题、切深浅色时卡片跟着变：颜色全是 token，样式表里**没有任何十六进制或 rgba 字面量**
   （单元测试对这条做断言）。

> 明确没有采用的两条路：直接 import 那个内部包（导不出来），以及借用它已注入的哈希类名（`.YyYd_a_card` 之类）——
> 后者在任何一次宿主重构后都会静默失效。

## 开发

```powershell
# 本仓库是纯 ESM JS（无构建步骤）。测试要把 DSH 的模块闭包解析出来，先从已安装的 DSH 里抽一份：
npm run link-runtime -- --asar "<DSH 安装目录>\resources\app.asar" --with-react

npm test                      # 单元测试（不花钱）
node test/live-gateway.mjs    # 真实网关 + 真实 seam（会花一次搜索的钱）
```

`link-runtime` 按**真实 import 图**把 `@deepseek-ai/*` 及其传递依赖从 Electron 的 `app.asar` 抽进 `node_modules/`
（当前闭包 22 个包 / 877 个文件，来源与版本记在 `node_modules/.dsh-harness-runtime.json`）。
之所以不从 npm 装：registry 上的 `@deepseek-ai/dsh-web` 还停在 `0.0.1-rc.1`，和内核版本对不上。
每次升级 DSH 后重跑一次即可（加 `--clean` 先清空再抽）。它**先拆掉 `node_modules` 上的目录联接、再建真目录**，
不会顺着旧联接把文件写进共享的 profile 目录——早先的联接指向已被卸载的全局 dsh 与旧 monorepo 检出，
正是 `npm test` 报 `ERR_MODULE_NOT_FOUND` 的原因。

源码包里没有 `react` / `react-dom`（Web UI 是预构建产物），`--with-react` 会额外装一份并复制进来，
让 12 项渲染测试真正跑起来；不加这个参数时它们会优雅跳过（`DSH_CARD_TEST_MODULES` 仍可指向任意一份自备的模块目录）。

| 文件 | 作用 |
|---|---|
| `src/index.js` | 插件入口：`name` / `inject` / `apply` / 设置命名空间注册。 |
| `src/config.js` | schemastery 配置 schema 与常量。 |
| `src/route.js` | 选模型 + 解端点 + 取凭据（无网络调用）。 |
| `src/gateway.js` | 那一次 HTTP 请求、错误分类、回答与来源的组装。 |
| `src/parse.js` | `Sources:` 段落切分、markdown/裸 URL 提取、去重与标题。 |
| `src/prompt.js` | 搜索指令（固定收尾形状是解析契约的一部分）。 |
| `src/provider.js` | `WebSearchProvider` 实现：`available()` / `search()`（只读 seam，不写会话日志）。 |
| `cordis.patch.yml` | bundle 层：改 `web.searchProvider` + 插入插件行。 |
| `lib/client.js` | 浏览器半边：手写的加载器 bundle，注册设置卡片（0.1.7+ 的 `plugins.row.config` / 0.1.5 的 `settings.plugin.item`）。 |
| `tools/repair-session-events.mjs` | 扫描/修复被自定义会话事件写坏的会话日志（补 `ignorable: true`，带备份与自检）。 |
| `tools/link-harness-runtime.mjs` | 从已安装的 DSH 载荷里抽出模块闭包到 `node_modules/`，供本地测试解析 `@deepseek-ai/*`。 |
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
$repo  = "qujinting/dsh-web-search-clinepass"

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
