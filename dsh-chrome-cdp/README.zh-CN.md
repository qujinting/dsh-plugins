# dsh-chrome-cdp

[English](README.md) | 简体中文

给每个 DSH 会话装上「亲眼看页面」的能力，不需要谁先开口要求。

它把一个原生工具 **`chrome_cdp`**、一个内嵌的 **`chrome-cdp` skill**、以及一条 **system prompt 路由规则**
一起注册进 DSH，用本机已装的 Chrome 走 CDP 打开页面、量真实盒模型、截图，再交给 `read_image` 亲眼看。
**不装 Playwright / Puppeteer，不需要任何 npm 依赖，也绝不动用户正在用的浏览器实例与登录态。**

## 为什么需要它

在 Web / Desktop profile 里，skill 目录是**由 agent preset 挂载的 `skill-filesystem` provider 供给的**，
而不是 profile 顶层的行（`dsh-web-app` 明确把 host 层的 `skill-filesystem` 和 `tool-skill` 关掉了）。
于是「在 `~/.dsh/AGENTS.md` 里写一句 *需要看页面就加载 skill chrome-cdp*」这条路，
取决于 provider 当次是否顺利跑完：

- `dsh-tool-skill` 只在 `ctx.skills.snapshot({scope}).complete === true` 时才发布 skill 目录；
- 任何一个 provider 的 `list()` 抛错，整个观察就被标记为 **incomplete**，**一个目录都不会发布**；
- 结果是：AGENTS.md 指向一个模型根本看不到的 skill，**不报错、不提示，只是永远不生效**。

本插件不再依赖这条链：能力由插件自己带着走。

## 三个面

| 面 | 作用 | 为什么需要 |
|---|---|---|
| 工具 `chrome_cdp` | 打开 / 测量 / 截图，一次调用完成 | **工具每一步都在请求目录里**；skill 只有在模型决定去查时才被想起。这是「自动」的来源 |
| skill `chrome-cdp` | 完整 playbook：测量判据、登录、暗色、踩坑表 | 注册进 skill registry 的 **global 层**，不受 preset、目录布局、frontmatter 解析影响 |
| prompt section | 一条简短的触发规则 | 换台机器、丢了 `AGENTS.md` 也照样触发 |

## 安装

```bash
# 在 DSH 的 Plugins 页面里，或让 agent 调用 plugin_manager：
plugin_manager install_bundle  target=link:D:/project/qujinting/dsh-plugins/dsh-chrome-cdp
```

等价的 profile 改动（`~/.dsh/profiles/<profile>/package.json`）：

```json
{
  "dsh": { "profile": { "bundles": ["...", "dsh-chrome-cdp"] } },
  "dependencies": { "dsh-chrome-cdp": "link:D:/project/qujinting/dsh-plugins/dsh-chrome-cdp" }
}
```

改完即生效（live profile 会重新 compose），无需重启。

## 用法

```
chrome_cdp({ url: 'http://localhost:5173/', script: 'JSON.stringify({ vw: innerWidth, vh: innerHeight })' })
```

一次调用就能同时拿到 **数字** 和 **截图**：

```
<url>http://localhost:5173/</url>
<title>我的应用</title>
<measure>
{"vw":1600,"vh":1000,"boxes":{...}}
</measure>
<screenshot>
D:\work\app\.dsh\chrome-cdp\2026-10-12_14-30-00-localhost-5173.png
</screenshot>
Open that PNG with the read_image tool and judge it by eye before reporting a result.
```

> **只看 JSON 数字会漏掉「尺寸对了但观感不对」的问题。** 拿到路径后务必 `read_image` 看一眼。

### 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `url` | — | 必填，绝对 http(s) / file URL |
| `script` | — | 页面里跑的 JS；表达式或含 `return` 的语句体。建议返回 `JSON.stringify(...)` |
| `waitForSelector` | — | 等某个 CSS 选择器出现，比写死延时可靠 |
| `waitMs` | `1200` | load 之后再等的毫秒数 |
| `dark` | — | `true` 加 `<html class="dark">` 并模拟 `prefers-color-scheme: dark`；`false` 反之 |
| `screenshot` | `true` | 纯测量可关掉 |
| `viewportWidth` / `viewportHeight` | `1600` / `1000` | 模拟视口，用于断点验收 |
| `outPath` | `<工作区>/.dsh/chrome-cdp/<时间戳>-<slug>.png` | 截图落盘位置 |
| `headless` | `true` | 页面在 headless 下不肯渲染时可设 `false` 盯着看 |
| `timeoutMs` | `60000` | 单次调用总预算 |

## 配置

`cordis.patch.yml` 里 `config: {}` 即默认行为，字段全部可选：

| 字段 | 默认 | 说明 |
|---|---|---|
| `browserPath` | 自动探测 | Chrome / Edge 可执行文件路径；探测顺序见 `src/cdp.js` |
| `toolName` | `chrome_cdp` | 注册的工具名 |
| `headless` | `true` | `headless` 参数的默认值 |
| `timeoutMs` | `60000` | 单次调用默认预算 |
| `profileRoot` | `<系统临时目录>/dsh-chrome-cdp` | 每次调用创建的临时 profile 根目录 |
| `screenshotDir` | `<工作区>/.dsh/chrome-cdp` | 截图默认目录 |
| `registerSkill` | `true` | 是否注册内嵌 skill |
| `registerPromptSection` | `true` | 是否注册 prompt 路由段 |

例：钉死浏览器并关掉 prompt 段

```yaml
- id: chrome-cdp
  config:
    browserPath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'
    registerPromptSection: false
```

## 实现要点

- **零依赖**：CDP 客户端直接用 Node 内置的 `fetch` + `WebSocket`（Node ≥ 22）。
  本包 **不 import 任何 `@deepseek-ai/*`**——profile 里装的插件本来也解析不到它们。
- **`--remote-debugging-port=0` + `DevToolsActivePort`**：让浏览器自己挑端口，
  既不会撞端口，也只有在浏览器真的起来之后才拿得到端口。
- **独立临时 profile**：不加 `--user-data-dir` 的话，Chrome 已在运行时会去现有实例开个 tab 就退出，
  调试端口永远不出现——这是踩过最多的坑。
- **一定收尾**：`stdio: 'ignore'`（受限沙箱下 piped stdio 可能被拒），
  Windows 上用 `taskkill /T /F` 连渲染进程一起带走，然后删掉临时 profile。

## 自检

```bash
npm test        # 用本地 fixture 跑通测量 / 视口 / 暗色 / 报错 / 无残留
npm run check   # 语法检查
```

## License

MIT
