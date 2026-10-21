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

## 2. 前置条件

**必须先装过 CANNWork 并登录过。** 插件不产生凭据，只消费它们：

| 凭据 | 文件 | 由谁写入/续期 |
|---|---|---|
| JWT | `~/.local/share/opencode/session.json` → `accessToken` | CANNWork，24h 有效，自动刷新 |
| VK | `~/.local/share/opencode/auth.json` → `cannbot.key` | CANNWork |

（若你设了 `XDG_DATA_HOME`，路径以它为前缀。）

没登录过的话，插件仍会注册但不能用——请先确认 `session.json` 里存在 `accessToken`，
或直接跑 `node e2e.mjs` 看它报什么。

其他要求：

- **DSH 内核 `0.2.1-rc.2`**（本插件针对该版本的 `LlmAdapter` 契约编写）
- **Node.js `^22.19.0 || >=24.0.0`**
- 能访问 `cannbot.hicann.cn`

---

## 3. 安装

插件**没有任何运行时依赖**，装进 profile 只需要一条命令：

```bash
git clone https://gitcode.com/gentle-knight/dsh-cannbot-connect.git
dsh plugin --profile desktop add file:$(pwd)/dsh-cannbot-connect
```

然后**重启 DSH**，模型选择器里会出现 **CANNBOT** 分组。

> `~/.dsh/profiles/desktop` 由 App 管理。若 CLI 报 `EPERM`，说明该发行版不允许
> 独立 CLI 写 `desktop` profile；此时改用 Web/TUI profile，或参见 §7 手动挂载。

---

## 4. 验证

验证脚本需要几个开发期依赖（宿主内核包，仅测试用）：

```bash
npm install
node e2e.mjs
```

它会用真实的 `LlmRuntime` 注册插件，然后依次验证：模型列表、模型元信息、
一次文本+推理回合、**一次工具调用**、以及**工具结果的多轮回放**。成功输出：

```
jwt: present
vk : present
[info] dsh-cannbot-connect: 7 models available
models: 7 -> deepseek-v4.1-flash, qwen3.8-max, qwen3.8-flash,
             glm-5.3, glm-5.3-flash, deepseek-v4-flash, deepseek-v4-pro
resolve deepseek-v4.1-flash: context=1048576 efforts=minimal/low/medium/high/max/xhigh input=text
plain: finish={"kind":"stop"} text="PONG" reasoning=55ch
ok   text turn returned the expected reply
ok   usage reported (in=36 out=17)
tool : finish={"kind":"tool-calls"} calls=get_weather({"city": "Beijing"})
ok   tool call assembled (get_weather city=Beijing, id=call_00_...)
ok   tool result replayed into a final answer

PASS: CANNBOT is reachable through the DSH LLM seam.
```

失败时会打印 `FAIL: ...` 并以退出码 1 结束，例如：

- `jwt: MISSING` → 没登录过 CANNWork
- `the live catalog did not load` → JWT 过期，重开 CANNWork 再试

---

## 5. 原理

### 5.1 opencode 侧（逆向自 `cannwork-auth.js`）

opencode 插件通过三个钩子工作：

1. **`config`** — 注册 `cannbot` provider（OpenAI 兼容，`baseURL` 指向网关），
   并用 JWT 调 `GET /cannbot/api/models/personal` 动态拉模型列表
2. **`auth`** — 声明一个 `CANNBOT Virtual Key (VK)` 登录方式
3. **`chat.headers`** — **每个请求**注入 `x-api-vkey` / `api-key` / `Authorization: Bearer <JWT>`

网关 base URL：`https://cannbot.hicann.cn/gateway/compatible-mode/v1`

### 5.2 DSH 侧（本插件）

本插件是一个 **first-class `LlmAdapter`**：直接用 `fetch` + SSE 讲网关的
OpenAI 兼容协议，不包一层 provider SDK，因此**没有任何第三方运行时依赖**。

- **接入点**：`ctx.llm.registerAdapter(['cannbot'], adapter)`——DSH 文档化的扩展点
- **凭据每次请求现读磁盘**，不缓存 → CANNWork 刷新令牌后，下一个 DSH 请求立刻生效，**无需重启**
- **注册不阻塞网络**：先用内置兜底模型挂载，catalog 拉取成功后替换
- **catalog 去重**：网关的 `builtinModels` 与 `personalModels` 两列会重叠
  （实测 10 行仅 7 个唯一 id），而 DSH 对重复 id 直接报 `INVALID_CATALOG`，
  故按「personal 优先」去重
- **多轮保真**：assistant 历史里的 `reasoning_content` 会回传给网关，
  工具调用以 `tool_calls` / `tool_call_id` 往返（已实测）
- **失败分类**：映射到 DSH 的错误体系（`AUTH` / `RATE_LIMIT` / `SERVER` /
  `QUOTA` / `CONTEXT_WINDOW_EXCEEDED` / `TIMEOUT` / `TRANSPORT` 等），
  并按 `Retry-After` 回填 `providerRetryAfterMs`

---

## 6. 依赖说明

插件**零运行时依赖**：只把自己私有的实现留在代码里，宿主提供的包全部声明为
`peerDependencies`，`devDependencies` 仅用于跑 `e2e.mjs`。

| 包 | 声明 | 说明 |
|---|---|---|
| `@deepseek-ai/dsh-llm` | peer `0.2.1-rc.2` | DSH 宿主提供（`LlmAdapter`、错误体系） |
| `@deepseek-ai/schemastery` | peer `^3.18.5` | DSH 宿主提供（`Config` schema） |
| `@deepseek-ai/cordis` | peer `^4.0.5` | DSH 宿主提供（运行时容器） |

> DSH profile 使用 `nodeLinker: hoisted` + `autoInstallPeers: false`，
> 所以 `peerDependencies` 不会被装进 profile，只在运行时向宿主解析。
> 实测：`dsh plugin add` 只新增 **1 个包**（插件自己）。

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
已指向它，作为 bundle 安装时会自动生效。也可用 `config` 覆盖默认值：

```yaml
- id: llm-cannbot
  name: dsh-cannbot-connect
  config:
    baseURL: https://cannbot.hicann.cn/gateway/compatible-mode/v1
    streamIdleTimeoutMs: 300000
```

---

## 8. 已知限制

- **文本输入**：本路由对外只声明 `text`。图片/文件块会被明确拒绝，而不是发出去后被网关打回
- **不支持 `off` 档位**：网关对 `reasoning_effort=off` 返回 400 `InvalidParameter`，
  故只提供 `minimal/low/medium/high/max/xhigh`；不指定档位即用 provider 默认
- **强依赖 CANNWork 登录**：JWT 24h 过期，靠 CANNWork 自动续期；DSH 侧只读，
  令牌过期就跟着失效，重开 CANNWork 即恢复
- **`auth.json` 是 opencode 的密钥库**：读不到时按「未配置」降级，不抛错
- **模型按账号可见性返回**：换账号后重新请求即反映新 roster（无需重启）
- **内核版本敏感**：`LlmAdapter` 契约在 DSH 版本间可能变化，升级内核后请重跑 `node e2e.mjs`

---

## 9. 安全说明

### 9.1 凭据去向

本插件处理的只有两个凭据，都来自 CANNWork 写下的本机文件：

| 凭据 | 读取位置 | 发送到 |
|---|---|---|
| JWT（`accessToken`） | `~/.local/share/opencode/session.json` | `baseURL` 与 `modelsURL` |
| VK（`cannbot.key`） | `~/.local/share/opencode/auth.json` | 仅 `baseURL` |

**这两个端点由配置决定**。默认值就是 CANNBOT 官方网关；如果你把 `baseURL` /
`modelsURL` 改到别处，凭据就会发到别处——这一点与所有可配置端点的 provider 相同。

### 9.2 已实施的加固

- **拒绝明文端点**：`baseURL` / `modelsURL` 必须是 `https`；仅回环地址
  （`localhost` / `127.0.0.1` / `[::1]`）允许 `http`。不安全的配置在
  **写入处**就被拒绝，而不是等第一个请求。
- **不跟随重定向**：两个请求都带 `redirect: 'error'`。否则一个 302 就能把
  `Authorization` 转发到别的源。
- **失败文本脱敏**：网关返回的错误正文在进入诊断信息前，会按**值本身**
  （而非正则）把 JWT/VK 替换成 `[redacted]`。
- **防头注入**：凭据经 `assertUsableApiKey()` 校验——只允许可打印 ASCII、
  不含空格——换行之类无法进入 HTTP 头。
- **零运行时依赖**：不引入第三方供应链；安装期无 `postinstall`/`preinstall` 脚本。
- **不写盘**：插件只读凭据文件，从不写回。

### 9.3 回归测试

```bash
npm test        # 离线，不需要 CANNBOT 登录
```

覆盖：明文端点被拒、回环例外、重定向不外传凭据（断言重定向目标**从未被访问**）、
失败文本已脱敏。全部通过输出：

```
ok   plain-http baseURL is refused
ok   plain-http modelsURL is refused
ok   a malformed endpoint is refused
ok   loopback http is allowed (local mock/proxy)
ok   a redirecting endpoint fails the request instead of following it
ok   the redirect target was never contacted (credentials stayed put)
ok   credential material is redacted out of provider failure text

PASS: credential-handling checks hold.
```

### 9.4 仓库本身的卫生

- VK / JWT 不进仓库、不进日志、不进 git 历史
- `.gitignore` 排除 `node_modules/` 与本地验证产物
- `e2e.mjs` 只打印 `present` / `MISSING`
- `check-secrets.sh` 同时扫描工作区与 git 历史，推送前可跑

### 9.5 残留风险（如实说明）

- 本插件读取 opencode 的凭据文件。**能有权限读这些文件的进程，本来就已经持有该凭据**，
  所以这不是新增的暴露面；但它确实把「opencode 的一处凭据」复用到了 DSH。
- 凭据会短暂存在于进程内存中，这是任何使用它们的 adapter 都无法避免的。
- 插件加载时（`apply`）会立刻用 JWT 拉一次模型列表——这是运行期行为、非安装期，
  但如果你不希望启动即联网，可以把 `modelsURL` 指向自己的镜像。

---

## 10. 投稿到插件市场

DSH 插件市场的目录来自 **[awesome-dsh-plugins](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)**：
向 `data/plugins/` 提**一个 YAML 文件**即可，站点与市场会自动收录（通常一天内）。

### 10.1 需要先满足的前置条件

| 条件 | 本仓库现状 |
|---|---|
| `package.json` 声明 `dsh.bundle`（安装前提） | ✅ 已有 |
| 仓库根有 `cordis.patch.yml` | ✅ 已有 |
| 真实可用代码，非占位 | ✅ 有 e2e 与安全测试 |
| 仓库创建满 1 天 | ✅ 已满 |
| 仓库添加 `dsh-plugin` topic | ⚠️ 待加 |
| **`url` 必须是 GitHub 仓库** | ❌ **当前在 GitCode** |

最后一条是硬门槛：该目录现有 **1006 条全部指向 github.com**，投稿指南也写明
`url` 必须与仓库完全一致。因此**想上架，需要一个 GitHub 仓库**（镜像或迁移均可）。

### 10.2 条目文件

在 `awesome-dsh-plugins` 仓库新建 `data/plugins/<owner>__<repo>.yml`：

```yaml
url: https://github.com/<owner>/dsh-cannbot-connect
name: <owner>/dsh-cannbot-connect
category: model
description:
  en: Bring CANNBOT gateway models into DeepSeek Harness by reusing CANNWork's opencode sign-in.
  zh: 复用 CANNWork 的 opencode 登录态，把 CANNBOT 网关的模型接入 DeepSeek Harness。
```

分类用 `model`（"Models & Providers / 模型与账号接入"），与本插件做的事一致。

### 10.3 推荐：发布到 npm

投稿指南指出，发布 npm 包可让安装**跳过构建授权**（`allowBuilds`）。本插件零运行时
依赖，npm 包很小。发布前需要：

1. 删掉 `package.json` 里的 `"private": true`（现在刻意保留，防止误发布）
2. `npm login`（需要你自己的 npm 账号）
3. `npm publish --access public`

不发 npm 也可以：把预构建 tarball 挂到 GitHub Release，然后在条目里加
`tarball: <url>`，市场会优先展示它。

---

## 11. 许可

MIT，见 [LICENSE](./LICENSE)。
