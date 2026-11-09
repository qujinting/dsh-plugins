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

调用统一返回信封，**能力失败不抛异常**，只有参数写错才会——调用方只需要判断 `ok`：

```js
{ ok: true,  capability: 'service.call', caller: 'my-plugin', at: 1794203342454, ms: 3, value: { /* … */ } }
{ ok: false, capability: 'service.call', caller: 'my-plugin', at: 1794203342454, ms: 1, error: { code: 'service-denied', message: '…' } }
```

错误码固定为这几个，可以直接分支：`unknown-capability`、`confirmation-required`、`breaker-open`、`timeout`、`service-denied`、`service-not-allowed`、`method-denied`、`service-unavailable`、`no-such-method`、`no-such-plugin`、`bad-request`、`failed`。

## 四条硬规则

**1. 破坏性动作必须显式确认。** `config.edit`、`plugin.restart` 和 `app.exit` 出现在 `confirm` 清单里，调用方必须传 `{ confirm: true }`，否则只拿到 `confirmation-required`，宿主毫发无损。这条护栏是防止「agent 循环重试」把自己连着重启三次的那种事故。

**2. 先给回执，再动生命周期。** 重载和退出都推到下一个 tick 执行。原因很实在：如果插件在自己的调用栈里同步重启自己，调用方会在半路被掐断——既没有结果，也没有错误，日志断在一半。所以这类能力返回的是 `{ accepted: true, deferred: true }`，不是结果。

**3. 默认可达集合是「惰性」的。** `serviceDeny` 默认关掉进程执行（`shell`/`subprocess`/`terminals`）、文件系统（`fs`/`workspace*`）、插件生命周期与持久化（`loader`/`hmr`/`pluginManager`）、以及存放密钥和用户数据的服务（`credentials`/`settings`/`storage`/`deepseekAccount`），再加上 `configEditor` 和桥自身。`serviceAllow` 非空时把问题反过来问：只有列出的服务可达。`methodDeny` 是按服务名（`*` 表示全部）的第二道闸——为某个部署把 `loader` 放回白名单，并不会连带把 `loader.update` / `loader.import` / `loader.remove` 一起交出去。另外，策略性拒绝不进熔断计数：服务名敲错不代表宿主坏了。

**4. 数据两个方向都只走数据。** 返回值经 `serialize.js`：函数变成名字、循环在深度 3 截断（但仍报出字段名）、超过 32 项的集合带 `truncated` 标记，**字段名命中 `apiKey / secret / token / password / credential / authorization` 的值一律替换成 `«redacted»`，长得像凭据的字符串同样替换**（`sk-…`、`ghp_…`、`xox…-`、`AKIA…`、JWT）。入参是同一条规则的镜像：`service.call` 只接受可结构化克隆的纯数据。函数入参正是调用方绕开所有方法级检查、把回调塞进宿主的方式（`loader.import(name, getOuterStack)` 就收一个），而活对象入参会让它把宿主状态的引用带出调用之后。

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
    confirm: [config.edit, plugin.restart, app.exit]
    serviceDeny: [credentials, configEditor, dshBridge, loader, shell, fs, …]   # 硬黑名单，命中即拒
    serviceAllow: []            # 非空即白名单模式；黑名单仍然优先
    methodDeny:                 # 第二道闸，键是服务名或前缀
      '*': [apply, bind, call, constructor, dispose, exec, exit, import, kill, restart, spawn, stop, terminate]
      loader: [commit, create, ensureId, remove, resolveGroup, stop, update]
    breakerThreshold: 5         # 连续几次「宿主侧」失败后熔断
    breakerCooldownMs: 30000    # 熔断冷却多久
```

完整默认清单在 `src/policy.js`，bundle 层同一份值写在 `cordis.patch.yml`。要放开某一项，就把整行抄到 profile 里再改那一项——把整个 `serviceDeny` 换成你列的几项，等于把你没列的全部重新打开。

`credentials` 默认在拒绝清单里，不是洁癖：那个服务返回的是明文密钥，一旦经 `service.call` 流到某个插件的结果里，就再没有回收的余地。

`configEditor` 同样在清单里，理由是它**绕关卡**：`config.edit` 有确认、有 dry-run、有不钉默认值的合并，而 `service.call('configEditor', 'edit', …)` 一个都没有，还能直接写进用户的 profile patch。要的就是让这条路只有一条。

`loader` 在清单里，因为它是同一道关卡的另一面：`loader.update` / `create` / `remove` 会经 loader 的 `commit()` 写进 profile patch，`loader.import` 则把任意模块加载进宿主进程。只关 `configEditor` 却留着 `loader`，等于把洞挪了个位置，而不是补上。

`methodDeny` 是为了让「有意的例外」不至于变成新洞：把 `serviceDeny` 改成 `[credentials, configEditor, dshBridge]`（本插件早期版本的默认值）会把 `loader` 重新放开，而按服务配置的规则集依然拒掉它的写方法。注意：你自己写 `methodDeny` 时，`'*'` 键会替换全局默认；只加某个服务键则不会——默认保留，该键只替换那一个服务的清单。

## 安装

用 Harness 自带的 Plugin Manager（Creator 模式下）：

```js
plugin_manager({ action: 'install_bundle', target: 'D:/project/qujinting/dsh-plugins/dsh-bridge' })
```

`application: applied` 才算真的生效。之后用 `cordis_inspect_query` 确认 `dshBridge` 已经提供——不要靠看日志或猜。

手动挂载也可以，把 `cordis.patch.yml` 里的 `insert` 行抄进 profile 的 patch 层即可。

## 诚实的边界

**它重启不了桌面应用。** 这是设计约束，不是没做完。应用重启握在 Electron 主进程手里（`resources/app/lib/main.js` 的 `DESKTOP_IPC` 表里没有任何重启通道，`windowsMenu` 只是弹菜单），插件层面无论 Host 还是 Client 都够不到。`plugin.restart` 重载的是**插件**，走 `fiber.restart()`——这也是 HMR 和配置编辑器在用的同一套机制。

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
| 扩展点选择与升级稳定性原则 | `.../skills/cordis-plugin-development/references/practices.md` |

## 开发

```bash
npm run check   # 四个模块的语法检查
npm test        # 57 个用例：单元 + 对抗 + 真实 cordis 集成
```

`test/hardening.test.mjs` 是边界本身（默认黑名单、白名单模式、方法级闸门、入参校验、值脱敏、审计落盘）的回归集；`test/real-cordis.test.mjs` 会从安装目录（`DSH_APP_ROOT`，默认 `D:/apps/DSH/resources/app/dsh`）里真的拉一个 `Context` 起来跑同一批能力，装不到时自动跳过。

其余测试跑在手写的假上下文上，它只实现 `get / provide / effect / reflect.props / fiber.restart / logger`——这本身也是一句承诺：如果哪天插件需要更多框架能力，就说明它耦合得比宣称的更深了。

依赖为零，不 import 任何 `@deepseek-ai/*`：profile 里安装的插件解析不到它们，而这个包要能扛过一次 harness 升级。

## 还没做

- `config.read`：把某个插件当前的配置与继承值读出来。技术上很容易，但它会把配置里可能存在的密钥送过边界，得先在脱敏上想清楚。
- `event.emit` / waterfall 注入：比 `service.call` 更危险，因为能改变别人的执行流。要用的话应该作为独立能力，配独立白名单。

## License

MIT
