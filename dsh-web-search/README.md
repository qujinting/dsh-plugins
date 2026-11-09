# dsh-web-search

English | [简体中文](README.zh-CN.md)

> **A DSH plugin** | A DeepSeek Harness `ctx.web` search provider that replaces the built-in `web-search-deepseek`.
>
> ![DSH plugin](https://img.shields.io/badge/DSH-plugin-4b5563)
> ![license](https://img.shields.io/badge/license-MIT-blue)
> ![node](https://img.shields.io/badge/node-%E2%89%A522-3c873a)

A DSH (DeepSeek Harness) plugin: **search the web with the model you currently have selected**, instead of the built-in `web-search-deepseek`.

The built-in provider (`@deepseek-ai/dsh-web-search-deepseek`) hardcodes the model as `deepseek-v4-flash` and only talks to DeepSeek's own Anthropic-compatible endpoint (`https://api.deepseek.com/anthropic/v1`) — so it burns DeepSeek's own quota and ignores the model you picked in the UI.

This plugin registers a search provider with the id `clinepass`, which:

1. Reads the `provider` / `model` actually used for this step **from the current session's request header**;
2. Takes that route's `baseURL` / `apiKeyEnv` from the `llm-pi-ai` settings (the configuration the Web "Models" page wrote);
3. Sends one OpenAI-compatible `POST {baseURL}/chat/completions` with the gateway's **provider-executed search tool** (`vercel:perplexity_search` and friends) in `tools`;
4. Parses the `Sources:` block at the end of the model's answer into the source list `ctx.web` expects.

Searching runs on your ClinePass (or any OpenAI-compatible gateway) quota, never touches the official DeepSeek key, and adds nothing to the main conversation's context.

## Why this needs a config change, not just an install

`ctx.web` picks its provider by **explicit id first**: `@deepseek-ai/dsh-base` hardcodes the `web` row as `searchProvider: deepseek-official`, so merely registering a new provider will never select it. This plugin ships as a bundle (`dsh.bundle.patch`) whose `cordis.patch.yml` does two things at once:

```yaml
- id: web
  config:
    searchProvider: clinepass
    fetchProvider: http          # a patch replaces the whole config, so this line has to be restated

- insert:
    - id: dsh-web-search
      name: 'dsh-web-search'
      config: {}
```

The built-in `web-search-deepseek` stays mounted (just not selected), so you can switch back at any time.

## Install

Pick the path that matches your dsh version. Both install the same bundle; they differ only in **who edits the profile manifest** and where the card shows up afterwards.

### dsh 0.1.7 and later (including 0.2.0, using the built-in plugin manager)

```powershell
# From npm
dsh plugin --profile web add dsh-web-search

# Or from a local checkout
dsh plugin --profile web add file:D:/project/qujinting/dsh-plugins/dsh-web-search
```

- **From 0.2.0-rc.2 the `dsh` command ships with the desktop app**, so Node / pnpm are no longer prerequisites. First use: click **"Manage dsh command"** in the menu bar to put it on PATH, then the two commands above work as written (change `--profile` to the profile you want — the desktop app uses `desktop`).
- The plugin manager runs pnpm: it installs the package into `<DSH_HOME>/profiles/web/node_modules` and appends `dsh-web-search` to that profile's `dsh.profile.bundles` (backing up `package.json.bak-install-<timestamp>` first).
- **Takes effect after restarting dsh** (the bundle list is assembled at startup). `dsh --profile web --dump-config` shows the composition without starting the service.
- The installed card lives at **"Plugins" on the left → Installed → `dsh-web-search` → the "Configure" button on the `dsh-web-search` component row**. 0.1.7 moved configurable plugin pages into the plugin manager page; "Settings → Plugins" is now a read-only list.
- Note: `dsh plugin add file:` installs the code **into the pnpm store (hard link)**, not a directory junction. After editing this repository you must run the add command again (or use the 0.1.5 junction route for development).
- Uninstall: `dsh plugin --profile web remove dsh-web-search`.

### dsh 0.1.5

```powershell
# 1) Install into the web profile (run inside the plugin directory)
node install.mjs --profile web

# 2) Inspect the composition (does not start the service)
dsh --profile web --dump-config

# 3) Restart the web service to take effect
dsh web
```

`install.mjs` does exactly two reversible things:

- Creates a directory junction at `<DSH_HOME>/profiles/web/node_modules/dsh-web-search` pointing at this directory;
- Appends `dsh-web-search` to that profile's `package.json` under `dsh.profile.bundles` and writes a `file:` dependency — backing up `package.json.bak-install-<timestamp>` first.

Because it is a **junction**, editing this repository only needs a page refresh (browser half) or a restart (host half); no reinstall. The card lives at **Settings → Plugins → Plugin configuration**, and the values are written to the `dsh-web-search:` section of `<DSH_HOME>/settings.yaml`.

Manual equivalent, for reference:

```powershell
# Inside <DSH_HOME>/profiles/web
New-Item -ItemType Junction -Path node_modules\dsh-web-search -Target D:\project\qujinting\dsh-plugins\dsh-web-search
# Then add dsh-web-search to the end of dsh.profile.bundles in package.json
```

### Uninstall

0.1.7: `dsh plugin --profile web remove dsh-web-search`
0.1.5: `node install.mjs --profile web --uninstall`

Both remove the package and the bundles entry (backing up `package.json`). After a restart `web.searchProvider` returns to `deepseek-official` and the built-in behaviour is fully restored — the plugin modifies no native file.

### One package, two settings APIs

dsh 0.1.7 reworked settings: a plugin's Config entry **is** its settings page, editable fields must be marked `.volatile()`, and writes land in the profile's `cordis.patch.yml`; 0.1.5 instead registers a plugin-owned section with `settings.installSection()` that lands in `settings.yaml`. This plugin supports both from one package. **dsh 0.2.0-rc.2 keeps the 0.1.7 model** — `configure({ auto })` is present, `installSection()` and `get(ns)` are gone — so the 0.1.7 column below is also the 0.2.0 behaviour, and the plugin adds no branch for it:

| | dsh 0.1.5 | dsh 0.1.7+ |
|---|---|---|
| Host half | `settings.installSection(ctx, 'dsh-web-search', Config, …)` | `settings.configure({ auto: false }, ctx.fiber)` + the entry's own Config |
| Editable fields | The whole section goes into the form | Only fields marked `.volatile()` (the `editable()` wrapper in `src/config.js`; older schemastery without that method degrades to a plain field) |
| Reading values | The parsed section (plain values) | A volatile reference, `.get()` for the current value; `normalizeConfig()` flattens at every boundary |
| Reading **someone else's** namespace (`llm-pi-ai` / `agent-default-model`, for route resolution and the fallback model) | `settings.get(ns)` | the `{ ns, value }` projection from `settings.describe()` (the 0.1.7 service has **no** `get`); see "the bug fixed in 0.3.1" |
| Card slot | `settings.plugin.item` + `ctx.settingsScope` | `plugins.row.config` (key = `<package>#<row id>`) + the `form` passed by the page (`state` + `mutate`) |
| Card location | Settings → Plugins → Plugin configuration | Left "Plugins" → Installed → the package → the component row's "Configure" |
| Settings land in | `<DSH_HOME>/settings.yaml` | `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` |

The split is decided purely by **service probing**, never by version numbers: the host half checks whether the settings service has `configure` (new if yes, old if no), and `readSettings()` asks `get` first and `describe` second (`src/route.js`); the browser half does `ctx.inject(['settingsScope'], …)` and `ctx.inject(['configForms'], …)` respectively, and only one `inject` can ever be satisfied, so exactly one card registers.

### The bug fixed in 0.3.1: `web_search` reporting "registered but unavailable" on 0.1.7

0.3.0 (the "supports both settings models" release) migrated **its own Config entry** to the 0.1.7 model but forgot the **read someone else's namespace** path: `readSettings()` still only called `settings.get(ns)`, and `@deepseek-ai/dsh-settings` in 0.1.7 has no `get` at all (`installSection` is gone too). The exception was swallowed by `try/catch` and returned `undefined` every time. The consequence: `llm-pi-ai` was never readable, `resolveTarget()` got no `baseURL` / `apiKeyEnv`, `available()` was permanently `false`, and every search became:

```
Error: configured web provider "clinepass" is registered but unavailable
    (WEB_PROVIDER_CONFIGURED_UNAVAILABLE)
```

It only happened on dsh 0.1.7+; on 0.1.5 `get` still existed so behaviour was unchanged. The fix adds the 0.1.7 read path to `readSettings()` (the `{ ns, value }` projection from `settings.describe()`, which already flattens volatile references internally):

```js
if (typeof settings.get === 'function') { /* 0.1.5 */ }
return describedSettings(settings, ns);      // 0.1.7: find the value by ns in describe()
```

**If you still get this error after upgrading and cannot reinstall the plugin immediately**, you can pin the route in the profile's `cordis.patch.yml` first (`provider` / `model` are volatile fields and work from a patch too; `baseURL` / `apiKeyEnv` are ordinary fields, which is why they can only be configured from a patch — the card has no such inputs):

```yaml
- id: dsh-web-search
  config:
    provider: clinepass
    model: cline-pass/deepseek-v4.1-flash
    baseURL: https://api.cline.bot/api/v1
    api: openai-completions
    apiKeyEnv: CLINEPASS_API_KEY
```

The cost is that this search no longer follows the model selected in the UI; delete the block after upgrading to 0.3.1 to restore that.

## Configuration

Settings namespace: `dsh-web-search` (it appears in the Web UI under "Settings → Plugin configuration" and is hot-editable).

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | When off, this provider reports itself unavailable. |
| `tool` | `vercel:perplexity_search` | The provider-side search tool id sent to the gateway (1 of 4). Billed per search; the search-count limit in the prompt is only **advisory** — this format has no hard cap, so the model may search more. |
| `provider` / `model` | empty (follow the session) | Pin the route and model instead of following the UI. |
| `baseURL` / `api` / `apiKeyEnv` / `apiKey` | empty | Pin the endpoint and credentials. |
| `headers` | empty | Extra request headers; merge precedence: `llm-pi-ai` < `routes[provider]` < this section. |
| `routes` | `{}` | Per-LLM-route overrides for `api` / `baseURL` / `apiKeyEnv` / `apiKey` / `headers` / `tool`. |
| `fallback.provider` / `fallback.model` | empty | Fallback route when the session model is unusable (resolved through `routes` / `llm-pi-ai` as well). |
| `timeoutMs` | `90000` | Per-search timeout; one search is one full model turn. Note that `dsh-tool-web`'s own `searchTimeoutMs` (60000 in base) is the real outer bound on the model side — the slowest observed run was 30.7s. |
| `maxTokens` | `8192` | Output budget for the search turn. Measured `completion_tokens` for one Q&A is **3535 / 4176** (including reasoning tokens), so 4096 is already at the ceiling; once `finish_reason` becomes `length`, what gets cut is usually the trailing `Sources:` block. 8192 = twice the measured value: no truncation, still bounded (the answer becomes the calling agent's context and is re-billed as input tokens every turn after). |
| `temperature` | unset | When absent the field is not sent at all (some reasoning models reject it). |
| `maxSources` | `10` | Cap on sources handed back to the seam; `dsh-tool-web`'s `searchMaxResults` trims again. |
| `instructions` | empty | Extra requirements appended to the end of the **user message** (**not** the system prompt — see below). |

> There is deliberately **no** switch for "write search records into the session log": DSH would refuse to load the whole session, for the reason in "Why no more session-log events".

In the overwhelming majority of cases nothing needs configuring: when the session model is an OpenAI-compatible gateway such as `clinepass`, all routing comes from `llm-pi-ai.providers.<route>` (`api` / `baseURL` / `apiKeyEnv`) — read via `settings.get('llm-pi-ai')` on 0.1.5 and via `settings.describe()` on 0.1.7 (see "the bug fixed in 0.3.1").

## Tool selection and cost

The AI Gateway **Chat Completions** API (the one this plugin uses) documents only four server-side search tools, and this plugin offers exactly those four; change `tool` to switch:

| Tool | Search backend | Required config | Unit price (gateway side) | Best for |
|---|---|---|---|---|
| `vercel:perplexity_search` | Perplexity Search API | `query` | **$5 / 1000 calls** | The general default: citations included, recency/region/language/domain filters, `maxResults` 1–20 |
| `vercel:parallel_search` | Parallel AI Search | `objective` | **$5 / 1000 calls** (10 included, $1/1000 beyond) | Research questions: LLM-optimised excerpts, `mode` of `one-shot` / `agentic` |
| `vercel:exa_search` | Exa | `query` | **$7 / 1000 calls** (≤10 results) | Filtering by domain / date / type (`news`, `research paper`…), or more token-frugal excerpts |
| `vercel:tako_search` | Tako | `query` | **$7 / 1000 calls** (instant/fast), **$12 / 1000 calls** (deep) | Only worth it for its real-time knowledge graph (finance / sports / weather / macro / politics) |

**Why `browserbase_search` / `browserbase_fetch` are not offered**: Vercel exposes `gateway.tools.browserbaseSearch()` only on the AI SDK surface; the Chat Completions server-tool table has no such ids. Testing showed the ClinePass endpoint **accepts** `vercel:browserbase_search` (HTTP 200), but in one request the model searched **34 times**, burned 176k prompt tokens, cost **$0.2645**, and produced a 1314-character answer with **zero citations** (essentially "let me search again"). So it was removed from the options.

### Billing is per call, not per request

Inside one `web_search` the model decides how many times to search, and the gateway reports the count in `message.provider_metadata.gateway.gatewayToolCalls`. Measured on the same class of question (`gatewayCost`, **per `web_search`**):

| Tool | Searches | Sources | `gatewayCost` |
|---|---|---|---|
| `vercel:perplexity_search` | 6 → **4** | 17 → 10 | $0.0430 → **$0.0298** |
| `vercel:parallel_search` | 4 → **2** | 17 → 10 | $0.0361 → **$0.0202** |
| `vercel:browserbase_search` (removed) | 34 | 0 | $0.2645 |

The right column is what was measured after adding "at most 3 searches" to the system prompt; `$5/1000` is charged **per search**, so six searches cost $0.03 in tool fees alone — **search count is the dominant cost**, far more than output length. The instruction is advisory: four searches still happened in testing (there is no hard cap; the Chat Completions format has no "max uses" field).

Also note: `dsh-tool-web` runs every query in the `queries` array **concurrently**, so one `web_search({queries:[q1,q2,q3,q4]})` is four model turns. Use a single query to save money.

### Every search hands its query to the gateway as the default

The `tools[]` entry is not a bare id — it carries this search's input (the `toolEntry()` in `gateway.js`):

```json
{ "type": "vercel:perplexity_search", "config": { "query": "…", "max_results": 10 } }
```

perplexity / exa / tako use `query`, parallel uses `objective` (the required field in each schema), and the result count is `max_results` (exa: `num_results`). The docs say config is "developer defaults that override model-generated values", which anchors retrieval on the query the harness actually received instead of letting the model rewrite it. **An unknown tool id still goes out as a bare id** — inventing a config for an unrecognised schema only makes the request start failing.

## How it works (in detail)

```
agent calls web_search(queries)
        │  dsh-tool-web calls ctx.web.search() concurrently per query
        ▼
ctx.web  (searchProvider = clinepass)
        ▼
CurrentModelSearchProvider.search()
   ├─ pick model   agent.session.requestHeader().config  →  agent.options  →  settings['agent-default-model']
   ├─ resolve route   settings['llm-pi-ai'].providers[provider]  +  this plugin's routes / explicit pinning
   ├─ get credentials   ctx.credentials.resolve(apiKeyEnv)  →  launchEnvironment
   ├─ send request   POST {baseURL}/chat/completions
   │                 tools:[{type:'vercel:perplexity_search', config:{query, max_results}}]
   │                 (provider-executed: the gateway runs retrieval, the model side is still one assistant turn)
   └─ parse   the Sources: block at the end of message.content → markdown links + bare URLs → dedupe, titles, truncate
```

### How sources are obtained

The gateway reports search counts in `usage.gateway_cost` / `message.provider_metadata.gateway.gatewayToolCalls` and **returns no structured citation blocks** — the real URLs are in the answer body. So the search instruction requires the model to end in a fixed shape:

```
Sources:
- [Page title](https://full.url)
```

The parser prefers links from that block (using the markdown label as the title), falls back to scanning the whole text only if it finds nothing, and strips the block from the body so the same URLs do not appear twice in the tool result.

### Honesty markers

- `gatewayToolCalls` present and 0: append "the gateway did not actually run a search; treat this as unverified";
- `finish_reason === 'length'`: append "the output limit was reached; the answer and source list may be incomplete".

## How far verification went

- **Unit tests** `npm test`: **61 cases, all green, 0 skipped**. Parsing and route resolution **22** (Chinese punctuation, markdown links, dedupe, truncation, session following, model switching, protocol incompatibility, explicit pinning, fallback, plus the 0.1.7 read path: route and endpoint still resolve when only `describe()` exists and `get()` does not, `agent-default-model` is equally readable, and the namespace missing from the projection still yields unavailable), search path and repair tooling 15 (searches write no session event, unavailable routes never touch the session, the schema no longer exposes a write switch, the request body carries `tools[].config`, the four tools' config field mappings, unknown tool ids going out bare, the prompt's search-count limit, unsupported event recognition, the envelope marker, frame structure preserved, dry-run, active-session and `session.lock` protection, current generation only), **host half 5** (0.1.7 uses `configure({auto:false})` and reads live references, 0.1.5 uses `installSection` and prefers the section, neither present falls back to the composite entry, `normalizeConfig` flattens references and passes plain values through, editable fields are marked volatile), browser half 19 (both registration paths: 0.1.7's `plugins.row.config` key `<pkg>#<row>`, 0.1.5's `settings.plugin.item` waiting for the ledger; the 0.1.7 page view rendering fields, the summary view needing no form, unserved entries rendering empty, read-only entries disabling every button; the write planner, default-equals-clear-override, collapsed rendering only the header, degraded rendering when the namespace is missing, stylesheets reading only theme tokens and fully namespaced, Tag/Switch/chevron coming from the base module, the chevron falling back `IconChevronDownOutline14` → `IconChevronDownOutlineMedium` → `IconChevronDownOutlineRegular`, and rendering without any icon when none exists, boolean fields being a label-left switch-right toggle row, the search tool being a radio list with no `<select>` on the page, only the four documented tools, and the tool section stating the count limit is advisory).
  Twelve of those rendering tests need `react-dom` and skip gracefully without it; `npm run link-runtime -- --with-react` installs it alongside, which is why this machine now reports **61 passed + 0 skipped** (the earlier closure came from an old global dsh install and could only reach 49 passed + 10 skipped).
- **Real dsh 0.2.0-rc.2 acceptance (0.3.2)**: runs on desktop 0.2.0-rc.2 (kernel `@deepseek-ai/dsh` / `dsh-web` / `dsh-settings` all 0.2.0-rc.2) **without a single code change**. Host half: `include:dsh-web-search` mounts, `ctx.web.registerSearchProvider` and `settings.configure({ auto: false }, owner)` signatures are unchanged, `settings.describe()` still returns `{ ns, value, user, writable }` (so `readSettings()`'s 0.1.7 path still applies), the `llm-pi-ai` namespace and `providers.clinepass`'s `api` / `baseURL` / `apiKeyEnv` are intact, and a real `web_search` returned an answer with sources. Client half: driven through the real GUI over CDP (left "Plugins" → Installed → the config button on the component row) confirming the card still renders **all 8 fields** (1 switch / 4 radios / 3 numbers / 3 texts / 1 textarea + three footer buttons), the `plugins.row.config` slot is declared by the plugin manager and renders `dsh-web-search#dsh-web-search`, and the console shows 0 errors; the base `Tag({ tone })` and `Switch({ checked, onChange, label, disabled })` signatures are unchanged and all 12 `--dsw-alias-*` tokens the card uses exist in 0.2.0. **The only name 0.2.0 changed is an icon**: `IconChevronDownOutline14` was replaced by `IconChevronDownOutlineMedium` / `Regular` (0 occurrences in the whole payload); it only appeared in the 0.1.5 card's header, so it never triggered before, and from 0.3.2 the code falls back by name.
- **Real 0.1.7 settings implementation (the 0.3.1 regression check)**: instead of booting the whole harness, the **real** `SettingsForms.prototype.describe` (unstubbed, given only a stand-in for `configEditor.configuration()`) was run against the **real** `@deepseek-ai/dsh-llm-pi-ai` Config schema and this machine's real profile route values: `describe()` output `[{ ns: 'llm-pi-ai', value: { providers: { clinepass: { baseURL: 'https://api.cline.bot/api/v1' } } } }]`. The same ctx was then fed to HEAD (0.3.0) and to the fixed `resolveTarget()`: 0.3.0 reports `available() === false` under the 0.1.7 service (exactly that `registered but unavailable`), while the fixed version reports `available() === true`, endpoint `https://api.cline.bot/api/v1/chat/completions`, source `session request header`; the 0.1.5 `get(ns)` ctx resolved correctly before and after. **Not verified**: running `web_search` again after restarting the harness in the real GUI (the plugin is a hard-linked `file:` copy in the profile, so repository changes need another `dsh plugin add` plus a restart).
- **Real GUI acceptance (aligned item by item with the built-in card)**: using this machine's Chrome over CDP against a running `dsh web` (throwaway profile plus a session cookie minted with the local `client-connection/browser-session` signing key, which never leaves the machine), this card and the built-in "Web search" card were measured on the **same page**: collapsed both **564×75** (header padding 14/16, gap 12, title 15px/600, summary 13px, chevron 14×14 with `viewBox="0 0 14 14"`); expanded body border-top / margin 16 / padding-bottom 8, field padding 12, label 13px/500, hint 12px, control 530×36 (radius 8 / border 1px / padding 12 / font 13), footer and save button (font 13, padding 5/14, bg = label-primary, text = bg-layer-3) **identical item by item**; the "unsaved" Tag is the same base component, measured 49×19 / 11px / radius 999px matching the built-in one; switching to `body[data-ds-dark-theme]` changes both cards' tokens together (card 44,44,46 / border 67,69,74 / control 53,54,56 / text 249,250,251) with **0 errors and 0 warnings** in the console; the position is always after the four built-in cards (Terminal / Agent loop / Subagent / Web search). The two controls were also measured against the built-in Subagent card on that page: the toggle row is `justify-content:space-between` / `align-items:flex-start` / `gap:16px` with a 36×20 switch flush right (0px right margin), identical to the built-in toggle row; the radio group frame (border 1px rgba(0,0,0,.16), radius 8, padding 10, gap 6, max-height 280, overflow auto) matches the built-in Subagent card's selection fieldset **item by item**, as do row padding 6 / radius 6 / gap 8 / native radio 13×13; the four options share one `name`, exactly one is checked, and the page contains 0 `<select>` elements.
- **Real GUI acceptance (dsh 0.1.7, isolated instance)**: a separate `DSH_HOME` (temp directory, temp profile, port 3091) ran a real `dsh 0.1.7-rc.2 web`, the plugin was installed, and the real path was walked over CDP: left "Plugins" lists `dsh-web-search v0.3.0` (1 installed) → the "Configure" button on the `dsh-web-search` component row → the page renders the card's **8 fields / 4 radios (default selected) / 1 toggle row / 6 text inputs / three footer buttons**, with the stylesheet injected as `style[data-plugin-css]`; switching to `vercel:parallel_search` and pressing save shows "Saved (1 item)." and the profile's `cordis.patch.yml` really contains `- id: dsh-web-search\n  config:\n    tool: vercel:parallel_search`; **0 errors, 0 warnings** throughout. (The temporary instance and home were deleted; the dsh you were running was never touched.)
- **Real seam integration** `node test/live-gateway.mjs`: registers this provider in the real `WebRuntime` (`@deepseek-ai/dsh-web`), selects it via `searchProvider: clinepass`, sends one real search to `api.cline.bot`, and asserts sources are non-empty and `maxResults` is honoured.
- **Real gateway measurements (search counts and `tools[].config`)**: calling the real gateway through the plugin's own `searchWithGateway`, perplexity and parallel each returned 200 / `finish_reason: stop`, 10 sources each, no truncation notice; `gatewayToolCalls` were 4 and 2, `gatewayCost` **$0.0298 / $0.0202** (the same class of question before the "at most 3 searches" instruction was 6 / 4 calls and $0.0430 / $0.0361).
- **Real DSH end to end**: a throwaway profile (`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` + this plugin) ran a real task and returned real source links. After it worked end to end, no `web/clinepass-search-request` events are produced any more; the ones earlier versions wrote into the session log were patched with `ignorable: true` by `tools/repair-session-events.mjs` (see "Why no more session-log events"), so those sessions load normally again.

## Limits and caveats

- **No session-log events whatsoever.** Early versions appended a `web/clinepass-search-request` event (called `web/current-model-search-request` in v0.1.0) per search, which made the session **refuse to load entirely** on the next resume; that behaviour is removed, with no switch to bring it back. Sessions already damaged are repaired by the tool in the next section.
- **Only routes that are OpenAI-compatible and support provider-side tools work.** When a route declares a non-chat-completions protocol (such as `anthropic-messages`), this provider reports itself unavailable — deliberately: sending a gateway tool id to an endpoint that does not understand it only yields confusing errors.
- **Switching to a non-gateway model makes `web_search` report `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`.** Two ways out: configure `fallback.provider` / `fallback.model` in settings to pin a gateway route as the fallback, or change `web.searchProvider` in the profile's `cordis.patch.yml` back to `deepseek-official`.
- **Credentials are read only from `ctx.credentials` and the launch environment.** Keys never reach logs or session records (records carry only route, duration, cost, and search count).
- **`web_fetch` is unaffected** and still uses the built-in `http` provider.
- **A provider-side tool is one full model turn**: measured latency 8–15 seconds, cost per the table above.
- The plugin modifies no native package file, and uninstalling restores everything.

## Why no more session-log events

Early versions appended a `web/clinepass-search-request` event to the session log on every search. **That behaviour is deleted**, because it makes the session impossible to open:

- DSH reads sessions fail-closed: `session-persistence`'s `validateStoredEvents()` refuses to interpret **the whole** log when it meets an event outside `KNOWN_SESSION_EVENT_TYPES` whose envelope lacks `ignorable: true`, raising `SessionFormatUnsupportedError` ("unknown to this harness and not marked ignorable; refusing to interpret the log");
- The allow list is generated by the harness repository itself, so plugin-declared events are outside it by construction;
- And the third argument of `Session.append()` accepts surface metadata only (`surfaceOp` / `sourceEventSeqs`) — **a plugin has no way** to write `ignorable: true` on a custom event. Writing it is silent; you only discover the session is unopenable on the next resume.

So as long as "the session must be resumable" holds, the only safe choice for a plugin is **not to write custom events**: this plugin now only reads the seam and persists nothing. Diagnostics (route, duration, `gatewayCost`) no longer go into the session log; for long-term billing statistics, collect them outside (the gateway dashboard, for example).

### Repairing an already-damaged session

The repository ships `tools/repair-session-events.mjs`: it handles only the **current generation** `session.v3.jsonl.zstd`, finds events outside the allow list without `ignorable: true`, keeps frame structure and every other line untouched, and adds `ignorable: true` to exactly those envelopes (which is what a purely informational record should carry); it backs up before writing and decodes to self-check afterwards, rolling back from the backup if that check fails.

```powershell
npm run repair-sessions          # scan only: list sessions that would be refused
npm run repair-sessions:apply    # repair (without --apply it is a dry run and writes nothing)
node tools/repair-session-events.mjs repair --session 80bad975-cea1-48af-b509-f2849e8841b0 --apply
```

- By default it scans every session under `$DSH_HOME` (or `~/.dsh`); `--home <dir>` changes the root, `--session <id>` narrows to one session.
- The tool does not depend on the development `node_modules` junction: it locates `@deepseek-ai/dsh-session` through `$DSH_HOME/profiles/**/node_modules` and DSH's own installation directory (the allow list has to come from the harness that actually reads the log), so anyone who clones the repo can run it.
- Sessions written in the last five minutes, or whose directory holds a `session.lock`, are skipped (they may still be open): **stop the harness before running**; use `--force` to override both guards once you are sure.
- Backups are written next to the original: `session.v3.jsonl.zstd.bak-<timestamp>` (the harness never reads that name, so it is safe to delete).
- Older generations (`session.jsonl.zstd`, `session.v2.jsonl.zstd`, …) are not scanned — the harness's own migration chain handles them.

## The card (browser half)

This plugin is **double-sided**, and the two settings models each get a card:

- **dsh 0.1.7**: `lib/client.js` registers into `plugins.row.config` with the key `dsh-web-search#dsh-web-search`. The page (the plugin manager) draws the title, icon, and breadcrumb itself and passes the entry's `form` (`state` + `mutate`) in as a prop; the list also calls a `summary` view for one line, so the card returns one sentence **while the row is collapsed**.
- **dsh 0.1.5**: registers into `settings.plugin.item` with the key `dsh-web-search` and binds `ctx.settingsScope` itself; the card is a `<li>` plus a header button with `aria-expanded` (title / summary / unsaved marker / chevron), **collapsed by default**, collapsing again after a successful save and staying open on failure.

The **ordering rule** for the 0.1.5 card: the settings page renders in ledger order, and this plugin's `apply` runs before the settings plugin registers its own cards, so "register immediately" would push this card ahead of all built-in ones. The implementation instead **waits until the ledger already holds a card** — so it lands after whatever configurations were loaded, rather than being pinned last (cards registered later still land after it). 0.1.7 has no such problem: the plugin page decides placement.

Fields the card can change: `enabled`, `tool` (the four documented gateway search tools), `maxSources`, `timeoutMs`, `maxTokens`, `provider` / `model` (pin the route, optional), `instructions`. Save after editing; when a field returns to its default the write is `unset` (clear the override and inherit again), and every overridden field has its own "restore default".

The control shapes match the built-in cards: boolean fields are a **label-left, switch-right** row (the shape of the built-in Subagent card's toggle row, switch flush right); `tool` is a **radio list** rather than a `<select>` — every option visible at once, with the fieldset border / radius / padding / spacing following the built-in Subagent card's selection list (native radios, no custom drawing).

The browser half is a **hand-written** `lib/client.js`, pinned to the loading format every plugin bundle uses (`window.__ModuleLoader__.load({ id, factory })`), so this repository has no build step and depends on no npm runtime package; it uses `react` and `@deepseek-ai/dsh-client-ui-primitives` from the base module table, and cross-plugin collaboration always goes through cordis services or slots (`ctx.slots`, 0.1.5's `ctx.settingsScope`, 0.1.7's `ctx.configForms` probe).

> Changing the browser half's **content** only needs a page refresh (Ctrl+Shift+R if needed): the bundle is read from disk by the host every time, and in testing new styles and labels appeared in an already-running `dsh web`. Only **adding or removing a bundle itself** (a change to `dsh.profile.bundles` / the profile `package.json`) requires a restart.

### The card's look comes from the host, not from the plugin

DSH has **no** "declarative config card" interface. The slot contract is blunt: *a card draws its own internals; the tab only decides which namespaces to dispatch and stacks what comes back*; a namespace the host serves but no card claims **renders nothing** (`tab-store`'s words: *A served namespace no card claims renders nothing*). So the card must be contributed by the plugin; there is no alternative.

The chrome the built-in cards share (`PluginCard` + the `card-form` field kit + their CSS modules) lives inside `@deepseek-ai/dsh-client-ui-settings-plugins`, whose client bundle exports only `apply` and `inject` (`lib/client.js` ends with exactly `exports.apply` / `exports.inject`), so **a package outside the repository cannot import it**.

What is genuinely shared is the base module table the shell itself establishes, `PLATFORM_MODULES`:

`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`,
`@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
**`@deepseek-ai/dsh-client-ui-primitives`**, `@deepseek-ai/dsh-client-ui-dockkit`

So the card:

1. `require('@deepseek-ai/dsh-client-ui-primitives')` — the **same instance** the built-in cards use, to render the "unsaved" `Tag`, the boolean `Switch`, and the header `IconChevronDownOutline14`;
2. Writes every other piece of chrome with the host's theme tokens (`--dsw-alias-*`), one rule per built-in rule (values taken from `PluginCard.module.css` / `fields.module.css` at that version, not eyeballed), injected as `style[data-plugin-css]` with selectors scoped to `.dswwsc-*`. The payoff: the card follows theme and light/dark switches because every colour is a token — the stylesheet contains **no hex or rgba literal** (a unit test asserts this).

> Two routes were explicitly rejected: importing that internal package (it has no export), and borrowing its already-injected hashed class names (`.YyYd_a_card` and friends), which would go silently dead after any host refactor.

## Development

```powershell
# This repository is plain ESM JS (no build step). The tests need DSH's module closure resolved —
# either of these:
npm run link-root        # recommended: auto-discover the installed DSH closure and junction node_modules (no copies)
npm run link-runtime -- --asar "<DSH install dir>\resources\app.asar" --with-react   # or: extract a real directory from app.asar

npm test                      # unit tests (costs nothing)
node test/live-gateway.mjs    # real gateway + real seam (spends one search)
```

`link-root` finds DSH via the `$DSH_HARNESS_MODULES` / `$DSH_HARNESS_INSTALL` env vars or well-known
install roots (`%LOCALAPPDATA%\Programs`, `Program Files`, `D:\apps`, ...), probes the closure layouts
`resources/app/dsh/node_modules` and friends, requires every bare import of this plugin to exist as a
**readable package.json** (a dangling link does not count), then creates the `node_modules` junction and
verifies resolution on the spot. Re-run it after a DSH upgrade and the link follows the new install;
`npm run link-root -- --json` gives a machine-readable summary.

`link-runtime` follows the **real import graph** to extract `@deepseek-ai/*` and their transitive dependencies out of Electron's `app.asar` into `node_modules/` (the current closure is 22 packages / 877 files, with source and version recorded in `node_modules/.dsh-harness-runtime.json`). The reason not to install from npm: `@deepseek-ai/dsh-web` on the registry is still at `0.0.1-rc.1`, which does not match the kernel version. Re-run it after every DSH upgrade (add `--clean` to empty first). It **removes a directory junction on `node_modules` before creating a real directory**, so it cannot follow an old link and write into a shared profile directory — the earlier junction pointed at an uninstalled global dsh and an old monorepo checkout, which is exactly why `npm test` reported `ERR_MODULE_NOT_FOUND`.

The source package contains no `react` / `react-dom` (the Web UI is a prebuilt artefact); `--with-react` installs a copy and places it here so the 12 rendering tests really run. Without the flag they skip gracefully (`DSH_CARD_TEST_MODULES` can still point at any module directory you provide).

| File | Role |
|---|---|
| `src/index.js` | Plugin entry: `name` / `inject` / `apply` / settings namespace registration. |
| `src/config.js` | The schemastery config schema and constants. |
| `src/route.js` | Pick the model + resolve the endpoint + fetch credentials (no network calls). |
| `src/gateway.js` | The one HTTP request, error classification, and assembly of answer and sources. |
| `src/parse.js` | `Sources:` block splitting, markdown / bare URL extraction, dedupe, titles. |
| `src/prompt.js` | The search instruction (the fixed closing shape is part of the parsing contract). |
| `src/provider.js` | The `WebSearchProvider` implementation: `available()` / `search()` (read-only seam, no session log). |
| `cordis.patch.yml` | The bundle layer: changes `web.searchProvider` and inserts the plugin row. |
| `lib/client.js` | Browser half: the hand-written loader bundle registering the settings card (0.1.7+'s `plugins.row.config` / 0.1.5's `settings.plugin.item`). |
| `tools/repair-session-events.mjs` | Scan / repair session logs broken by custom session events (adds `ignorable: true`, with backup and self-check). |
| `tools/link-harness-runtime.mjs` | Extract the module closure from an installed DSH payload into `node_modules/` so local tests can resolve `@deepseek-ai/*`. |
| `install.mjs` | Install / uninstall into a profile. |

## Marking it as a DSH plugin

This repository uses three machine-readable markers plus two conventions to say it is a DSH (DeepSeek Harness) plugin project:

| Layer | Where | Value |
|---|---|---|
| Manifest role | `package.json` → `dsh` | `{ "bundle": { "patch": "./cordis.patch.yml" } }` — the profile launcher loads this row as a bundle layer. |
| Browser half | `package.json` → `dsh.client` | `{ "platform": "web" }` + exporting `./client` — client-modules uses this to mount it into the boot graph as a browser plugin, which is where the settings card comes from. |
| Package identity | `package.json` → `name` / `version` / `author` / `license` | Named and versioned, so it appears in DSH's plugin inventory (the `dsh_plugin_packages` request field). |
| Search keywords | `package.json` → `keywords` | `dsh-plugin`, `dsh`, `deepseek-harness`, `web-search`, `search-provider`, `clinepass`, `vercel-ai-gateway`, `openai-compatible`. |
| Repository topics | GitHub repo topics | `dsh-plugin`, `deepseek-harness`, `dsh`, `web-search`, `clinepass`, `vercel-ai-gateway`, `openai-compatible`. |

All of these are applied here. To reproduce them on a new fork or repository (topics and description need repository permission; when `gh` is unavailable, set them through the API):

```powershell
$token = "<your GitHub PAT with repo scope>"
$repo  = "qujinting/dsh-plugins"

# topics
curl.exe -X PUT -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" `
  "https://api.github.com/repos/$repo/topics" `
  -d '{"names":["dsh-plugin","deepseek-harness","dsh","web-search","clinepass","vercel-ai-gateway","openai-compatible"]}'

# description
curl.exe -X PATCH -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" `
  "https://api.github.com/repos/$repo" `
  -d '{"description":"DSH plugins: web_search provider that searches with the session\u0027s selected model via gateway-native search tools (vercel:perplexity_search), replacing the built-in DeepSeek-only provider."}'
```

## License

MIT, see [LICENSE](LICENSE).
