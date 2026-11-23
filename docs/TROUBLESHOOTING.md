# 故障排查

先确认 CANNWork 已登录、DSH 已重启、模型选择器里有 CANNBOT 分组。下面的表按用户看到的现象组织。



| 现象 / code | 原因 | 处理 |
|---|---|---|
| 模型列表很久不出现，日志 `catalog unavailable (auth)` | `session.json` 缺失或 JWT 过期 | 重开 CANNWork 登录；插件会在下一个请求的 `AUTH` 后自动重试目录 |
| `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` | 两个凭据之一缺失 / 含空格换行等无法进 HTTP 头的字符 | 重开 CANNWork 让它重写文件；不要手改 opencode 的 auth.json |
| `AUTH` + 提示重登 | 401，或正文不点名模型的 403 | 确认 CANNWork 登录态；若刚换号，等目录刷新或重载插件 |
| `MODEL_UNSUPPORTED` | 403 且正文把拒绝挂到某个模型（名册过期/无权限） | 重新拉目录；不要为此重登 |
| `UNSUPPORTED_CONTENT` | 图片发给了纯文本模型、图片格式/尺寸不符，或 file block 绕过了宿主投影 | 换 `visionModels` 内的模型；检查图片；不要手写 file block |
| `IMAGE_OFFLOAD_REQUIRED` | 单请求图片累计超出预算 | 宿主会自动 offload 最旧图片并重试；持续出现则调低 `maxRequestImageBytes` |
| `TIMEOUT` / `STREAM_CLOSED` | 网关挂起或流提前结束 | 重试；`deepseek-v4-flash` 带图会挂起，已默认排除 |
| `INVALID_CONFIG`（挂载期） | `baseURL`/`modelsURL` 非 https 或非法 URL | 用 https；本地 mock 仅允许回环 http |
| 设置里没有 CANNBOT | 浏览器半部未加载，或宿主没有 `configForms` | 确认 DSH 为 0.2.3 线并重启；检查插件是否启用；旧 0.2.2 只保留 adapter |
| 设置页显示“状态接口不可用” | Desktop 或无 `webServer`，或未登录 Web GUI | 配置仍可编辑；凭据/目录状态需在 Web GUI 查看 |
| 保存提示冲突 | 另一个标签页或外部编辑改了同一配置 | 刷新页面后重试；插件不会静默覆盖 |
| 改了图片开关但选择器未变 | 保存失败，或模型目录尚未刷新 | 看保存反馈；点“刷新模型目录”后重试 |
| 设置页显示“配置未生效” | 被写入的端点没有通过 https 校验 | 恢复默认或把端点改回 https；插件保留旧端点继续工作 |
