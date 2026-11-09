# dsh-secret-broker

[English](README.md) | 简体中文

DSH 桌面端插件：在设置界面里以「键 → 值」录入敏感数据，会话只拿到**键名**，
真正执行命令/脚本时才由主机把值注入子进程。

- 界面：**设置 → 密钥**，或会话标题栏的钥匙图标（三级作用域：全局 / 工程 / 会话）
- 会话侧：`$env:DSH_SECRET_<键名大写>`；`secret_list` 工具只列键名与描述，永不返回值
- 落盘：`data/secrets.dpapi`，Windows DPAPI（CurrentUser）加密
- 结果脱敏：任何工具结果里出现已知的值，写进会话日志之前就被替换成 `«redacted:KEY»`

## 为什么不是「把 token 贴进对话」

一旦值进入对话，它就已经被发给了模型提供方、被会话搜索索引、被复制进会话日志的每一份备份。
本插件的做法是：**值从不进入模型上下文**，只在一个地方、一个时刻以明文存在 ——
某条 shell 命令的子进程环境里。

```
界面录入  ──▶  data/secrets.dpapi（DPAPI 密文）
                    │
模型写: pwsh -Command 'curl -H "Authorization: Bearer $env:DSH_SECRET_API_TOKEN" …'
                    │
       ctx.shellEnv.collect(exec)  ← 只注入「命令里点名」且「作用域适用」的那些键
                    │
       子进程 env（不进 argv、不进工具入参）
                    │
       工具结果 ──▶ tools/post-execute 脱敏 ──▶ 才写进会话日志
```

## 用法

插件提供两个入口：

| 入口 | 位置 | 做什么 |
|---|---|---|
| **标题栏入口** | 会话标题栏右侧图标行里的一枚钥匙图标 | 点开弹窗，列出**全局 / 本工程 / 本会话**三组键值对，并**直接在这里增删改** |
| **设置页** | 设置 → 密钥 | 同样的能力，外加**跨作用域总览**（看所有作用域的密钥、给别的工程或会话录入、把孤儿条目提升为全局） |

那枚图标按钮和它旁边的一排（新标签页 / 分栏 / 全屏 / 收起右侧边栏）是同一套规格：
28×28、圆角 8px、透明底、hover 用 layer-2 填充、14px 线性 SVG 图标——它就在那一行里，
不占额外宽度、不改标题栏高度。点它是居中弹窗（28px 圆角、layer 表面、遮罩 + Esc/点遮罩关闭），
按构造就不可能影响标题栏布局。

弹窗里每一行是：`显示 / 隐藏`、`复制`（值显示出来之后）、`修改`、`提升`（工程级和会话级才有）、`删除`。
三个分组（全局 / 本工程 / 本会话）各有一个 `新增`，点开就是内联表单（键名 / 值 / 说明），
作用域由你点的是哪个分组决定。
`删除`要**点两次**（第二次按钮变成「确认删除」，4 秒不点就自动解除）；`修改`只填新值——
旧值不会被回填到表单里，因为那等于把密钥摆在屏幕上让你敲字。

值默认打码，点「显示」才明文显示 30 秒（`titleBarValues: plain` 可改成打开即明文）。

### 1. 录入

打开 **设置 → 密钥**，填「键名」「值」，选作用域，保存。

| 字段 | 说明 |
|---|---|
| 键名 | 字母开头，可含字母数字、`_`、`-`，最长 64 字符。`gh-token` → `DSH_SECRET_GH_TOKEN` |
| 值 | 保存后界面不再显示（可点「查看」临时显示 30 秒） |
| 作用域 | 见下 |
| 说明 | 可选，会出现在会话看到的密钥清单里 |

**三个作用域，越具体越优先**（`会话 > 工程 > 全局`，同名键被更具体的那条覆盖）：

| 作用域 | 什么时候生效 | 适合放什么 |
|---|---|---|
| **全局** | 所有会话 | 你个人的长期 token |
| **工程** | 会话的**工作目录**等于该目录，**或在它下面**（子目录也算，最深的那条优先） | 这个仓库的部署密钥、这个项目的数据库口令 |
| **会话** | 只有那一个会话 | 临时凭据、一次性排查 |

工程是**按目录**算的，不是按会话：同一个工程新开一个会话照样能看到，
会话归档了密钥也还在——这正是它比会话级更适合"项目专用凭据"的原因。
嵌套的工程（`repo` 与 `repo\packages\app`）互相覆盖，最深的那条赢。

行操作：`查看`（30 秒后自动隐藏）、`提升为全局`、`删除`。

### 2. 在会话里使用

```powershell
# 变量名必须出现在命令文本里，才会注入这一个变量
curl -sS -H "Authorization: Bearer $env:DSH_SECRET_API_TOKEN" https://api.example.com/v1/items

git clone https://x-access-token:$env:DSH_SECRET_GH_TOKEN@github.com/owner/repo.git
```

脚本按路径调用时，命令里没有变量名，用标记解锁：

```powershell
# secret-broker: DB_PASS, API_TOKEN
pwsh -File .\migrate.ps1
```

`# secret-broker: all` 表示注入当前会话全部可用键（能不用就不用）。

### 3. 模型怎么知道有哪些键

- **系统提示词**：每个会话都带一段说明 + 当前可用键清单（只有键名与描述）；
- **`secret_list` 工具**：随时重新查询；
- **`secret-broker` 技能**：完整用法与排错表。

三者都由 host 插件注册在全局层，与 agent preset、用户记忆文件、skills 目录无关。

## 安全模型

**保证**

1. 值不进入模型上下文 —— 没有任何工具、提示词或技能路径返回它；`secret_list` 的输出 schema 里没有 value 字段。
2. 值不进入会话日志 —— `tools/post-execute` 在结果提交之前完成替换。
3. 值不被批量带出 —— 只有命令文本点名的键才注入，`Get-ChildItem env:` 拿到的是空的。
4. 值不落明文 —— DPAPI 绑定当前 Windows 账户，拷走文件、换用户、换机器都解不开。
5. 值不进 git / 不进 npm 包 —— `data/` 同时被 `.gitignore` 与 `package.json#files` 排除。
6. 浏览器侧 —— 所有路由过 `ctx.connection.requestRejection`（Host/Origin 栅栏 + 浏览器认证），响应 `no-store`；模型侧没有「查看」路径。
7. 标题栏弹窗默认打码 —— 那是最容易被截图的一栏，所以值要一次显式点击才明文；`/state` 这条路由结构上就没有 value 字段，「显示」是逐键调用 `/reveal` 拿的。

**不保证**（别误判）

- **不防同机同用户的进程**：插件进程内存里有解密后的值，正在运行的子进程环境里也有（这正是功能本身）。
- **不防模型蓄意使用**：知道键名的模型可以让任何程序把值发到任何地方。点名过滤与脱敏只阻断「误泄」，不阻断「蓄意」。
- **脱敏匹配完整值**：短于 `redactMinLength`（默认 8）的值不参与扫描，所以命令打印一个**截断后的短子串**不会被替换。
- **DPAPI 绑定当前 Windows 账户**：换账户/重装/换机器后密文不可解 —— 届时是只读锁定 + 报错，不是静默丢数据。
- **只覆盖 shell 工具**：`read`/`write`/MCP 等工具不走注入路径。

## 配置

```yaml
- id: secret-broker
  name: 'dsh-secret-broker'
  config:
    dataDir: ''            # 默认 <包目录>/data
    encryption: dpapi      # dpapi | none（仅在没有已存在文件时生效）
    keyPrefix: DSH_SECRET_
    toolName: secret_list
    allowReveal: true      # 界面是否允许「查看」已存值（标题栏弹窗的显示/复制也受它管）
    titleBarValues: masked # masked（默认，点「显示」才明文）| plain（弹窗打开即明文）
    redactResults: true    # 结果脱敏总开关
    redactMinLength: 8     # 短于该长度的值不参与扫描
    maxEntries: 200
    registerSkill: true
    registerPromptSection: true
    dpapiTimeoutMs: 20000
```

非法值会回落到默认值并在 host 日志里留一行 warning，不会让插件加载失败。

## 安装

```powershell
# 1. 链接进 profile
#    C:\Users\<you>\.dsh\profiles\desktop\package.json
#      dependencies: { "dsh-secret-broker": "link:<此目录>" }
#      dsh.profile.bundles: [ ..., "dsh-secret-broker" ]
#    或直接用 plugin_manager 工具：install_bundle target=link:<此目录>
# 2. 装依赖
pnpm install --dir $env:DSH_PROFILE_DIR
# 3. 刷新页面（新增 bundle 需要重新注入 boot graph）
```

## 故障与边界

| 现象 | 原因 | 处置 |
|---|---|---|
| 界面顶部报「加密文件无法解密」 | DPAPI 解不开（换了 Windows 账户/机器） | 在同一账户下运行；或先移走 `data/secrets.dpapi` 重新录入 |
| 界面报「数据目录不可写」 | `data/` 权限 | 修权限，或把 `dataDir` 指到可写位置 |
| `$env:DSH_SECRET_X` 是空的 | 命令没点名该变量，或键名拼错 | 直接把 `$env:DSH_SECRET_X` 写进命令；先 `secret_list` 核对 |
| 脚本取不到值 | 命令没点名、也没加标记 | 加 `# secret-broker: X` |
| 输出变成 `«redacted:X»` | 命令把值打印出来了 | 改成不输出值 |
| 写入报「正被另一个进程写入」 | 另一个 DSH 进程正在写 | 稍后重试 |
| 会话级密钥不生效 | 那条密钥属于别的会话 | 换作用域重新录入 |
| 删掉的密钥还能在 `data/` 里看到别的文件 | 每次写入前会把上一代文档留成 `secrets.dpapi.bak`（同样的 DPAPI 密文），下一次写入就被覆盖 | 想立刻清掉就直接删除 `secrets.dpapi.bak`；它是明文不可读的 |

## 开发

```
src/index.js      装配：store / shellEnv / tool / prompt / skill / routes / redaction
src/store.js      条目模型、作用域、原子写、锁、备份、DPAPI 开关
src/crypto.js     DPAPI 桥（powershell.exe + ProtectedData，载荷走子进程环境而非 argv）
src/shellenv.js   ctx.shellEnv contributor：声明同步 + 按点名/标记/作用域过滤
src/redact.js     tools/post-execute 与 tools/ptc-dispatch-log 的结果脱敏
src/route.js      /api/dsh-secret-broker/*，连接栅栏 + no-store
src/tool.js       secret_list
src/prompt.js     系统提示词 section + 动态键清单变量
src/skill.js      内嵌 secret-broker 技能
lib/client.js     两个界面（手写 __ModuleLoader__ factory，无构建步骤）：
                  会话标题栏图标按钮 conversation.session.header.utilities
                  + 它的弹窗，以及设置页 settings.section
```

```powershell
node --run test     # parse 检查 + 全部单测（DPAPI 不可用时自动 skip）
```

用 `node --run test` 而不是 `pnpm test`：本包没有运行时依赖，客户端那半边从
shell 的平台模块表里取 React，所以任何包管理器都不该在这里落 `node_modules`。

`.dev/` 放本机验收用的一次性工具（gitignored，不随包发布）：`mint-cookie.mjs`
用来给一次性 Chrome 签一个浏览器会话 cookie，这样 `chrome_cdp` 能打开真实 GUI 做验收。

## License

MIT
