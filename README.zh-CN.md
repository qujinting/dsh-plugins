# dsh-plugins

[English](README.md) | 简体中文

**DSH**（DeepSeek Harness）的插件集合。每个目录都是一个独立、可安装的 bundle：放进一个 profile，Harness 就会把它挂起来。

Harness 建在 [cordis](https://github.com/cordisjs/cordis) 之上，「一切皆插件」在这里是字面意思——这些包就是那句话的实践，从一个浏览器工具到一个主题，再到一只桌宠。

## 这里有什么

| 插件 | 做什么 | 你可能为什么需要它 |
|---|---|---|
| [`dsh-bridge`](dsh-bridge/) | 宿主能力的统一入口：`service.list` / `service.describe` / `service.call` / `plugin.list` / `config.edit` / `plugin.restart` / `app.exit`，带确认、超时、熔断与审计环形缓冲 | 你在写插件，不想再猜内部服务名；或者想要一条可以安全调用的重启路径 |
| [`dsh-chrome-cdp`](dsh-chrome-cdp/) | 注册原生工具 `chrome_cdp`、内嵌技能和一条 prompt 路由段，用本机自己的 Chrome 走 CDP | agent 需要**真的看一眼**页面——量盒模型、截图——不装 Playwright、不装 Puppeteer，也不动你正在用的浏览器 |
| [`dsh-desktop-pet`](dsh-desktop-pet/) | Web GUI 里的 Live2D 桌宠：可拖动、跟随鼠标、点击有反应、跟着会话相位换动作 | 你想让 Harness 有张脸。自带 DS鲸鱼娘（8 组动作、44 个表情） |
| [`dsh-secret-broker`](dsh-secret-broker/) | 在界面里以「键 → 值」录入密钥，会话只看到**键名**，值在命令真正执行的那一刻被注入子进程 | 你受够了把 token 贴进会被记录、被索引、被备份的对话里 |
| [`dsh-theme`](dsh-theme/) | DeepSeek Blue 主题：单一色相、按明度分层的深空界面，4K 进场影片，循环人物壁纸 | 默认的样子不是你的，而你想让它变成你的 |
| [`dsh-web-search`](dsh-web-search/) | `ctx.web` 搜索供应商，用你当前选中的模型联网搜索，走网关自带的搜索工具 | 内置供应商把模型写死、只花 DeepSeek 官方额度；这个跟随你的选择，跑在你自己的网关上 |

## 安装

每个插件都是 bundle。通用的做法，用内置插件管理器（dsh 0.1.7+ / 0.2.x）：

```powershell
dsh plugin --profile desktop add file:D:/project/qujinting/dsh-plugins/dsh-chrome-cdp
```

或者，在 Creator 模式下的会话里：

```js
plugin_manager({ action: 'install_bundle', target: 'D:/project/qujinting/dsh-plugins/dsh-chrome-cdp' })
```

每个插件自己的 README 里有它针对那个 profile 的准确步骤、配置字段、以及装完之后该核对什么——有的要重启，有的只要刷新页面。装之前先读那篇；尤其 `dsh-web-search` 还要改 `web.searchProvider`，它的 bundle patch 会替你改。

## 约定

- **目录名等于包名**，统一 `dsh-` 前缀。路径与清单之间不需要任何翻译。
- **不 import 任何 `@deepseek-ai/*`。** 装进 profile 的插件解析不到 Harness 自己的包，所以这里每个包都零依赖，能扛过一次 harness 升级。宿主提供基座模块表的地方（浏览器半边）就用它，而不是自己打一份进去。
- **双语文档。** `README.md` 是英文，`README.zh-CN.md` 是简体中文，两者首行互挂链接。
- **测试不需要 Harness。** 能独立测试的包都带一个用假上下文打桩的 `npm test`，所以改动在装进去之前就能验证。
- **边界写清楚。** 如果某件事做不到——被宿主重启的插件、Electron 外壳没有暴露的能力——README 会直说并解释为什么，而不是含糊带过。

## 开发

每个目录自成一体，`cd` 进你要动的那一个：

```bash
npm test        # 该包带测试的话
npm run check   # 该包定义了语法检查的话
```

需要 Harness 模块闭包的测试（比如 `dsh-web-search`）有自己的抽取脚本，做法写在那个包的 README 里。

## 许可

各包独立，均为 MIT——每个目录带自己的 `LICENSE`。

有两处例外值得知道，都在 [`dsh-desktop-pet`](dsh-desktop-pet/)：

- 随包的 **DS鲸鱼娘** 模型与美术资源（`assets/pet/`、`icon.png`）是 **CC BY-NC-SA 4.0**：署名 · **非商业** · 相同方式共享。版权链见 [`assets/pet/LICENSE`](dsh-desktop-pet/assets/pet/LICENSE) 与 [`NOTICE.md`](dsh-desktop-pet/NOTICE.md)。
- **Live2D Cubism Core** 是 Live2D 株式会社的专有运行时，这里**不随包分发**；插件在首次使用时自行获取。
