# dsh-chrome-cdp

English | [简体中文](README.zh-CN.md)

Give every DSH session the ability to look at a real page with its own eyes — without anyone having to ask for it first.

It registers three things into DSH together: a native tool **`chrome_cdp`**, an embedded **`chrome-cdp` skill**, and a short **system-prompt routing rule**. Together they open a page in the Chromium browser already installed on the machine over CDP, measure real box models, take a screenshot, and hand the PNG to `read_image` for an actual look. **No Playwright, no Puppeteer, no npm dependencies — and never the user's running browser instance or its login state.**

## Why it exists

In a Web/Desktop profile, the skill catalog is supplied by the `skill-filesystem` provider mounted by the agent preset, not by a row at the profile root (`dsh-web-app` explicitly disables the host-level `skill-filesystem` and `tool-skill`). So the common workaround — write *"when you need to see a page, load the chrome-cdp skill"* into `~/.dsh/AGENTS.md` — depends on whether that provider happened to complete this time:

- `dsh-tool-skill` publishes the skill catalog only when `ctx.skills.snapshot({ scope }).complete === true`;
- if any provider's `list()` throws, the whole observation is marked **incomplete** and **not a single entry is published**;
- the result: `AGENTS.md` points at a skill the model cannot see. **No error, no warning, it simply never takes effect.**

This plugin stops depending on that chain: it carries the capability with it.

## Three surfaces

| Surface | What it does | Why it is needed |
|---|---|---|
| Tool `chrome_cdp` | Open / measure / screenshot in one call | **Tools sit in the request catalog at every step**; a skill is only consulted when the model decides to consult it. This is what makes the behaviour automatic |
| Skill `chrome-cdp` | The full playbook: measurement criteria, sign-in, dark mode, a table of known traps | Registered into the skill registry's **global layer**, untouched by preset, directory layout, or frontmatter parsing |
| Prompt section | One short trigger rule | Survives a move to another machine, or a lost `AGENTS.md` |

## Install

```bash
# In the DSH Plugins page, or by asking the agent to call plugin_manager:
plugin_manager install_bundle  target=link:D:/project/qujinting/dsh-plugins/dsh-chrome-cdp
```

The equivalent profile change (`~/.dsh/profiles/<profile>/package.json`):

```json
{
  "dsh": { "profile": { "bundles": ["...", "dsh-chrome-cdp"] } },
  "dependencies": { "dsh-chrome-cdp": "link:D:/project/qujinting/dsh-plugins/dsh-chrome-cdp" }
}
```

Changes take effect immediately — a live profile recomposes on its own, no restart needed.

## Usage

```
chrome_cdp({ url: 'http://localhost:5173/', script: 'JSON.stringify({ vw: innerWidth, vh: innerHeight })' })
```

One call returns **numbers** and a **screenshot** together:

```
<url>http://localhost:5173/</url>
<title>My app</title>
<measure>
{"vw":1600,"vh":1000,"boxes":{...}}
</measure>
<screenshot>
D:\work\app\.dsh\chrome-cdp\2026-10-12_14-30-00-localhost-5173.png
</screenshot>
Open that PNG with the read_image tool and judge it by eye before reporting a result.
```

> **Reading only the JSON gets the size right and the look wrong.** After you get the path, open it with `read_image`.

### Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `url` | — | Required. Absolute http(s) or file URL |
| `script` | — | JS to run in the page; an expression or a body with `return`. Returning `JSON.stringify(...)` is recommended |
| `waitForSelector` | — | Wait for a CSS selector to appear; more reliable than a fixed delay |
| `waitMs` | `1200` | Milliseconds to wait after `load` |
| `dark` | — | `true` adds `<html class="dark">` and emulates `prefers-color-scheme: dark`; `false` does the opposite |
| `screenshot` | `true` | Turn off for measurement-only calls |
| `viewportWidth` / `viewportHeight` | `1600` / `1000` | Emulated viewport, for breakpoint checks |
| `outPath` | `<workspace>/.dsh/chrome-cdp/<timestamp>-<slug>.png` | Where the screenshot lands |
| `headless` | `true` | Set `false` when a page refuses to render headless, so you can watch it |
| `timeoutMs` | `60000` | Total budget for one call |

## Configuration

`config: {}` in `cordis.patch.yml` is the default behaviour; every field is optional:

| Field | Default | Meaning |
|---|---|---|
| `browserPath` | auto-detected | Path to a Chrome / Edge executable; the probe order lives in `src/cdp.js` |
| `toolName` | `chrome_cdp` | Name the tool registers under |
| `headless` | `true` | Default value of the `headless` parameter |
| `timeoutMs` | `60000` | Default budget for one call |
| `profileRoot` | `<system temp>/dsh-chrome-cdp` | Root for the throwaway profile created per call |
| `screenshotDir` | `<workspace>/.dsh/chrome-cdp` | Default screenshot directory |
| `registerSkill` | `true` | Whether to register the embedded skill |
| `registerPromptSection` | `true` | Whether to register the prompt routing section |

Example: pin the browser and drop the prompt section

```yaml
- id: dsh-chrome-cdp
  config:
    browserPath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'
    registerPromptSection: false
```

## Implementation notes

- **Dependency-free**: the CDP client uses Node's built-in `fetch` and `WebSocket` (Node ≥ 22). The package **imports nothing from `@deepseek-ai/*`** — a profile-installed plugin cannot resolve those anyway.
- **`--remote-debugging-port=0` plus `DevToolsActivePort`**: the browser picks its own port, so nothing collides, and the port only becomes readable once the browser has actually started.
- **A throwaway profile**: without `--user-data-dir`, a running Chrome just opens a tab in the existing instance and exits, so the debugging port never appears. This is the trap that cost the most time.
- **Always clean up**: `stdio: 'ignore'` (piped stdio can be rejected under a restricted sandbox), `taskkill /T /F` on Windows to take the renderer down too, then delete the throwaway profile.

## Development

```bash
npm test        # measure / viewport / dark / error / no-residue against a local fixture
npm run check   # syntax check
```

## License

MIT
