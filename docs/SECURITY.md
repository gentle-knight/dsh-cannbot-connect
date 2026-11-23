# 安全与隐私

这篇文档说明插件读取什么、发送到哪里，以及已经做了哪些防护。

## 凭据去向

本插件处理的只有两个凭据，都来自 CANNWork 写下的本机文件：

| 凭据 | 读取位置（按顺序） | 发送到 |
|---|---|---|
| JWT（`accessToken`） | 数据目录 `opencode/session.json` → 配置目录（`$XDG_DATA_HOME` / `$XDG_CONFIG_HOME`） | `baseURL` 与 `modelsURL` |
| VK（`cannbot.key`） | **配置目录优先** → 数据目录（当前 CANNWork 写配置目录，旧副本不得遮蔽新值） | 仅 `baseURL` |
| VK（legacy `cannbot-cli.refresh`，仅 `vk-` 前缀） | 数据目录 → 配置目录 | 仅 `baseURL` |
| VK（逐模型 `apiKey`，最高优先） | `modelsURL` 返回的对应模型行 | 仅 `baseURL` |

**这两个端点由配置决定**。默认值就是 CANNBOT 官方网关；如果你把 `baseURL` /
`modelsURL` 改到别处，凭据就会发到别处——这一点与所有可配置端点的 provider 相同。

## 已实施的加固

- **拒绝明文端点**：`baseURL` / `modelsURL` 必须是 `https`；仅回环地址
  （`localhost` / `127.0.0.1` / `[::1]`）允许 `http`。不安全的配置在
  **写入处**就被拒绝，而不是等第一个请求。
- **不跟随重定向**：两个请求都带 `redirect: 'error'`。否则一个 302 就能把
  `Authorization` 转发到别的源。
- **失败文本脱敏**：网关返回的错误正文在进入诊断信息前，会按**值本身**
  （而非正则）把 JWT/VK 替换成 `[redacted]`。
- **防头注入**：凭据经插件自己的 `normalizeCredential()` 校验——只允许可打印 ASCII、
  不含空格——换行之类无法进入 HTTP 头。该规则与旧宿主 `assertUsableApiKey` 一致，
  在 0.2.2 与 0.2.3-alpha 两条宿主线上都成立。
- **零运行时依赖**：不引入第三方供应链；安装期无 `postinstall`/`preinstall` 脚本。
- **不写盘**：插件只读凭据文件，从不写回。
- **只读状态面**：`GET /cannbot-connect/status` 注册在 DSH 已有的 Web 服务上，要求认证，
  只返回凭据的 present/expired/来源标签、模型目录和配置摘要；不返回 JWT/VK、完整文件路径
  或原始上游错误；端点只返回去掉 userinfo/query/hash 的展示形式，避免代理凭据或一次性 token
  进入浏览器。这里没有写路由，配置写入走平台 revisioned settings API，避免 CSRF 面。
- **浏览器不接触凭据**：设置页只读状态摘要；模型请求仍由 Host 从本机文件读取凭据。

## 残留风险

- 本插件读取 opencode 的凭据文件。**能有权限读这些文件的进程，本来就已经持有该凭据**，
  所以这不是新增的暴露面；但它确实把「opencode 的一处凭据」复用到了 DSH。
- 凭据会短暂存在于进程内存中，这是任何使用它们的 adapter 都无法避免的。
- 插件加载时（`apply`）会立刻用 JWT 拉一次模型列表——这是运行期行为、非安装期，
  但如果你不希望启动即联网，可以把 `modelsURL` 指向自己的镜像。

---

这段话不能替代安全审计；它是一个只读适配器能做到的边界说明。
