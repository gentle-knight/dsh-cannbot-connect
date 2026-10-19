# dsh-cannbot-connect

把 **CANNBOT 网关**的模型接入 **DeepSeek Harness (DSH)**，复用 CANNWork 已经为 opencode 建立好的登录态，不另起一套 OAuth。

---

## 1. opencode 是怎么接 CANNBOT 的（逆向结论）

opencode 侧由三样东西组成，全部在 `~/.config/opencode/`：

| 组成 | 位置 | 作用 |
|---|---|---|
| 插件 | `plugins/cannwork-auth.js` | 注册 provider、注入认证头 |
| VK | `~/.local/share/opencode/auth.json` → `cannbot.key` | 虚拟密钥，`vk-...` |
| JWT | `~/.local/share/opencode/session.json` → `accessToken` | 登录令牌，HS512，24h 有效 |

插件的三个钩子：

1. **`config`** — 注册 `cannbot` provider，`npm: @ai-sdk/openai-compatible`，
   `baseURL: https://cannbot.hicann.cn/gateway/compatible-mode/v1`；
   再用 JWT 调 `GET /cannbot/api/models/personal` 动态拉模型列表。
2. **`auth`** — 声明一个 `api` 类型的 `CANNBOT Virtual Key (VK)` 登录方式。
3. **`chat.headers`** — **每个请求**注入：
   - `x-api-vkey: <VK>` 和 `api-key: <VK>`
   - `Authorization: Bearer <JWT>`

**关键点：网关要求两个凭据同时具备。** 实测：

```
只带 VK   → 401 {"message":"Access Token required."}
只带 JWT  → 401 {"message":"Virtual Key is required."}
VK + JWT  → 200，正常返回
```

`session.json` 由 CANNWork（`cannbot-toolkit` VS Code 扩展）写入与自动续期
（`api/oauth/refresh`），opencode 插件本身只读不写。

---

## 2. DSH 侧怎么接（本插件做法）

DSH 的模型接入点是 `ctx.llm.registerAdapter(providers, adapter)`，配套基类
`PiAiAdapter` 来自 `@deepseek-ai/dsh-llm-pi-ai`。本插件：

- **凭据每次操作现读磁盘**（`readJwt()` / `readAccountVk()`），不缓存 —— 所以
  CANNWork 刷新令牌后，下一个 DSH 请求立刻生效，无需重启。
- **把凭据挂在 pi-ai 的 `model.headers` 上**。pi-ai 的 openai-completions 客户端
  会把 `model.headers` 合并进请求头，且 `options.headers` 最后合并，因此
  `x-api-vkey` / `api-key` / `Authorization` 都能直达网关 —— 不需要像
  workbuddy 那样起一个 loopback 代理。
- **catalog 去重**：网关返回 `builtinModels` + `personalModels` 两列，同一模型可能
  两边都有（实测 10 行仅 7 个唯一 id）。DSH 的 `INVALID_CATALOG` 对重复 id 直接报错，
  故按「personal 优先」去重。
- **注册不阻塞网络**：先用内置兜底模型挂载，catalog 拉取成功后替换。

---

## 3. 文件

```
dsh-cannbot-connect/
├── lib/index.js        # 插件实现（provider + adapter）
├── cordis.patch.yml    # 挂载声明：insert llm-cannbot
├── package.json
└── e2e.mjs             # 端到端验证脚本
```

---

## 4. 验证（已通过）

用**从 app.asar 解出的真实内核**（`dsh-llm@0.2.1-rc.2`、`@earendil-works/pi-ai@1.1.0`）
跑通，不是拿近似版本模拟：

```bash
node e2e.mjs
```

结果：

```
jwt: present
vk : present
[info] dsh-cannbot-connect: 7 models available
live models: 7 -> deepseek-v4.1-flash, qwen3.8-max, qwen3.8-flash,
                  glm-5.3, glm-5.3-flash, deepseek-v4-flash, deepseek-v4-pro
resolved info: {"provider":"cannbot","id":"deepseek-v4.1-flash",
                "context":{"contextWindow":1048576},
                "reasoning":{"efforts":[off,minimal,low,medium,high]}}
finish: {"type":"finish","reason":{"kind":"stop"}}
text  : "PONG"
```

---

## 5. 安装

装进 DSH 桌面版 profile（把路径换成本仓库在你机器上的位置）：

```bash
git clone https://gitcode.com/gentle-knight/dsh-cannbot-connect.git
dsh plugin --profile desktop add file:$(pwd)/dsh-cannbot-connect
```

然后重启 DSH，模型选择器里会出现 **CANNBOT** 分组。

> 注意：`~/.dsh/profiles/desktop` 由 App 管理。写入该目录需要文件系统授权；
> 官方 Electron 版可能拒绝独立 CLI 写 `desktop` profile。

---

## 6. 前置条件与限制

- **必须登录过 CANNWork**：JWT 和 VK 都由它维护。未登录时插件仍会注册 route，
  但请求会以 401 失败；`e2e.mjs` 会打印 `jwt: MISSING`。
- **JWT 有效期 24h**：靠 CANNWork 自动续期。DSH 侧只读，令牌过期就跟着失效；
  重新打开/登录 CANNWork 即可恢复。
- **`auth.json` 是 opencode 的密钥库**：读不到时按「未配置」降级，不抛错。
- 模型按账号可见性返回；换账号后重新请求即反映新 roster（无需重启）。
