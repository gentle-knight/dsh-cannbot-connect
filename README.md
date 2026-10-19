# dsh-cannbot-connect

把 **CANNBOT 网关**的模型接入 **DeepSeek Harness (DSH)**，复用 **CANNWork**
已经为 opencode 建立好的登录态，不另起一套 OAuth、不需要额外填任何 key。

> 本仓库**不含任何密钥**。VK 与 JWT 都是运行时从你本机 CANNWork 写下的文件里读取的。

---

## 1. 它解决什么问题

CANNBOT 网关要求**两个凭据同时具备**（实测，缺一即 401）：

| 请求携带 | 网关响应 |
|---|---|
| 只带 VK | `401 {"message":"Access Token required."}` |
| 只带 JWT | `401 {"message":"Virtual Key is required."}` |
| **VK + JWT** | `200`，正常返回 |

而这两个凭据平时只由 **CANNWork**（`cannbot-toolkit` 扩展）维护。本插件做的事情就是：
在 DSH 的请求里自动带上它们，让 CANNWork 里能用的模型在 DSH 里也能直接用。

---

## 2. 前置条件（重要）

**必须先装过 CANNWork 并登录过。** 插件不产生凭据，只消费它们：

| 凭据 | 文件 | 由谁写入/续期 |
|---|---|---|
| JWT | `~/.local/share/opencode/session.json` → `accessToken` | CANNWork，24h 有效，自动刷新 |
| VK | `~/.local/share/opencode/auth.json` → `cannbot.key` | CANNWork |

（若你设了 `XDG_DATA_HOME`，路径以它为前缀。）

没登录过的话，插件仍会注册但不能用——请先在 `~/.local/share/opencode/session.json`
确认存在 `accessToken`，或直接跑 `node e2e.mjs` 看它报什么。

其他要求：

- **DSH 内核 `0.2.1-rc.2`**（本插件针对该版本的 `LlmAdapter` / `PiAiAdapter` 契约编写）
- **Node.js `^22.19.0 || >=24.0.0`**
- 能访问 `cannbot.hicann.cn`

---

## 3. 安装

```bash
git clone https://gitcode.com/gentle-knight/dsh-cannbot-connect.git
cd dsh-cannbot-connect

# 装依赖（插件自身的 pi-ai；DSH 内核包由宿主提供，见 §6）
npm install

# 装进 DSH 桌面版 profile
dsh plugin --profile desktop add file:$(pwd)
```

然后**重启 DSH**，模型选择器里会出现 **CANNBOT** 分组。

> `~/.dsh/profiles/desktop` 由 App 管理。若 CLI 报 `EPERM`，说明该发行版不允许
> 独立 CLI 写 `desktop` profile；此时改用 Web/TUI profile，或参见 §7 手动挂载。

---

## 4. 验证

```bash
node e2e.mjs
```

它会用真实的 `LlmRuntime` 注册插件，拉一次模型列表，再实际流式发一条请求。成功输出：

```
jwt: present
vk : present
[info] dsh-cannbot-connect: 7 models available
live models: 7 -> deepseek-v4.1-flash, qwen3.8-max, qwen3.8-flash,
                  glm-5.3, glm-5.3-flash, deepseek-v4-flash, deepseek-v4-pro
resolved deepseek-v4.1-flash: context=1048576 efforts=off/minimal/low/medium/high
finish: {"kind":"stop"}
text  : "PONG"
reason: 30 chars

PASS: CANNBOT is reachable through the DSH LLM seam.
```

失败时会打印 `FAIL: ...` 并以退出码 1 结束，例如：

- `jwt: MISSING` → 没登录过 CANNWork
- `the live catalog did not load` → JWT 过期，重开 CANNWork 再试

---

## 5. 原理

### opencode 侧（逆向自 `cannwork-auth.js`）

插件通过三个钩子工作：

1. **`config`** — 注册 `cannbot` provider（OpenAI 兼容，`baseURL` 指向网关），
   并用 JWT 调 `GET /cannbot/api/models/personal` 动态拉模型列表
2. **`auth`** — 声明一个 `CANNBOT Virtual Key (VK)` 登录方式
3. **`chat.headers`** — **每个请求**注入 `x-api-vkey` / `api-key` / `Authorization: Bearer <JWT>`

网关 base URL：`https://cannbot.hicann.cn/gateway/compatible-mode/v1`

### DSH 侧（本插件）

接入点是 `ctx.llm.registerAdapter(providers, adapter)`，基类 `PiAiAdapter`
来自 `@deepseek-ai/dsh-llm-pi-ai`。三个实现要点：

- **凭据每次操作现读磁盘**，不缓存 → CANNWork 刷新令牌后，下一个 DSH 请求立刻生效，**无需重启**
- **凭据挂在 pi-ai 的 `model.headers` 上** → 直连网关，不需要像 workbuddy 那样起 loopback 代理
- **catalog 去重**：网关的 `builtinModels` 与 `personalModels` 两列会重叠
  （实测 10 行仅 7 个唯一 id），而 DSH 对重复 id 直接报 `INVALID_CATALOG`，
  故按「personal 优先」去重
- **注册不阻塞网络**：先用内置兜底模型挂载，catalog 拉取成功后替换

---

## 6. 依赖说明

插件**只把自己私有的 `pi-ai` 声明为 `dependencies`**；其余全部是 `peerDependencies`，
因为它们是 **DSH 宿主提供的**，不应由插件再装一份（否则会出现第二个 `LlmAdapter` 类，
`instanceof` 失效）。

| 包 | 声明 | 说明 |
|---|---|---|
| `@earendil-works/pi-ai` | `dependencies: 1.3.0` | 插件私有，`npm install` 会装 |
| `@deepseek-ai/dsh-llm` | peer `0.2.1-rc.2` | DSH 宿主提供 |
| `@deepseek-ai/dsh-llm-pi-ai` | peer `0.2.1-rc.2` | DSH 宿主提供（`PiAiAdapter` 基类） |
| `@deepseek-ai/cordis` | peer `^4.0.5` | DSH 宿主提供 |

> DSH profile 使用 `nodeLinker: hoisted` + `autoInstallPeers: false`，
> 所以 `peerDependencies` 不会被打进你的安装，只在运行时向宿主解析。

已验证：全新 clone → `npm install` → `node e2e.mjs` → `PASS`。

---

## 7. 手动挂载（CLI 不可用时）

把插件加进 profile 的 `package.json` 依赖与 bundles，再在
`cordis.patch.yml` 里声明：

```yaml
- insert:
    - id: llm-cannbot
      name: dsh-cannbot-connect
```

本仓库自带的 `cordis.patch.yml` 内容相同，`package.json` 的 `dsh.bundle.patch`
已指向它，作为 bundle 安装时会自动生效。

---

## 8. 已知限制

- **强依赖 CANNWork 登录**：JWT 24h 过期，靠 CANNWork 自动续期；DSH 侧只读，
  令牌过期就跟着失效，重开 CANNWork 即恢复
- **`auth.json` 是 opencode 的密钥库**：读不到时按「未配置」降级，不抛错
- **模型按账号可见性返回**：换账号后重新请求即反映新 roster（无需重启）
- **内核版本敏感**：`PiAiAdapter` 的构造函数契约在 DSH 版本间可能变化，
  升级内核后请重跑 `node e2e.mjs`

---

## 9. 安全说明

本仓库**不包含、也不会写入**任何凭据：

- VK / JWT 只在运行时从本机 opencode 文件读取，不进仓库、不进日志、不进 git 历史
- `.gitignore` 排除 `node_modules/` 与本地验证产物
- `e2e.mjs` 只打印 `present` / `MISSING`，不打印凭据内容

---

## 10. 许可

MIT，见 [LICENSE](./LICENSE)。
