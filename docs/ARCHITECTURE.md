# 架构、依赖与兼容性

本文面向要理解实现或参与维护的人。普通安装与使用请看 README。

## 内部原理

### opencode 侧（逆向自 `cannwork-auth.js`）

opencode 插件通过三个钩子工作：

1. **`config`** — 注册 `cannbot` provider（OpenAI 兼容，`baseURL` 指向网关），
   并用 JWT 调 `GET /cannbot/api/models/personal` 动态拉模型列表
2. **`auth`** — 声明一个 `CANNBOT Virtual Key (VK)` 登录方式
3. **`chat.headers`** — **每个请求**注入 `x-api-vkey` / `api-key` / `Authorization: Bearer <JWT>`

网关 base URL：`https://cannbot.hicann.cn/gateway/compatible-mode/v1`

### DSH 侧（本插件）

本插件是一个 **first-class `LlmAdapter`**：直接用 `fetch` + SSE 讲网关的
OpenAI 兼容协议，不包一层 provider SDK，因此**没有任何第三方运行时依赖**。

- **接入点**：`ctx.llm.registerAdapter(['cannbot'], adapter)`——DSH 文档化的扩展点
- **凭据每次请求现读磁盘**，不缓存 → CANNWork 刷新令牌后，下一个 DSH 请求立刻生效，**无需重启**
- **注册不阻塞网络**：先用内置兜底模型挂载，catalog 拉取成功后替换
- **目录会刷新，不是只拉一次**：`catalogRefreshMs`（默认 10 分钟，`0` 关闭）后台刷新；
  请求遇到 `AUTH` / `MODEL_UNSUPPORTED` 时触发一次短冷却重试（登录刷新或换号后名册可能已变）。
  刷新成功同时发 `llm/adapters-updated` 与 0.2.2+ 的 `llm/models-updated('cannbot')`；
  刷新失败保留旧目录，不会把可用的名册换成空表
- **catalog 去重**：网关的 `builtinModels` 与 `personalModels` 两列会重叠
  （实测 10 行仅 7 个唯一 id），而 DSH 对重复 id 直接报 `INVALID_CATALOG`，
  故按「personal 优先」去重
- **VK 按模型取**：catalog 每行自带该模型的 `apiKey`，builtin 行与账号级 VK 不同；
  请求时优先用该行 VK，缺失（或还在兜底目录）才回退 `auth.json` 的账号 VK
- **多轮保真**：assistant 历史里的 `reasoning_content` 会回传给网关，
  工具调用以 `tool_calls` / `tool_call_id` 往返（已实测）
- **usage 自洽**：网关 `prompt_tokens` 含缓存命中，adapter 映射成内核的三桶 DISJOINT；
  并按宿主 `normalizeUsage` 的不变式做防护——命中数 clamp 到 prompt、`null`/字符串/负数
  不计、`reasoning_tokens` clamp 到 output、`totalTokens` 与桶不一致时用 prompt+output
  派生。宿主遇到自相矛盾的样本会**整条丢弃**，所以这里不能只保证“数字大致对”
- **失败分类**：映射到 DSH 的错误体系（`MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` /
  `AUTH` / `RATE_LIMIT` / `SERVER` / `QUOTA` / `CONTEXT_WINDOW_EXCEEDED` / `TIMEOUT` /
  `TRANSPORT` / `MALFORMED_RESPONSE` 等），并按 `Retry-After`（秒或 HTTP-date）
  回填 `providerRetryAfterMs`。未知的 `finish_reason`（含 `content_filter`）抛
  `INVALID_RESPONSE`，不再伪装成干净的 stop；流内 `event.error` 保留真实 status
- **403 不一律当凭据问题**：网关对「模型不在你的名册」和「凭据失效」都回 403，
  只有正文把拒绝挂到某个模型上（如 `Model … not allowed`）才判 `MODEL_UNSUPPORTED`，
  其余 403 仍判 `AUTH`——否则用户会为拼错的模型名去重登 CANNWork
- **多模态（图片）**：`inputModalities` 按模型声明——命中 `visionModels` 的模型报
  `['text','image']`，其余报 `['text']`。图片走 DSH 的附件服务：适配器在请求前用
  `attachments.readImageRequest(ref, target)` 取“请求版本”字节（默认等比缩到
  4,194,304 像素 / 1MiB 内，不放大），再序列化成 OpenAI 视觉内容块：
  先是可读的 handle 文本（图片名、请求尺寸、只读副本路径，模型可用工具自己读取），
  紧接 `{"type":"image_url","image_url":{"url":"data:<media>/base64,…"}}`。
  只要消息里没有图片，`content` 仍是字符串，**纯文本 wire 与旧版完全一致**
- **超限自动降级**：单请求累计 base64 图片默认封顶 8MiB（实测网关体限在 12–16MB 之间），
  超出时抛 `IMAGE_OFFLOAD_REQUIRED`（带 `offloadImages` 计数），由 DSH 的
  `dsh-compaction-image-offload` 把最旧的图片换成占位文本并重试；`offloaded` 的图片
  永远只发占位文本，不会读字节。图片**计数**上限（`maxRequestImages`）默认是一个远高于
  真实请求的占位值，因为网关没有公布计数限制；字节预算才是当前的实际约束
- **图片失败的分类**：网关了拒绝图片时回 400（正文含 `image_url` / `image format` /
  `image length and width` 等字样），判 `UNSUPPORTED_CONTENT` 并给出可操作建议；
  413（请求体超限）判 `INVALID_REQUEST` 并点名图片预算配置项。二者都不会被误报成登录问题
- **附件服务是懒依赖**：`ctx.get('attachments')` 在请求路径上解析，插件在没有附件服务的
  部署里照样挂载；真收到图片时才给明确拒绝

### 设置页与状态接口

设置页是插件的**浏览器半部**（`client.js`，`dsh.client`），不是 Host 路由：

- `settings.section` id `cannbot-connect`：DSH 设置导航里的完整页面；
- `settings.models.footer` id `cannbot-connect`：Models 页底部的折叠卡片；
- 两者共用同一 React 面板，读写 `ctx.configForms.get('llm-cannbot')`；
- 配置字段全部是 volatile，写入通过 `settings.mutate`，携带 revision，冲突会返回 false；
- Host 监听 `loader/volatile-update`，重新解析配置并更新 adapter/catalog，不需要重启；
- `refreshNonce` 是内部动作字段：设置页写入随机字符串，Host 只在值变化时刷新目录。

状态接口是唯一的 HTTP 面：

```
GET /cannbot-connect/status
```

它由 `lib/web.js` 注册到 DSH 已有的 `webServer`，`auth: 'required'`，只读，返回
凭据存在性/过期时间、模型目录、最近刷新/失败分类和有效配置。JWT、VK、完整凭据路径和
原始上游错误不会进入响应（`lib/status.js` 负责脱敏）。

**为什么不是内置 Models provider 行？**

`dsh-client-ui-settings-models` 的 `ProviderEditor` 只对 `llm-deepseek` 和
`llm-pi-ai` 做完整字段编辑；其他命名空间走 `unknown` 布局，Apply 被禁用。workbuddy 的
真实模型配置页也是它自己的 `settings.section`，而不是内置行。本插件保留自定义
`LlmAdapter`，因此不注册 configurable-provider 目录项，避免生成一个可见但不可编辑的
死行；Settings 页 + Models footer 是当前宿主能力下的完整替代。

### 数据类型：哪些能发、哪些由宿主处理

DSH 的消息词汇只有 `text` 与 `image` 两种模态；适配器能决定的只有图片。逐类口径如下
（完整实测表见 [`docs/capability-matrix.md`](capability-matrix.md)）：

| 输入 | DSH 表示 | 本插件做什么 | 说明 |
|---|---|---|---|
| 文本 | text block | 拼成 `content` 字符串 | 与旧版 wire 一致 |
| 用户图片 | image block + 附件引用 | handle 文本 + `image_url` data URL | 只有实测能读图的模型声明 `image` |
| 工具结果图片 | tool 消息里的 image block | 数组 content（text + `image_url`） | 已实网验证 |
| 文件（PDF/代码等） | file block + 持久字节 | **不发送**；宿主先 `projectFilesToText` 投影成只读 handle 文本 | 模型用工具按路径读；适配器收到 file block 视为调用方错误并拒绝 |
| 音频 / 视频 | DSH 没有对应 content block | 不支持 | 不要按 CANNWork 的 `modalities` 声明去猜 |
| reasoning / tool-call / usage | 各自的结构化 chunk | 按 DSH 契约映射 | 见 §5.2 |

> CANNWork 给每个模型声明 `image/pdf/audio/video`，那是它的平台声明，不是逐模型实测。
> 本插件只按实测的精确 model id 开放图片；未实测的一律纯文本。

---

## 依赖与平台

插件**零运行时依赖**：只把自己私有的实现留在代码里，宿主提供的包全部声明为
`peerDependencies`，`devDependencies` 仅用于跑 `e2e.mjs`。

| 包 | 声明 | 说明 |
|---|---|---|
| `@deepseek-ai/dsh-llm` | peer `>=0.2.2-rc.3 <0.3.0` | DSH 宿主提供（`LlmAdapter`、错误体系） |
| `@deepseek-ai/schemastery` | peer `>=3.18.5 <4.0.0` | DSH 宿主提供（`Config` schema） |
| `@deepseek-ai/cordis` | peer `>=4.0.5 <5.0.0` | DSH 宿主提供（运行时容器） |

> DSH profile 使用 `nodeLinker: hoisted` + `autoInstallPeers: false`，
> 所以 `peerDependencies` 不会被装进 profile，只在运行时向宿主解析。
> 实测：`dsh plugin add` 只新增 **1 个包**（插件自己）。

### 平台依赖与兼容性

插件是纯 ESM JavaScript：**没有原生模块、没有安装脚本、运行时不起子进程/独立服务**；设置页的状态路由注册到 DSH 已有的 `webServer`。
平台差异只落在两处：

1. **凭据文件位置**：当前 CANNWork/opencode 在三个平台都用
   `~/.local/share/opencode`（JWT）与 `~/.config/opencode`（VK）；插件同时支持
   `XDG_*` 覆盖，并把 macOS `~/Library/...`、Windows `%LOCALAPPDATA%`/`%APPDATA%`
   作为 opencode 未来迁移的兜底。顺序与风险见 [`docs/PLATFORMS.md`](PLATFORMS.md)。
2. **开发脚本**：`npm test` / `npm run check` 由 Node 驱动，不依赖 `&&` 或 `sh`；
   `check-secrets.sh` 只是 POSIX 包装，canonical 实现是 `scripts/check-secrets.mjs`。

当前只在 Linux 实机验证；macOS/Windows 的路径候选通过注入 `platform`/`env`/`home`
的单元测试覆盖，路径分隔符、ACL、长路径等未实机执行，已在 `docs/PLATFORMS.md`
的风险表中列明。

---

## 兼容性判定

DSH 宿主**只按 `engines.dsh` 判定**插件是否兼容：该字段存在时 `peerDependencies` 不参与
判定（`dsh-app-boot` 的 `unmetRequirements` 逻辑）；只有没有 `engines.dsh` 时才逐个检查
`@deepseek-ai/dsh*` peer。判定时 prerelease 参与区间匹配（`includePrerelease: true`），
所以 `0.2.3-alpha.2` 落在下面的区间内：

```json
"engines": { "dsh": ">=0.2.2-rc.3 <0.3.0", "node": ">=24.9.0" },
"peerDependencies": { "@deepseek-ai/dsh-llm": ">=0.2.2-rc.3 <0.3.0" }
```

早期版本把 `dsh-llm` 精确钉成 `0.2.1-rc.2`，App 升到 `0.2.1-rc.3` 后就被判为
`incompatible` 并拒绝启动——**精确钉版本在宿主小版本升级时会立刻失效**，所以现在用区间。
0.2.1 线（Node 22）已不再支持；0.2.2-rc.3 与 0.2.3-alpha.x 是当前验证的两条线。

升级内核后若被判定不兼容，先确认契约是否真的变了（本插件只依赖 `LlmAdapter` 基类与
`StreamChunk` 协议），再相应放宽区间。

#### 0.2.3-alpha 的导入面变化（0.3.2 已适配）

`@deepseek-ai/dsh-llm@0.2.3-alpha.2` 删除了 `assertUsableApiKey` 与 `normalizeApiKey`
两个导出（官方迁移说明见 alpha 安装包的
`docs/upgrade-guide/v0.2.2-rc.3/deepseek-request-auth/guide.md`：改用
`@deepseek-ai/dsh-credentials` 的 `normalizeApiKey`）。但本插件同时支持 0.2.2 线，而
0.2.2 的 `dsh-credentials` 还没有这个导出，因此插件在本地实现同一套规则
（`trim` → 非空 → 可打印 ASCII 且不含空格），缺失凭据报 `MISSING_CREDENTIAL`、格式非法报
`INVALID_CREDENTIAL`。`test/import-surface.mjs` 会在测试期把"导入了宿主不存在的符号"变成
失败，`scripts/host-matrix.mjs` 会分别对 0.2.2 线与 alpha 线跑同一套离线测试。

**已验证**：0.2.2-rc.3 与 0.2.3-alpha.2 上同一套离线测试全部通过；两条宿主线的实网 e2e 与
alpha 的实机激活也已验证。

---
