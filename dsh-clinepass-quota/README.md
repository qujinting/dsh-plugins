# dsh-clinepass-quota

用一把 **Cline API Key** 查询 ClinePass 订阅的剩余额度，显示在 DSH 里。

ClinePass 是定额订阅，配额分三档滚动：**5 小时**、**周**、**月**。这个插件把
`api.cline.bot` 的三组数字搬进 Harness：

- **设置 → ClinePass 额度**：三档窗口的剩余百分比、进度条、重置倒计时、按量付费余额，以及 API Key 的录入与删除。
- **会话标题栏徽章**：最紧的那一档还剩多少（≤25% 变黄、≤10% 变红），点开是同一份面板。
- **`clinepass_quota` 工具**：模型自己查，`refresh: true` 绕过缓存。

Key 三种来源：`config.apiKey` → DSH 凭据存储里的 `CLINEPASS_API_KEY` / `CLINE_API_KEY`
（与其它插件共用同一把）→ 插件目录下的只读 `data/credentials.json`。**插件不提供录入界面**，
凭据只在 DSH 里配；面板只读回掩码。余额按微美元精度显示（`$0.190123`），不做分位取整。

```yaml
# profile 的 cordis.patch.yml
- id: dsh-clinepass-quota
  config:
    cacheSeconds: 120
```

完整说明、全部配置项、接口与限制见 [docs/DETAIL.md](docs/DETAIL.md)。

```bash
npm test                                            # 26 个用例：响应解析、存储优先级、缓存/并发/失败降级、apply 接线、客户端工厂
CLINEPASS_API_KEY=cpk_... node tools/check.mjs      # 不经 DSH，直接敲一次上游自检
```

MIT © qujinting
