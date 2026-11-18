/**
 * dsh-clinepass-quota —— 用 Cline API Key 查 ClinePass 订阅的剩余额度。
 *
 * ClinePass 是按月定额订阅，配额分三档滚动：5 小时、周、月。网页端只在
 * app.cline.bot 的订阅页给出百分比，客户端要看到同样的数字，只能去敲
 * `api.cline.bot` 的三个只读接口（见 `api.js`）。
 *
 * 所以这个插件做三件事：
 *
 * 1. **查**：`QuotaService` 拿 API Key 去查 usage-limits / users/me / balance，
 *    60 秒内存缓存，并发请求合并成一次。
 * 2. **看**：Client 半边在设置里放一个「ClinePass 额度」页，并在会话标题栏放
 *    一个徽章按钮 —— 三档窗口的剩余百分比、重置时间、按量付费余额都在里面，
 *    还带 API Key 的录入与刷新。
 * 3. **问**：Host 半边注册 `clinepass_quota` 工具，模型能自己查，并且和界面
 *    走同一个 `state()`，两边不会给出不同的数字。
 *
 * 不 import 任何 `@deepseek-ai/*` 包：profile 安装的插件没有构建期的 runtime
 * link，靠注入拿到的 context 已经够用，也能跟着 harness 升级而不动。
 *
 * @module dsh-clinepass-quota
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readOptions } from './config.js'
import { registerRoutes } from './route.js'
import { QuotaService } from './service.js'
import { KeyStore } from './store.js'
import { clinepassQuotaTool } from './tool.js'

/** Loader 诊断里显示的插件名。 */
export const name = 'dsh-clinepass-quota'

/** 本包目录，用于解析相对的 `dataDir`。 */
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * 挂载插件。
 *
 * @param ctx - 插件上下文。
 * @param config - 组合条目的配置。
 */
export function apply(ctx, config) {
	const options = readOptions(config, (message) => ctx.logger?.warn?.(`clinepass-quota: ${message}`))
	const dataDir = options.dataDir === undefined
		? path.join(PACKAGE_ROOT, 'data')
		: path.resolve(PACKAGE_ROOT, options.dataDir)

	const store = new KeyStore({ dataDir, logger: ctx.logger })
	const service = new QuotaService({
		store,
		options,
		logger: ctx.logger,
		// 凭据服务可能稍后才挂载，所以每次解析时现取，而不是构造时抓住。
		getCredentials: () => ctx.get?.('credentials'),
	})

	if (options.registerTool) {
		ctx.inject(['tools'], (toolsCtx) => {
			if (toolsCtx.tools === undefined || toolsCtx.tools === null) return
			toolsCtx.effect(
				() => toolsCtx.tools.register(clinepassQuotaTool({ toolName: options.toolName, service, options })),
				'clinepass-quota.tool()',
			)
		})
	}

	// webServer 是可选依赖：没有它，工具仍然可用，只是没有设置页。
	if (options.registerRoutes) {
		ctx.inject(['webServer'], (webCtx) => {
			if (webCtx.webServer === undefined || webCtx.webServer === null) {
				ctx.logger?.warn?.('clinepass-quota: 没有 ctx.webServer，设置页与标题栏按钮不可用（工具仍可用）')
				return
			}
			webCtx.effect(() => registerRoutes(webCtx, service), 'clinepass-quota.routes()')
		})
	}

	// 一行可诊断的启动信息：key 从哪来、缓存多久、数据放哪。
	void store.ready.then(async () => {
		const key = await service.keyInfo()
		ctx.logger?.info?.(
			`clinepass-quota: ${key.configured ? `API Key 来自 ${key.sourceDetail}` : '尚未配置 API Key'}`
			+ `；上游 ${options.baseUrl}；缓存 ${String(options.cacheSeconds)}s；数据目录 ${dataDir}`
			+ (store.problem === undefined ? '' : `（${store.problem}）`),
		)
	})
}
