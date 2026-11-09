# dsh-plugins

English | [简体中文](README.zh-CN.md)

A collection of plugins for **DSH** (DeepSeek Harness). Each directory is an independent, installable bundle: drop it into a profile and the Harness picks it up.

Harness is built on [cordis](https://github.com/cordisjs/cordis) and takes "everything is a plugin" literally — these packages are that idea put to work, from a browser tool to a theme to a desktop pet.

## What's inside

| Plugin | What it does | Why you might want it |
|---|---|---|
| [`dsh-bridge`](dsh-bridge/) | One audited entry point for host capabilities: `service.list` / `service.describe` / `service.call` / `plugin.list` / `config.edit` / `plugin.restart` / `app.exit`, with confirmation, timeouts, a circuit breaker, and an audit ring | You are writing a plugin and do not want to guess internal service names, or want a restart path that is safe to call |
| [`dsh-chrome-cdp`](dsh-chrome-cdp/) | Registers a native `chrome_cdp` tool, an embedded skill, and a routing prompt section, driving the machine's own Chrome over CDP | The agent needs to actually *look* at a page — measure boxes, take a screenshot — with no Playwright, no Puppeteer, and without touching your running browser |
| [`dsh-desktop-pet`](dsh-desktop-pet/) | A Live2D desktop pet in the Web GUI: draggable, follows the cursor, reacts to clicks, changes motion with the session phase | You want the Harness to have a face. Ships with DS Whale Girl (8 motion groups, 44 expressions) |
| [`dsh-secret-broker`](dsh-secret-broker/) | Enter secrets as key → value in the UI; a session only ever sees the *key name*, and the value is injected into a child process at the moment a command runs | You are tired of pasting tokens into conversations that get logged, indexed, and backed up |
| [`dsh-theme`](dsh-theme/) | A DeepSeek Blue theme: single-hue, lightness-layered deep-sea interface, 4K intro film, looping character wallpaper | The default look is not yours, and you want it to be |
| [`dsh-web-search`](dsh-web-search/) | A `ctx.web` search provider that searches with the model you currently have selected, via gateway-native search tools | The built-in provider hardcodes a DeepSeek model and spends DeepSeek quota; this one follows your selection and runs on your gateway |

## Install

Every plugin is a bundle. The general shape, using the built-in plugin manager (dsh 0.1.7+ / 0.2.x):

```powershell
dsh plugin --profile desktop add file:D:/project/qujinting/dsh-plugins/dsh-chrome-cdp
```

Or, from inside a session in Creator mode:

```js
plugin_manager({ action: 'install_bundle', target: 'D:/project/qujinting/dsh-plugins/dsh-chrome-cdp' })
```

Each plugin's own README has the exact steps for its target profile, its configuration fields, and what to check afterwards — some of them need a restart, some only a page refresh. Read that before installing; `dsh-web-search` in particular also has to change `web.searchProvider`, which its bundle patch does for you.

## Conventions

- **Directory name equals the package name**, always `dsh-` prefixed. Nothing has to be translated between a path and a manifest.
- **No `@deepseek-ai/*` imports.** A plugin installed into a profile cannot resolve the Harness's own packages, so every package here is dependency-free and survives a harness upgrade untouched. Where the Harness offers a base module table (the browser half), that is used instead of bundling a copy.
- **Bilingual documentation.** `README.md` is English, `README.zh-CN.md` is Simplified Chinese, and each links to the other on its first line.
- **Tests run without a Harness.** Packages that can be tested in isolation ship a `npm test` that uses a stand-in context, so a change can be verified before anything is installed.
- **Honest limits are documented.** If something cannot work — a plugin restarted by the host, a capability the Electron shell does not expose — the README says so and explains why, instead of leaving it implied.

## Development

Each directory is self-contained; `cd` into the one you are working on:

```bash
npm test        # where the package ships tests
npm run check   # syntax check, where the package defines one
```

Testing that needs the Harness's module closure (for example `dsh-web-search`) has its own extraction script documented in that package's README.

## License

MIT, per package — each directory carries its own `LICENSE`.

Two exceptions worth knowing about, both in [`dsh-desktop-pet`](dsh-desktop-pet/):

- The bundled **DS Whale Girl** model and artwork (`assets/pet/`, `icon.png`) are **CC BY-NC-SA 4.0**: attribution, non-commercial, share-alike. See [`assets/pet/LICENSE`](dsh-desktop-pet/assets/pet/LICENSE) and [`NOTICE.md`](dsh-desktop-pet/NOTICE.md) for the copyright chain.
- **Live2D Cubism Core** is proprietary to Live2D Inc. and is **not** redistributed here; the plugin fetches it at first use.
