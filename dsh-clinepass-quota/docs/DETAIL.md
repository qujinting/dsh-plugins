# ClinePass 额度

用一把 **Cline API Key** 查询 ClinePass 订阅还剩多少额度，并在 DSH 里直接看到。

ClinePass 是 Cline 的定额订阅（$9.99/月）：不按 token 计费，而是把用量折算进三档滚动配额——
**5 小时滚动窗口**、**周**、**月**。网页端只在 app.cline.bot 的订阅页给出百分比；这个插件让同样的
数字出现在 DSH 里，并让模型自己也能查。

## 三个地方能看到

| 位置 | 内容 |
| --- | --- |
| 设置 → **ClinePass 额度** | 完整面板：三档窗口的剩余/已用百分比、进度条、重置倒计时、按量付费余额，以及当前 Key 的来源与掩码 |
| 会话标题栏右侧的徽章 | **最紧的那一档**还剩多少（剩余 ≤25% 变黄、≤10% 变红），点开是同一份面板 |
| `clinepass_quota` 工具 | 模型可直接调用，返回三档窗口与余额；`refresh: true` 绕过缓存 |

徽章显示的是「最紧张的那档」而不是全部三行——用户真正想知道的通常是「我还能不能跑一次长任务」。

## Key 从哪来

插件**不提供录入界面，也不写任何凭据**：key 的增删归 DSH 的凭据存储管，配一次所有插件共用。读取顺序：

1. 插件配置里的 `apiKey`（写在 profile 的 `cordis.patch.yml`，用于非常规部署）；
2. **DSH 凭据存储**里的 `CLINEPASS_API_KEY`，其次 `CLINE_API_KEY`（可用 `apiKeyEnv` 改）。
   凭据服务自己还会层叠进程环境变量与 `.env`，所以 `CLINEPASS_API_KEY=… dsh` 启动也能命中；
3. 插件目录下的 `data/credentials.json` —— 只读兜底，手工放一个文件即可临时换 key，插件从不创建或修改它。

key 在 **app.cline.bot → Settings → API Keys** 创建。面板只报告读到的是哪一路、掩码长什么样
（`sk_067••••••0346`），原值不会回到浏览器，也不会写进日志。

没找到 key 时，面板给一句可执行的话（去 DSH 凭据里配 `CLINEPASS_API_KEY`），而不是一个输入框。

## 配置项

全部可选；写错一个字段只会回落默认值并打一行 warning，不会让插件行加载失败。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `apiKey` | — | 直接写死 key；优先级最高 |
| `apiKeyEnv` | `["CLINEPASS_API_KEY", "CLINE_API_KEY"]` | 依次尝试的凭据名，也可给单个字符串 |
| `baseUrl` | `https://api.cline.bot/api/v1` | 上游根地址（自建代理 / 测试桩时可改） |
| `cacheSeconds` | `60` | 内存缓存窗口；`0` 表示每次都查 |
| `timeoutMs` | `15000` | 单请求超时 |
| `balanceUnit` | `micro` | 余额单位：官方返回百万分之一美元；`usd` 表示代理已换算 |
| `showCredits` | `true` | 是否额外查询按量付费余额 |
| `headerBadge` | `true` | 是否在会话标题栏挂徽章 |
| `registerTool` | `true` | 是否注册 `clinepass_quota` 工具 |
| `registerRoutes` | `true` | 是否注册设置页/徽章用的路由 |
| `toolName` | `clinepass_quota` | 工具名（须匹配 `^[a-z][a-z0-9_]*$`） |
| `dataDir` | `<插件目录>/data` | 只读兜底 `credentials.json` 的目录（相对路径按插件目录解析） |

示例（profile 的 `cordis.patch.yml`）：

```yaml
- id: dsh-clinepass-quota
  config:
    cacheSeconds: 120
    apiKeyEnv: CLINE_API_KEY
```

## 它查的是什么

三个只读接口，只用第一份当必需品：

| 用途 | 接口 | 失败时 |
| --- | --- | --- |
| 订阅配额 | `GET /users/me/plan/usage-limits` | 401/403 报「key 被拒绝」；**404 表示该账户没有 ClinePass** |
| 账户身份 | `GET /users/me` | 只是装饰，拿不到不影响配额 |
| 按量付费余额 | `GET /users/{id}/balance` | 同上；余额单位是百万分之一美元 |

解析层刻意宽容：窗口既可能是数组也可能是 `{ five_hour: {...} }` 对象，百分比既可能是
`percentUsed` 也可能要由 `used`/`limit` 现算。认不出的字段当没有，不会因为一个未知字段丢掉整份数据。

## 数据边界

key 原文的生命周期只有一次请求：

```
credentials.resolve() → { value }
  → fetch(Authorization: Bearer <value>)
  → 函数返回，value 不可达（this.snapshot 里没有它）
```

对外只有三个出口，结构里都没有「值」这个字段：

| 出口 | 包含什么 |
| --- | --- |
| `GET /state` 的 `key` | `configured` / `source` / `sourceDetail`（凭据名）/ `mask` |
| `clinepass_quota` 工具 | `keySource`，只是凭据名；output schema 无 key 属性 |
| 日志 | 同上，只打来源 |

上游响应体在进入 `notes`（→ 工具结果 → session log）之前会过 `redactText()`：
网关或错误页若把 Authorization 回显进了响应，落在会话里的只会是 `sk_067«redacted»`。
插件不写任何凭据文件。

**唯一会真的把 key 写进会话的路径，是人在对话或命令里把它贴出来** —— 那同时意味着它已经
发给模型提供商，事后只能轮换，清理日志只是止损。

## 限制

- **不查历史用量**。这里只有「当前窗口用了多少」，没有逐日/逐模型账单；那需要
  `/users/{id}/usages`，本插件不碰。
- **不提供 Key 的录入与删除**。凭据的唯一入口是 DSH 的凭据管理；插件只读。
- **两份账是分开的**：ClinePass 配额与按量付费余额互相独立，余额为 $0 不代表订阅到期，
  配额见底也不会自动扣余额。
- **余额按微美元精度展示**（`$0.190123`），不四舍五入到分：小额账户的分位取整会显得
  少了一截。
- 结果依赖网络与上游可用性；失败时页面保留上一次成功的数字并标注「缓存」，不会清空。
- 只在有 `webServer` 服务时才有设置页与徽章；没有它时 `clinepass_quota` 工具仍然可用。

## 排错

- **「API Key 被拒绝（HTTP 401）」**：凭据里的 key 不是 app.cline.bot 里 API Keys 页创建的那个，
  或已经被删；在 DSH 凭据里换一把。
- **「该账户没有 ClinePass 订阅」**：key 有效，但这个账户没订阅；配额接口对它返回 404。
- **「还没有配置 Cline API Key」**：三个来源都没命中，去 DSH 凭据里配 `CLINEPASS_API_KEY`。
- **工具说「结果来自 N 秒前的缓存」**：正常，传 `refresh: true` 强制查。
