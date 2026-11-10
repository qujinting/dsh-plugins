# dsh-bridge

[English](README.md) | 简体中文

把 Harness Host 侧那些「能调用、但没人告诉你叫什么」的能力，收敛成一个**带确认、超时、熔断和审计**的统一入口，供其他插件调用。

Harness 是「一切皆插件」：能力都挂在 cordis 上下文上，但每个服务叫什么、方法签名是什么，散落在各个包的 `lib/types` 和 README 里，没有任何公开契约。于是写插件的现实是——要么自己去翻源码猜（升级就碎），要么干脆绕开这个能力重写一遍。

这个插件把「伸手去够内部」这件事收了回来：**脆弱只允许存在于这一个包里**，调用方只依赖稳定的能力名。

```js
export const inject = ['dshBridge']

export function apply(ctx) {
  const bridge = ctx.get('dshBridge')

  // 先问这个部署实际放开了什么，别靠猜。
  const reachable = (await bridge.invoke('service.list')).value.filter(row => row.allowed)

  // SERVICE / METHOD 是占位符：默认策略只放开"惰性"服务，
  // 真实名字用 service.list 查。
  const result = await bridge.call('SERVICE', 'METHOD', { /* 只能是纯数据 */ })
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)

  await bridge.invoke('plugin.restart', { plugin: 'my-plugin', confirm: true }, { caller: 'my-plugin' })
}
```

## 能力清单

| 能力 | 风险 | 作用 |
|---|---|---|
| `service.list` | low | 列出已注册服务名、是否解析得到、桥是否允许触达（`denied` / `allowed`） |
| `service.describe` | low | 查看某个服务的自有键与原型链上的方法名 |
| `service.call` | medium | 调用某个服务的某个方法，返回值转为快照；入参只能是纯数据 |
| `plugin.list` | low | 列出 loader 条目：id、包名、是否激活 |
| `config.edit` | high | 把一个插件的配置持久化到当前 profile 的 patch 并立即生效 |
| `plugin.restart` | high | 按 id 或包名重载插件；省略参数即重载自己 |
| `app.exit` | high | 请求宿主优雅退出 |
| `app.restart` | high | 重启整个宿主：先拉起分离的 relay 并等到心跳，回答调用方之后才让本进程退场 |
| `app.restartState` | low | 报告这台宿主能被怎么重启、还剩多少重启预算、最近几次 relay 干了什么 |

调用统一返回信封，**能力失败不抛异常**，只有参数写错才会——调用方只需要判断 `ok`：

```js
{ ok: true,  capability: 'service.call', caller: 'my-plugin', at: 1794203342454, ms: 3, value: { /* … */ } }
{ ok: false, capability: 'service.call', caller: 'my-plugin', at: 1794203342454, ms: 1, error: { code: 'service-denied', message: '…' } }
```

错误码固定为这几个，可以直接分支：`unknown-capability`、`confirmation-required`、`breaker-open`、`timeout`、`service-denied`、`service-not-allowed`、`method-denied`、`service-unavailable`、`no-such-method`、`no-such-plugin`、`bad-request`、`failed`。

## 四条硬规则

**1. 破坏性动作必须显式确认。** `config.edit`、`plugin.restart`、`app.exit` 和 `app.restart` 出现在 `confirm` 清单里，调用方必须传 `{ confirm: true }`，否则只拿到 `confirmation-required`，宿主毫发无损。这条护栏是防止「agent 循环重试」把自己连着重启三次的那种事故。

**2. 先给回执，再动生命周期。** 重载和退出都推到下一个 tick 执行。原因很实在：如果插件在自己的调用栈里同步重启自己，调用方会在半路被掐断——既没有结果，也没有错误，日志断在一半。所以这类能力返回的是 `{ accepted: true, deferred: true }`，不是结果。

**3. 默认可达集合是「惰性」的。** `serviceDeny` 默认关掉进程执行（`shell`/`subprocess`/`terminals`）、文件系统（`fs`/`workspace*`）、插件生命周期与持久化（`loader`/`hmr`/`pluginManager`）、以及存放密钥和用户数据的服务（`credentials`/`settings`/`storage`/`deepseekAccount`），再加上 `configEditor` 和桥自身。`serviceAllow` 非空时把问题反过来问：只有列出的服务可达。`methodDeny` 是按服务名（`*` 表示全部）的第二道闸——为某个部署把 `loader` 放回白名单，并不会连带把 `loader.update` / `loader.import` / `loader.remove` 一起交出去。另外，策略性拒绝不进熔断计数：服务名敲错不代表宿主坏了。

**4. 数据两个方向都只走数据。** 返回值经 `serialize.js`：函数变成名字、循环在深度 3 截断（但仍报出字段名）、超过 32 项的集合带 `truncated` 标记，**字段名命中 `apiKey / secret / token / password / credential / authorization` 的值一律替换成 `«redacted»`，长得像凭据的字符串同样替换**（`sk-…`、`ghp_…`、`xox…-`、`AKIA…`、JWT）。入参是同一条规则的镜像：`service.call` 只接受可结构化克隆的纯数据。函数入参正是调用方绕开所有方法级检查、把回调塞进宿主的方式（`loader.import(name, getOuterStack)` 就收一个），而活对象入参会让它把宿主状态的引用带出调用之后。

## 其他插件接入（可选依赖）

桥是**可选基础设施**：有的机器 profile 里装了它，有的没有，接入方必须两边都能跑。两种写错的代价并不对称——服务缺失是**静默**的，而最像“探测”的两种写法都是坑。

**不要把它声明成必需注入。** cordis 里 `inject: ['dshBridge']` 是*必需*语义：服务不在，fiber 停在 pending，`apply` 一次都不跑，也不打一行日志。插件看起来装了，实际什么都没做。

**用 `ctx.get` 取一次，再判 `undefined`。** `ctx.get('dshBridge')` 缺服务时返回 `undefined`，永不抛错；属性访问则会抛（`cannot get property "dshBridge" without inject`），所以 `ctx.dshBridge` 不是探测手段。

**兜底路径不要依赖桥。** 桥管的是*怎么伸手*，不是*能不能伸手*。没有桥时 `ctx.get(service)` 照样解析得到服务——那就是兜底。

```js
const MINIMUM_VERSION = 2

/**
 * 一条调用路径：优先走桥，没有桥就降级到原生服务。
 * @param ctx - 接入方自己的插件上下文。
 */
function createCaller(ctx) {
  const bridge = ctx.get('dshBridge') // 没装桥时是 undefined
  const usable = bridge !== undefined
    && Number.isInteger(bridge.version)
    && bridge.version >= MINIMUM_VERSION
  const mode = usable ? 'bridge' : bridge === undefined ? 'native (not installed)' : 'native (too old)'

  async function callService(service, method, args = []) {
    if (usable) {
      const envelope = await bridge.invoke('service.call', { service, method, args })
      if (!envelope.ok) return { ok: false, via: 'bridge', error: envelope.error }
      return { ok: true, via: 'bridge', snapshot: true, value: envelope.value.value }
    }
    const target = ctx.get(service)
    if (target === undefined) {
      return { ok: false, via: 'native', error: { code: 'service-unavailable', message: `service "${service}" is not provided` } }
    }
    try {
      return { ok: true, via: 'native', snapshot: false, value: await target[method](...args) }
    } catch (error) {
      return { ok: false, via: 'native', error: { code: 'failed', message: String(error?.message ?? error) } }
    }
  }

  return { mode, usable, bridge, callService }
}

export function apply(ctx) {
  const { mode, callService } = createCaller(ctx)
  if (mode !== 'bridge') ctx.logger?.warn?.(`dsh-bridge unavailable: ${mode}`)
  // ……下面所有调用都写 callService('SERVICE', 'METHOD', [args])
}
```

三个不是装饰的细节：

- **用 `invoke`，不用 `call`。** `bridge.call(service, method, ...args)` 只是便捷包装；`invoke` 才让你拿到完整信封并按 `error.code` 分支。
- **`value` 是故意拆一层的。** `service.call` 的信封里是 `value: { service, method, value }`，快照在内层 `value`。`snapshot: true` 表示这份结果过了脱敏与截断——两条路径**不是逐字节等价**，别假装是。
- **版本闸门就是契约检查。** `version >= 2` 才保证有 `policy()`、`allowed` 字段和 deny/method 两道闸；更老的桥会被适配层安静地走原生路径。`version >= 3` 另外保证有 `app.restart` / `app.restartState`——要提供「立即重启」按钮时，按版本号判，不要只看插件在不在。

### 预检这个部署放行了什么

`service.call` 每次仍会自行拒绝，所以预检是可选的。真需要时（设置界面、提前选降级模式），只查能力表与策略，**不要自己复刻闸门逻辑**：

```js
if (usable) {
  const capabilities = bridge.list()          // [{ name, risk, summary }]
  const policy = bridge.policy()              // 已解析的 deny / allow / method 规则
  const reachable = (name) => policy.serviceAllow.length > 0
    ? policy.serviceAllow.includes(name) && !policy.serviceDeny.includes(name)
    : !policy.serviceDeny.some((p) => name === p || name.startsWith(`${p}.`))
}
```

这只是粗筛。**不要**复刻 `methodDeny` 的合并语义（`'*'` 加按服务键）；把判断留给调用本身，按 `method-denied` 分支。

### 错误码 → 怎么处理

| 错误码 | 含义 | 动作 |
|---|---|---|
| `service-denied`、`service-not-allowed`、`method-denied` | 部署策略在动任何东西之前就拒了 | 降级；重试没有意义 |
| `bad-request` | 入参含函数/类实例/超长/循环引用 | 修调用方 |
| `confirmation-required` | 该能力要 `{ confirm: true }` | 补确认，或改走原生服务 |
| `no-such-method`、`no-such-plugin` | 名字写错 | 先 `service.list` / `service.describe` |
| `service-unavailable` | 宿主里确实没有这个服务 | 降级 |
| `timeout`、`breaker-open`、`failed` | 宿主侧故障，会计入熔断 | 退避，别循环打 |

原生路径永远不会给出前两行——没有桥就没有策略层，这也正是降级行为必须由接入方自己负责的原因。

### 等待一个可能稍后出现的桥

`ctx.inject(['dshBridge'], (ctx) => { … })` 会起一个嵌套 fiber，服务可用时才跑回调。但它仍是*必需*语义：服务一直不出现，回调就一直不跑。只适合“有桥就启用某个增量功能”，**不要**拿来当主路径。

### 反例

- 没声明 `inject` 却用 `ctx.dshBridge` → `cannot get property … without inject`。
- 假设 `policy()` / `allowed` / 新错误码一定存在 → 按 `version` 判。
- 想通过桥查桥（`service.call { service: 'dshBridge' }`）→ `service-denied`；桥把自己列在黑名单里。
- 把桥当安全边界（见《诚实的边界》）。
- 为了让桥“一定在”，把它写进接入方的 `dependencies`：profile 是按机器装的，bundle 条目不是你能控制的依赖。

### 验收

**两个** profile 都跑过才算接完：

1. `dsh.profile.bundles` 里没有 `dsh-bridge`：插件照常激活，`mode` 报 `native (not installed)`，兜底返回同样的 `{ ok, via, value }` 形状。
2. 有它：`mode` 是 `bridge`，被拒的服务返回 `service-denied`，长得像凭据的值回来是 `«redacted»`。

## 写配置的两个讲究

`config.edit` 有两种模式，选错了会留下后遗症：

**`patch`（推荐）**——只给要改的字段，桥负责合并：

```js
await bridge.invoke('config.edit', { plugin: 'my-plugin', patch: { retries: 5 }, confirm: true })
```

关键在合并规则。`configEditor` 写的是**完整**配置覆盖，所以最朴素的 `{ ...current, ...patch }` 会把你没碰过的字段也复制进用户的 patch 层，从此 bundle 升级再也够不到它们。桥在这里多做一步：**没被 patch 提到、且当前值仍等于继承值的字段会被丢掉**，交还给 bundle 层。等价于默认值的显式设置因而不留痕迹——反正功能上一样。patch 里写 `undefined` 表示删掉这个键。

**`config`**——完整覆盖，你自己负责把该留的字段都写全。只有确实要「重置成这份配置」时才用。

**先 `dryRun` 一下。** 加 `{ dryRun: true }` 会返回将写入的内容和 `removesOverride` 标记，但一个字节都不落盘。当合并结果恰好等于继承值时，`configEditor` 会直接把整行覆盖删掉——这不是意外，是它内建的「取消覆盖」语义。

还有两条硬约束：**桥不能改自己的行**（那次重载会把当前调用拦腰截断，调用方既拿不到结果也拿不到错误）；**只有根 include 下、id 唯一的条目可编辑**，其余会返回 `no-such-plugin`。写入若被 home patch 或命令行覆盖层压住，`configEditor` 会整体拒绝并保持文件不变，桥把这个错误原样报给你。

## 配置

写在自己的 profile `cordis.patch.yml`，覆盖 bundle 层：

```yaml
- id: dsh-bridge
  config:
    timeoutMs: 15000            # 单次调用上限，超时返回 timeout
    auditLimit: 200             # 审计环形缓冲条数
    auditFile: ~                # 可选：把每次调用追加成一行 JSON 落盘
    confirm: [config.edit, plugin.restart, app.exit, app.restart]
    serviceDeny: [credentials, configEditor, dshBridge, loader, shell, fs, …]   # 硬黑名单，命中即拒
    serviceAllow: []            # 非空即白名单模式；黑名单仍然优先
    methodDeny:                 # 第二道闸，键是服务名或前缀
      '*': [apply, bind, call, constructor, dispose, exec, exit, import, kill, restart, spawn, stop, terminate]
      loader: [commit, create, ensureId, remove, resolveGroup, stop, update]
    breakerThreshold: 5         # 连续几次「宿主侧」失败后熔断
    breakerCooldownMs: 30000    # 熔断冷却多久
    restartOnInstall: true      # 安装/卸载结算为 restart-required 时直接重启，而不是转告用户
    restartOnInstallReasons: [install, remove, plugin, bundle]   # 哪类变更允许自动重启
    relayHeartbeatMs: 4000      # relay 必须在此时间内报活，否则放弃这次重启
    relayDeadlineMs: 120000     # relay 等旧进程消失的上限
    relaySettleMs: 1500         # 旧进程退出后等多久再拉起（躲单实例锁）
    relayRetry: 3               # 拉起失败的重试次数
    restartDelayMs: 250         # 回答调用方之后多久退场
    restartBudget: 3            # 单位时间内最多重启几次（防无限重启）
    restartWindowMs: 300000
    desktopTerminate: true      # 桌面端：没有 IPC 通道可用，重启=杀掉持有窗口的父进程
    restartDryRun: false        # true：只写计划+记账，不拉起、不退出
```

完整默认清单在 `src/policy.js`，bundle 层同一份值写在 `cordis.patch.yml`。要放开某一项，就把整行抄到 profile 里再改那一项——把整个 `serviceDeny` 换成你列的几项，等于把你没列的全部重新打开。

`credentials` 默认在拒绝清单里，不是洁癖：那个服务返回的是明文密钥，一旦经 `service.call` 流到某个插件的结果里，就再没有回收的余地。

`configEditor` 同样在清单里，理由是它**绕关卡**：`config.edit` 有确认、有 dry-run、有不钉默认值的合并，而 `service.call('configEditor', 'edit', …)` 一个都没有，还能直接写进用户的 profile patch。要的就是让这条路只有一条。

`loader` 在清单里，因为它是同一道关卡的另一面：`loader.update` / `create` / `remove` 会经 loader 的 `commit()` 写进 profile patch，`loader.import` 则把任意模块加载进宿主进程。只关 `configEditor` 却留着 `loader`，等于把洞挪了个位置，而不是补上。

`methodDeny` 是为了让「有意的例外」不至于变成新洞：把 `serviceDeny` 改成 `[credentials, configEditor, dshBridge]`（本插件早期版本的默认值）会把 `loader` 重新放开，而按服务配置的规则集依然拒掉它的写方法。注意：你自己写 `methodDeny` 时，`'*'` 键会替换全局默认；只加某个服务键则不会——默认保留，该键只替换那一个服务的清单。

## 安装完成后的重启

plugin-manager 每改一次插件都会广播一条 `plugin-manager/operation`。`application: restart-required`
的含义是：新条目装不进正在跑的进程，得重开。上游对这种情况给出的处理是给 agent 一句话——「告诉用户重启 DSH」。
dsh-bridge 监听那条广播，把这句话换成动作：

1. 写计划（启动什么、cwd 是哪、要等哪个 pid 消失、清哪些环境变量）到 `$DSH_HOME/dsh-bridge/relaunch/`；
2. 用 `process.execPath` 分离拉起 `src/relay.js`（`detached: true` + `unref()`，活得过本进程）；
3. 等 relay 的心跳（`<plan>.hb.json`）：**收不到就整件事作废**，宿主原地不动；
4. 心跳到手，先把信封回答给调用方，再在 `restartDelayMs` 后让本进程退场：
   - web / stdio 宿主：走 `appExit` 优雅退出；
   - 桌面端：宿主是 Electron 的子进程，`DESKTOP_IPC` 没有重启通道，所以退场 = 终止持有窗口的父进程
     （Windows 用 `taskkill /PID <ppid> /F`，其它平台 `SIGTERM`）。这里**故意不用** `appExit`：它只停掉子进程，
     主进程会把子进程再拉起来，窗口就一直对着一个死掉的端口转圈——正是这条路径要避免的失败。
5. relay 等旧 pid 消失、等过 `relaySettleMs`（让单实例锁释放），再用**清掉 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`**
   的环境拉起新实例。

第 5 步为什么非清不可：桌面端宿主跑在 Electron 的 node 模式里，环境带 `ELECTRON_RUN_AS_NODE=1`；继承它的子进程
用同一个 exe 启动，却会以纯 node 模式跑——不开窗口、跑完即退，而日志里写着「已重启」。

三道限制：`restartBudget` / `restartWindowMs`（默认 5 分钟 3 次）挡住「装不上的包 → 每次开机再重启」的循环；
`changed: false` 的结算不重启（磁盘上什么都没变，没有可应用的）；`restartDryRun: true` 只写计划、只记账，
适合先看它打算干什么。想手工触发同一条链路，用 `app.restart`（需 `{ confirm: true }`）；`app.restartState`
给出这台宿主的退场方式、剩余预算和 relay 日志尾巴。运行态文件都在 `$DSH_HOME/dsh-bridge/`：
`relay.log`、`restart-ledger.json`、`relaunch/*.plan.json`。

**重启没生效时先看 `relay.log`。** 宿主在退场前会写一行 `[host:shutdown] terminate <pid> → ok=…`，
relay 若发现目标还活着会在 900ms 后自己再杀一次并写 `[relay:killed] … ok=…`。`ok=false` 后面的括号就是
Windows 给的原因（最常见是 `Access is denied`）；只有 `parent-exited` 才是「旧应用真的开始退了」。

这条链路上有两个错误码不属于 `service.call`，但含义都是「宿主没事」：

- `restart-budget` —— `restartWindowMs` 窗口内已经用掉 `restartBudget` 次；等窗口过去再试。
- `relay-unavailable` —— relay 没有心跳，**所以什么都没被杀掉**；等环境允许时重试即可。

`bridge.restart(reason)` 是同一件事的一行写法：它自动带上 `{ confirm: true }`，回执与 `app.restart` 相同。

## 安装

用 Harness 自带的 Plugin Manager（Creator 模式下）：

```js
plugin_manager({ action: 'install_bundle', target: 'D:/project/qujinting/dsh-plugins/dsh-bridge' })
```

`application: applied` 才算真的生效。之后用 `cordis_inspect_query` 确认 `dshBridge` 已经提供——不要靠看日志或猜。

手动挂载也可以，把 `cordis.patch.yml` 里的 `insert` 行抄进 profile 的 patch 层即可。

## 诚实的边界

**桌面端的重启是「杀掉持有窗口的进程」，不是优雅退出。** 应用重启握在 Electron 主进程手里：`resources/app/lib/main.js` 的 `DESKTOP_IPC` 表里没有任何重启通道，`windowsMenu` 只是弹菜单，`restartAppHostMenu` 只在 `development` 构建里挂出来。插件层面无论 Host 还是 Client 都够不到它。所以 `app.restart` 在桌面端做的是：先让分离的 relay 活起来并报心跳，再终止持有窗口的父进程——**故意忽略 `appExit`**，因为它只会停掉宿主子进程，窗口会对着已经消失的端口一直重连；最后由 relay 拉起新实例。代价是主进程不走退出流程——飞行中的请求、渲染层未落盘的状态会丢。web / stdio 宿主不受这条限制：`appExit` 就能优雅退出。`plugin.restart` 重载的是**插件**，走 `fiber.restart()`——HMR 和配置编辑器用的是同一套机制。

**`service.call` 是最强的一种耦合。** 它让调用方不必知道服务名，但也让「调了什么」变成了运行期行为，编译期无从检查。建议只在 `service.list` / `service.describe` 探明之后使用，并且把能力包进你自己的薄封装里——像上面示例那样，一个方法一个封装，别让业务代码直接散落 `bridge.call`。

**它是治理层，不是沙箱。** 同一棵树里的任何插件本来就能直接 `ctx.get('shell')`：cordis 按名字解析服务，不要求声明 `inject`。`dshBridge` 并没有给出一项原本不存在的能力，它做的是让「伸手」变得**可发现**（一张表、一套策略）和**可观测**（确认、超时、熔断、审计）。把它当成你写的插件统一走的那扇被审查过的门——而不是用来关住恶意插件的边界，进程内做不到这件事。

**`fiber.restart()` 会重建插件状态。** 内存里的东西全丢，`apply` 重跑一遍。如果目标插件持有没有落盘的队列或缓存，重载就是丢数据。调用前想清楚。

## 依据

这些东西不是猜的，都能在本机安装里核对：

| 结论 | 位置 |
|---|---|
| 插件形态：`export function apply(ctx, config)` + `export const inject` | `resources/app/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md` |
| `fiber.restart()` 语义：销毁并用当前配置重载 | `.../cordis/lib/index.js:738` |
| `ctx.provide(name, value)` 注册服务并随 fiber 回收 | `.../cordis/lib/index.js:1384` |
| `loader` 服务由 loader 插件提供，可枚举条目 | `.../cordis-plugin-loader/lib/index.js:739` |
| `appExit` 由启动器 provide，插件通过 `ctx.get` 取用 | `.../dsh-cmdline/lib/index.js:30` |
| `configEditor.configuration()` 给出可编辑条目 + 继承值 + 当前覆盖 | `.../dsh-config-editor/lib/index.js:41` |
| `configEditor.edit(entry, change)` 的「等于继承值即删行」语义 | `.../dsh-config-editor/lib/index.js:98` |
| `loader` 的写方法经 `commit()` 落盘到 profile patch | `.../dsh-app-boot/lib/index.js:806`、`.../cordis-plugin-loader/lib/index.js:293` |
| 桌面端没有重启 IPC 通道 | `resources/app/lib/main.js:1445-1477` |
| plugin-manager 把结算记录用 `parallel()` 广播成 `plugin-manager/operation` | `.../dsh-plugin-manager/lib/index.js:3213` |
| 上游「需要重启」的文案就是 `nextStep: Tell the user to restart DSH…` | `.../dsh-plugin-manager/lib/types/tools.js:57` |
| cordis 全树共用同一个 EventsService，兄弟插件的监听也收得到 | `.../cordis/lib/index.js:1759`、`1776`（`extend()` 走原型继承） |
| 桌面宿主是 Electron 的子进程，仅认 `shutdown` / `ready` / `fatal` 等 IPC 消息 | `.../dsh-desktop-host/lib/index.js:489`、`resources/app/lib/main.js:10007` |
| `ELECTRON_RUN_AS_NODE=1` 会随宿主环境传给子进程 | `resources/app/lib/main.js:9748` |
| 扩展点选择与升级稳定性原则 | `.../skills/cordis-plugin-development/references/practices.md` |

## 开发

```bash
npm run check   # 八个模块的语法检查
npm test        # 81 个用例：单元 + 对抗 + 真实 cordis 集成 + relay 干跑 + 停机 + 终止
```

`test/hardening.test.mjs` 是边界本身（默认黑名单、白名单模式、方法级闸门、入参校验、值脱敏、审计落盘）的回归集；`test/real-cordis.test.mjs` 会从安装目录（`DSH_APP_ROOT`，默认 `D:/apps/DSH/resources/app/dsh`）里真的拉一个 `Context` 起来跑同一批能力，装不到时自动跳过。`test/shutdown.test.mjs` 钉住「重启到底杀谁」——桌面端是窗口所有者，其它宿主走 `appExit`；`test/process-kill.test.mjs` 直接杀掉一个真实子进程来验证，而不是给 `taskkill` 打桩。

其余测试跑在手写的假上下文上，它只实现 `get / provide / effect / reflect.props / fiber.restart / logger`——这本身也是一句承诺：如果哪天插件需要更多框架能力，就说明它耦合得比宣称的更深了。

依赖为零，不 import 任何 `@deepseek-ai/*`：profile 里安装的插件解析不到它们，而这个包要能扛过一次 harness 升级。

## 还没做

- `config.read`：把某个插件当前的配置与继承值读出来。技术上很容易，但它会把配置里可能存在的密钥送过边界，得先在脱敏上想清楚。
- `event.emit` / waterfall 注入：比 `service.call` 更危险，因为能改变别人的执行流。要用的话应该作为独立能力，配独立白名单。

## License

MIT
