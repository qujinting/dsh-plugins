/**
 * The `chrome-cdp` skill, embedded in the plugin rather than discovered on disk.
 *
 * A filesystem skill only reaches a session when the profile's skill provider
 * finds it, and that provider sits behind the agent preset: one unreadable root
 * or one throwing provider silently empties the whole catalog, and the model is
 * left with an instruction in AGENTS.md that points at a skill it cannot load.
 * Registering the skill into the registry's global layer instead means every
 * session sees it, whatever preset it runs and wherever the user's `skills`
 * directory happens to be.
 *
 * @module dsh-chrome-cdp/skill
 */

/** Catalog description, capped by `dsh-tool-skill` before it reaches the model. */
const DESCRIPTION = [
	'Look at what a page actually renders, using this machine\'s own Chrome over the DevTools Protocol.',
	'Opens the URL, measures the real box model, and captures a PNG you then inspect with read_image.',
	'Use it for visual acceptance of a front-end change (layout, spacing, dark mode, responsive breakpoints),',
	'for any "look at it yourself" request, and whenever a rendering claim is cheaper to verify than to argue about.',
	'No Playwright, no Puppeteer, no dependency installs, and never the user\'s own browser session.',
].join(' ')

/** The full playbook, returned when the model loads the skill. */
const CONTENT = `# 用本机 Chrome 看页面（CDP）

## 0. 先决事实（不要重新调研）

- 本插件已经注册了一个原生工具 **\`chrome_cdp\`**，一次调用即可完成「打开 → 测量 → 截图」。
  **优先用它**；只有它不够用时才回退到 §4 的手写探针。
- 不装任何依赖：本机已装的 Chrome + Node 内置 \`fetch\`/\`WebSocket\` 就够了。
  不要为了看页面去装 Playwright / Puppeteer。
- 安全边界：每次调用都用一个独立的临时 profile，跑完立刻 kill Chrome；
  绝不碰用户正在使用的浏览器实例与登录态。

## 1. 何时用

用：前端改完要看效果；验收布局 / 间距 / 暗色 / 响应式；用户说"你自己看 / 截图给我看 / 布局不对"；
需要把断言变成证据（例："页面没有滚动条" → 量 \`scrollHeight <= clientHeight\`，而不是靠猜）。

不用：需要用户本人登录态的高权限操作；纯接口 / 命令行验证（curl / pwsh 更直接）。

## 2. 标准流程

1. 调 \`chrome_cdp\`，带上 \`url\`，并用 \`script\` 一次拿全测量结果（返回 \`JSON.stringify(...)\`）。
2. 读结果里的 \`measure\`，拿到真实盒模型。
3. **必须**用 \`read_image\` 打开结果里的 \`screenshotPath\` 亲眼看一眼——
   只看 JSON 数字会漏掉"尺寸对了但观感不对"的问题。
4. 改代码 → 重跑。dev server 有 HMR，改源码即可，通常不用重新 build。

测量脚本示例（一次拿全，避免多次往返）：

\`\`\`js
JSON.stringify({
  vw: innerWidth, vh: innerHeight,
  boxes: Object.fromEntries(
    ['.app-main', '.card', '.toolbar'].map((s) => {
      const e = document.querySelector(s)
      if (!e) return [s, null]
      const r = e.getBoundingClientRect(), c = getComputedStyle(e)
      return [s, {
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
        pad: c.padding, mar: c.margin, gap: c.gap,
        display: c.display, flex: c.flex, dir: c.flexDirection,
        maxW: c.maxWidth, minH: c.minHeight, ovf: c.overflow,
        scrollH: e.scrollHeight, clientH: e.clientHeight,
      }]
    }),
  ),
  pageScrollbar: (() => {
    const sc = document.querySelector('.app-main') || document.scrollingElement
    return sc.scrollHeight > sc.clientHeight
  })(),
})
\`\`\`

判据：

- **页面级滚动条**：滚动容器（很多后台是 \`.app-main\`）\`scrollHeight > clientHeight\` 才算有；
  \`document.scrollingElement\` 再看一遍。
- **撑满 / 等高**：比较两列的 \`h\` 是否相等、\`y + h\` 是否贴到底。
- **间距统一**：比较各块 \`pad\`/\`mar\`/\`gap\` 是否来自同一个设计令牌，而不是各写一套。
- **表格内部滚动**：表格 body 包装层 \`scrollH > clientH\`，同时外层容器不滚。

## 3. 工具参数速查

| 参数 | 作用 |
|---|---|
| \`url\` | 必填，绝对 http(s) / file URL |
| \`script\` | 页面里要跑的 JS，表达式或含 \`return\` 的语句体；建议返回 \`JSON.stringify(...)\` |
| \`waitForSelector\` | 等某个 CSS 选择器出现，比拍脑袋写死延时可靠 |
| \`waitMs\` | load 之后再等的毫秒数（默认 1200） |
| \`dark\` | 加 \`<html class="dark">\` 并模拟 \`prefers-color-scheme: dark\` |
| \`viewportWidth\` / \`viewportHeight\` | 模拟视口（默认 1600x1000），用于断点验收 |
| \`screenshot\` | 是否截图（默认 true）；纯测量可关 |
| \`outPath\` | 截图落盘位置（默认 \`<工作区>/.dsh/chrome-cdp/<时间戳>-<slug>.png\`） |

## 4. 回退：手写 CDP 探针

只有当 \`chrome_cdp\` 满足不了时（需要多个页面、需要长驻会话、需要 CDP 里更底层的域）才走这条路。
把探针写到工作区的 scratch 目录（如 \`.dsh/proto-scratch/\`），用 \`node <探针>.mjs\` 跑。

骨架：

\`\`\`js
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'

const EXE = process.env.HEADLESS_EXE
const PORT = Number(process.env.CDP_PORT || 9333)
const OUT = 'D:/path/to/scratch/'
const W = Number(process.env.VW || 1600), H = Number(process.env.VH || 1000)

const child = spawn(EXE, [
  '--headless=new',
  '--remote-debugging-port=' + PORT,
  '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + os.tmpdir() + '/dsh-cdp-profile',
  '--window-size=' + W + ',' + H, '--force-device-scale-factor=1',
  'about:blank'
], { stdio: 'ignore', detached: true })

let version = null
for (let i = 0; i < 80; i++) { try { version = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); break } catch { await sleep(250) } }
if (!version) { console.log('ERROR=no-cdp-endpoint'); child.kill(); process.exit(1) }

const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
let seq = 0; const pending = new Map()
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (m, p = {}, sid) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method: m, params: p, ...(sid ? { sessionId: sid } : {}) })) })

const t = await send('Target.createTarget', { url: process.env.URL || 'http://localhost/' })
const at = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true })
const sid = at.result.sessionId
await Promise.all([send('Runtime.enable', {}, sid), send('Page.enable', {}, sid)])
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sid)
await sleep(3500)

const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid)).result?.result?.value
console.log('MEASURE=' + await ev('JSON.stringify({ vw: innerWidth, vh: innerHeight })'))
const shot = await send('Page.captureScreenshot', { format: 'png' }, sid)
fs.writeFileSync(OUT + 'shot.png', Buffer.from(shot.result.data, 'base64'))
console.log('SHOT=' + OUT + 'shot.png')
try { ws.close() } catch {}
try { child.kill() } catch {}
process.exit(0)
\`\`\`

**登录**：不要盲目 \`Input.insertText\`——很多登录页（含若依）**已预填**账号密码，追加会拼成 \`adminadmin\`。
先读值，只在为空时补输入，再点登录并**轮询成功标志**：

\`\`\`js
const vals = await ev("JSON.stringify([...document.querySelectorAll('input')].map(i => i.type + '|' + i.value))")
for (let i = 0; i < 20; i++) {
  await ev("[...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '登录')?.click()")
  await sleep(1500)
  if (await ev("!!document.querySelector('.navbar')")) break
}
\`\`\`

凭据优先问用户或查项目文档；若依默认 \`admin/admin123\`（仅本机开发环境）。

**暗色 / 浅色**：别去点 UI 开关，直接切根类名最快：
\`await ev("document.documentElement.classList.add('dark'); 'x'")\`（浅色 \`remove('dark')\`）。
有的项目用 localStorage 记忆（如 \`vueuse-color-scheme\`），两种都试一下再截图。

**精确视口**：用 \`Emulation.setDeviceMetricsOverride\`，不要只靠 \`--window-size\`（受窗口边框 / 缩放影响）。

## 5. 实测踩过的坑

| 症状 | 原因 | 处置 |
|---|---|---|
| \`ERROR=no-cdp-endpoint\` | 复用了默认 profile / Chrome 已在运行 | 必须加 \`--user-data-dir=<临时目录>\` |
| 登录后仍停在 /login | 预填值被 \`insertText\` 追加成 \`adminadmin\` | 先读值，只在为空时输入 |
| JSON 解析失败 | stdout 里 JSON 前后还夹着别的输出 | 用 \`MEASURE=\` / \`SHOT=\` 标记包住，按标记切分再解析 |
| 截图全白 / 空 | 截图早于渲染 | 用 \`waitForSelector\` 轮询关键元素，别只靠固定延时 |
| 元素被裁 / 高度算不对 | 只有 \`height:100%\` 而祖先链没有确定高度 | 逐层量 \`clientH\`，把某层定高 |
| 子块"填不满" | 交叉轴上的 \`margin: auto\` 会**压掉** \`align-items: stretch\`，元素退化成内容宽度 | 给该元素显式 \`width: 100%\` |
| 改了 CSS 页面没变 | 看的是构建产物不是 dev server | 确认访问 dev server 端口（Vite 有 HMR），否则重新 build |

## 6. 收尾

- \`chrome_cdp\` 自己会 kill Chrome 并清理临时 profile；手写探针则要 \`ws.close()\` + \`child.kill()\`。
- 截图放在工作区里（默认 \`.dsh/chrome-cdp/\`），并在最终回复里给出路径（可用 \`present\` 展示）。
- 探针参数化（URL / 视口 / 暗色 / 选择器 走 env），一次写好可长期复用。
`

/** The runtime skill registration handed to `ctx.skills.register`. */
export const CHROME_CDP_SKILL = {
	name: 'chrome-cdp',
	description: DESCRIPTION,
	whenToUse: [
		'用户抱怨界面不对、要求看效果、要求验收布局 / 间距 / 暗色 / 响应式，',
		'或只靠源码无法判断渲染结果时使用。',
		'不适用于需要用户本人登录态的高权限操作；也不要为了看页面先去安装浏览器自动化依赖。',
	].join(''),
	/** Non-empty so the registry accepts the definition; the real provenance is the provider label. */
	source: 'dsh-chrome-cdp',
	content: CONTENT,
}
