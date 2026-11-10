# dsh-rea

把 REA 的逆向能力做成**一个插件，而不是一个模式**。

[English](README.md)

## 它解决什么

REA 的 MCP 服务器带 229 个工具。走通用 MCP 桥（`@deepseek-ai/dsh-mcp-client`）时，
这等于**每个会话的每一次请求**都背着 229 个工具 schema——正是让"快模型变慢"的形状。
常见解法是做一个 agent preset，只给需要逆向的会话挂桥：那是一个你必须记得切进去、
也必须记得切出来的第二模式。

这个插件把能力留在每个会话里、把成本留在外面：它自己持有 REA 服务进程，
只暴露**两个**工具，并且只在被调用时才启动进程。

| | preset + `dsh-mcp-client` | 本插件 |
|---|---|---|
| 每次请求的工具 schema | 229 个 | 2 个 |
| 是否需要切模式 | 需要 | 不需要 |
| 服务进程 | 每个逆向会话一个，会话启动即起 | 首次调用才起，空闲自动停 |
| 目录来源 | 服务器 | 服务器（运行时发现，REA 升级不用改这边） |

## 工具

| 工具 | 用途 |
|---|---|
| `rea_tools` | 检索实时目录。`query` 匹配名称/标题/描述；`exact` 返回单个工具的完整 input schema；`schemas` 为每条匹配带上 schema。 |
| `rea_call` | 执行一个工具：`{ tool, arguments }`。未发现的名字直接报错而不是猜，编造的工具名会当场失败。 |

外加一段很短的 system prompt 路由说明——模型看不见的能力，需要一句话告诉它门在哪。

## 配置

字段全部可选，默认值就是工具描述里承诺的行为。

```yaml
- id: dsh-rea
  name: 'dsh-rea'
  config:
    command: npx                    # 或：node
    args: ['-y', 'rea-agents@6.8.0', 'mcp']   # 或：['<绝对路径>/rea-agents/scripts/rea.mjs', 'mcp']
    toolsToolName: rea_tools
    callToolName: rea_call
    startupTimeoutMs: 180000        # spawn + initialize + tools/list
    callTimeoutMs: 1800000          # 单次 tools/call；默认 30 分钟，见下文「超时」
    idleTimeoutMs: 600000           # 静默这么久就停进程；0 = 不停
    registerPromptSection: true
    warmup: false                   # true 表示插件激活即启动服务
```

Windows 上包管理器命令（`npx` / `pnpm` / `bunx` …）会经 `cmd.exe /d /c` 启动，
因为它是 `.cmd` 垫片，Node 不能直接 spawn。

## 安装

```
plugin_manager action=install_bundle target=<本目录的绝对路径>
```

装完之后**先配 REA 的来源**（下一节），再带关键字调用一次 `rea_tools`。第一次调用承担进程
启动成本（本机实测：`initialize` 2.4 秒，229 个工具的 `tools/list` 51 毫秒），之后复用同一
进程，静默超过 `idleTimeoutMs` 自动退出。

## 设置页：REA 从哪来

插件装到一个从没跑过 `npx rea-agents` 的机器上是常态，所以来源是配置项，不是假设。
打开 **设置 → 逆向工程 REA**（`settings.section` 里 order 65 的一页）。

页面上默认只有一行状态：**已就绪 / 未配置** + 来源 + 版本，右边三个按钮
（「测试连接」「更换」「详情」）。其余信息全部折叠，用时再展开：

| 折叠区 | 里面有什么 |
|---|---|
| 详细信息 | 完整启动行、数据目录、三个候选来源及其可用状态 |
| 手动指定 rea.mjs | 绝对路径输入 + 保存 / 清除（保存后立刻停掉当前进程，下次调用按新路径起） |
| 从 npm 安装 | 版本输入 + 安装 / 取消 + 实时日志（`npm install rea-agents@<version>` 装到数据目录） |

页面会自己展开你需要的那个折叠区：**没找到 REA 时展开「从 npm 安装」**，手动路径失效时
展开「手动指定」。测试结果以一行徽标显示在状态行下方（工具数 / 耗时）。

启动来源的优先级是固定的：

| 优先级 | 来源 | 何时使用 |
|---|---|---|
| 1 | 手动指定的 `rea.mjs` | 设置页里保存过路径，且文件仍在 |
| 2 | 插件目录内置安装 | `<数据目录>/node_modules/rea-agents/scripts/rea.mjs` 存在 |
| 3 | 配置里的 `command`/`args` | 未指定路径、未内置安装 |
| 4 | 默认 `npx -y rea-agents@6.8.0 mcp` | 以上都没有 |

数据目录按这个顺序确定：配置 `dataDir` → `$DSH_PROFILE_DIR/data/dsh-rea` →
`~/.dsh/data/dsh-rea`。**不会**写进插件包目录：链接安装时那是用户的源码树，发布安装时
那目录会在升级时被替换。

设置页通过 `/api/dsh-rea` 与宿主通信（`GET /status`、`POST /set-path`、`POST /clear-path`、
`POST /install`、`POST /cancel-install`、`POST /probe`）。路由走过 `ctx.connection` 的
Host/Origin 与浏览器认证闸门，没有 connection 服务时退化为仅回环地址可访问。

## 从 `@local/dsh-rea-preset` 迁移

旧的「REA 逆向」模式（agent preset + `dsh-mcp-client`）已经从本 profile 移除：它把 229 个
`mcp__rea__*` 塞进那个会话的每次请求，会话一开就常驻一个 REA 进程。现在逆向能力由本插件
接管，任何模式都能用，进程只在被调用时起。

真要回到旧行为，重新安装那个 bundle 即可——两者名字不冲突（`mcp__rea__*` 对
`rea_tools`/`rea_call`），但同时开着就是双份 schema、双份进程。

## 超时与进程回收

两个"超时"不是一回事：

| 机制 | 默认 | 触发后 |
|---|---|---|
| `callTimeoutMs` | 30 分钟 | 这一次调用被放弃（客户端不再等）；**服务端进程继续跑**，只是结果被丢弃 |
| `idleTimeoutMs` | 10 分钟 | 从**最后一次调用结束**起算；到点且没有进行中的调用时才停进程 |

长任务的两条规则：

- 预计超过 30 分钟的活（大二进制全量反编译、provider 冷启动、运行时跟踪），调用时给 `rea_call` 传 `timeoutMs`（上限 2 小时），不要靠重试。
- 空闲计时器在**有调用进行中**时只会重排、不会停进程——进行中的长调用不会被"空闲"误杀。设置页的「测试连接」在有调用进行时会直接拒绝；改路径/清除路径仍会立刻停进程，因为那是你主动要求的。

## 进程兜底：DSH 关了，REA 会跟着走吗

会。三层，从主动到兜底：

| 场景 | 谁执行 | 实测耗时 |
|---|---|---|
| 插件卸载 / HMR / 正常关闭 | Cordis 的 `ctx.effect` disposer → `client.dispose()` → `taskkill /pid <pid> /T /F` | 立即 |
| Electron 直接 `exit`（不跑 disposer） | `process.on('exit')` 里同步 `taskkill /T` | 退出过程内 |
| 进程被强杀 / 崩溃 | 父进程持有的 stdio 管道断开 → REA 读到 stdin EOF 自行退出 | 240 ms（`node rea.mjs mcp`）／722 ms（`cmd → npx → node` 链） |

DSH **没有**可订阅的"宿主即将退出"事件（`Event` 目录里没有 `app/quit` 一类），所以第三层不靠钩子，
而靠 stdio 的语义：插件始终以 `stdio: ['pipe','pipe','pipe']` 启动子进程。**一旦换成 `inherit` 或
`ignore`，这层兜底就不存在了**——改实现时别动这一条。

实测（两次都 exit 0、事后无残留进程）：

```
initialize ok: {"name":"rea","version":"6.8.0"}
closing stdin
child exited: code=0 signal=null after 240ms    # vendor 路径：node 直启
child exited: code=0 signal=null after 722ms    # 默认路径：cmd /d /c npx -y rea-agents@6.8.0 mcp
```

自己查漏：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" |
  Where-Object { $_.CommandLine -match 'rea-agents|rea\.mjs' } |
  ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToString('HH:mm:ss'))" }
```

有输出说明存在没走到上面三层的进程（通常是另一个正在运行的 DSH 实例在用），按 PID
`taskkill /pid <pid> /T /F` 即可。

## 范围与限制

- **只转文本。** `tools/call` 的结果按文本转发；image 块只计数并提示，不挂附件。
  REA 的逆向结果本质是文本，而附件服务是装进 profile 的 bundle 够不到的。
- **不转 resources 和 prompt 模板。** 229 个工具与服务器 instructions 是本插件桥接的面，
  其余留给 `dsh-mcp-client`。
- **单进程共享。** 并发调用在一条 JSON-RPC 管道上复用；长反编译不会挡住目录检索，但会占住管道。
- **不用 SDK。** 传输层是约 250 行 `child_process` + 换行分隔 JSON-RPC，
  因为装进 profile 的 bundle 既解析不到 `@deepseek-ai/*`，也不该为它联网装依赖。

## 验证

```
node --check src/*.js
node test/smoke.mjs                                  # 网关逻辑，不需要服务器
REA_LIVE=1 node test/smoke.mjs                       # 对真实服务器走协议
REA_LIVE=1 REA_COMMAND=node REA_ARGS="<绝对路径>/rea-agents/scripts/rea.mjs mcp" node test/smoke.mjs
```

实测环境：dsh 0.2.2-rc.1 / rea-agents 6.8.0 / Windows / Node 24.22.2，
`initialize` 2 421 ms，`tools/list` 51 ms，一页 229 个工具。

## 许可

MIT
