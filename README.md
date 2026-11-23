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

此外，插件**支持图片输入**：网关的 OpenAI 兼容端接受 `image_url` 内容块，插件按每个模型
实测的多模态能力声明 `text` / `text+image`，把 DSH 的图片附件转成 `data:` URL 发出去；
文本模型仍由前端准确拒绝（详见 §5.2 与 §8.1）。

---

## 2. 前置条件

**必须先装过 CANNWork 并登录过。** 插件不产生凭据，只消费它们：

| 凭据 | 文件 | 由谁写入/续期 |
|---|---|---|
| JWT | `~/.local/share/opencode/session.json` → `accessToken` | CANNWork，24h 有效，自动刷新 |
| VK | `~/.config/opencode/auth.json` → `cannbot.key`（请求时优先用 catalog 该行的 `apiKey`） | CANNWork |

插件会**按顺序自适应查找** opencode 的两个目录，不同版本的 CANNWork/opencode 写在哪一处都能读到：

1. 数据目录：`$XDG_DATA_HOME/opencode`（默认 `~/.local/share/opencode`）
2. 配置目录：`$XDG_CONFIG_HOME/opencode`（默认 `~/.config/opencode`）

- **JWT**：先找数据目录的 `session.json`，再找配置目录的。
- **VK**：先按 `cannbot.key` 找两处的 `auth.json`；旧版 opencode 把同一个 `vk-…` 值存在
  `auth.json` 的 `cannbot-cli.refresh` 里，作为兜底（只接受 `vk-` 开头的值，避免把真正的
  刷新令牌当成 VK 发出去）。
- **逐模型 VK（优先）**：`GET /cannbot/api/models/personal` 每一行自带该模型的 `apiKey`，
  builtin 行与账号级 VK 并不相同。请求某个模型时优先用它那一行的 VK；行内没有、或
  catalog 还没拉到（仍在内置兜底模型）时才回退到上面 `auth.json` 的账号 VK。

没登录过的话，插件仍会注册但不能用——请先确认某处 `session.json` 里存在 `accessToken`，
或直接跑 `node e2e.mjs` 看它报什么。

其他要求：

- **DSH 内核 `>=0.2.2-rc.3 <0.3.0`、Node `>=24.9.0`**（宿主按 `engines.dsh` 判定兼容性；0.2.1 线不再支持）
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

离线回归不需要网络，也不需要 CANNWork 登录（自带 mock 网关与断言）：

```bash
npm install
npm test              # 全部离线脚本：导入面 / Config / 清单 / 插件契约 / wire / 错误 / 安全 / usage / 凭据 / 图片
npm run test:compat   # 同一套离线脚本分别跑 0.2.2-rc.3 与 0.2.3-alpha.2 两条宿主线
npm run check         # 上面两项 + 密钥扫描（commit 前跑）
```

`test:compat` 通过 `scripts/host-matrix.mjs` 为每条宿主线建一个临时包根，复制 `lib/` 与
`test/`、链接该宿主自己的 `@deepseek-ai/*` 包后再跑。它存在的直接原因：alpha 删除了
`assertUsableApiKey`，而仓库默认的 `node_modules` 只指向一条宿主线；没有矩阵时，
这类"导入面删除"只能在激活日志里看到。

与真实网关的端到端验证需要 CANNWork 已登录：

```bash
node e2e.mjs
```

它会用真实的 `LlmRuntime` 注册插件，然后依次验证：模型列表与多模态声明、模型元信息、
一次文本+推理回合、**一次工具调用**、**工具结果的多轮回放**，以及**两次真实的图片回合**
（用户消息里的图片 + 工具结果里的图片；附件服务换成内存假实现，图片以真实 PNG 字节发到网关）。
成功输出形如：

```
jwt: present
vk : present
[info] dsh-cannbot-connect: 7 models available
models: 7 -> deepseek-v4.1-flash, qwen3.8-max, qwen3.8-flash,
             glm-5.3, glm-5.3-flash, deepseek-v4-flash, deepseek-v4-pro
resolve deepseek-v4.1-flash: context=1048576 efforts=minimal/low/medium/high/max/xhigh input=text+image
ok   vision model: deepseek-v4.1-flash advertises text+image
ok   text-only model: glm-5.3 resolves without image
plain: finish={"kind":"stop"} text="PONG" reasoning=30ch
ok   text turn returned the expected reply
ok   usage is disjoint (in=36 cacheRead=0 out=11 total=47)
tool : finish={"kind":"tool-calls"} calls=get_weather({"city": "Beijing"})
ok   tool call assembled (get_weather city=Beijing, id=call_00_...)
ok   tool result replayed into a final answer
image: finish={"kind":"stop"} text="Blue"
ok   image bytes reached the model through the live gateway
ok   image turn bills visual tokens (plain=36 image=273)
tool-image: finish={"kind":"stop"} text="Screenshot captured. The page…"
ok   tool-result image bytes reached the model in the tool message

PASS: CANNBOT is reachable through the DSH LLM seam.
```

失败时会打印 `FAIL: ...` 并以退出码 1 结束，例如：

- `jwt: MISSING` → 没登录过 CANNWork
- `the live catalog did not load` → JWT 过期，重开 CANNWork 再试
- `no catalog model advertises image input` → 目录或 `visionModels` 配置不对，先跑 §8.1 的探测脚本

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

### 5.3 数据类型：哪些能发、哪些由宿主处理

DSH 的消息词汇只有 `text` 与 `image` 两种模态；适配器能决定的只有图片。逐类口径如下
（完整实测表见 [`docs/capability-matrix.md`](docs/capability-matrix.md)）：

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

## 6. 依赖说明

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
    # 图片：哪些 catalog 模型声明为可收图（默认是实测白名单，见 §8.1）
    visionModels:
      - deepseek-v4.1-flash
      - qwen3.8-max
      - qwen3.8-flash
      - glm-5.3-flash
    # 单图投影：像素上限与编码字节上限（等比缩小，不放大）
    requestImagePixelBudget: 4194304
    requestImageMaxBytes: 1048576
    # 单请求累计 base64 图片上限；超出触发图片降级重试
    maxRequestImageBytes: 8388608
    # 图片计数上限与每次计数溢出的降级步长；网关未公布计数限制，默认是占位大值
    maxRequestImages: 1000000
    imageOffloadCountQuantum: 1000000
    # 目录后台刷新间隔（毫秒）；0 关闭定时刷新，挂载拉取与失败重试仍保留
    catalogRefreshMs: 600000
```

`visionModels: []` 即完全回到文本模式（前端会以「模型不支持图片输入」拒绝附件）。
所有字段都有默认值，不写 `config` 也能工作。

---

## 8. 已知限制

- **图片输入按模型白名单**：网关不披露多模态能力，`visionModels` 是实测结果（见 §8.1）。
  名单外模型一律只声明 `text`，前端会直接拒绝附件；新增视觉模型需跑探测脚本后写进配置
  （或等插件发版更新默认名单）。
- **`deepseek-v4-flash` 带图会挂起**：同模型纯文本请求约 1–2s 返回，带图请求多数时候 30s+ 无响应
  （偶尔能成功并正确读出颜色），所以不列入白名单；若手动加入，会在 `streamIdleTimeoutMs`
  （默认 300s）后报 `TIMEOUT`。
- **`glm-5.3` 的图片通道不可用**：它带图时也返回 200 并计入图片 token，但会告诉用户
  “base64 数据被截断、无法查看图片”；只有 `glm-5.3-flash` 能正常读图。这类“看似支持、
  实则看不到图”的情况是白名单必须实测而不是按模型家族推断的原因。
- **视觉 token 不做路由侧定价**：同一张 768² 图实测各模型计入的 prompt token 差异极大
  （`glm-5.3-flash`≈737、`qwen3.8-max`≈540、`deepseek-v4.1-flash`≈351、`glm-5.3`≈38 且它
  根本读不到图），统一公式只会算错，故不实现 `imageRequestPricing`：宿主先用启发式估算，
  请求完成后以网关返回的 usage 为准（上游 `dsh-llm-pi-ai` 同样不实现）。副作用是
  `dsh-spill-policy` 无法为含图工具结果算 token（与 pi-ai 一致），图片不会被它的
  `maxInlineTokens` 裁剪。
- **请求体上限**：实测 12MB 的请求体能通过解析（随后被图片校验 400 拒绝），16MB 直接回 413。图片总预算默认 8MiB，超限自动降级；
  若会话文本/工具 schema 本身极大仍可能撞 413（分类为 `INVALID_REQUEST` 并提示调小预算）。
- **图片格式与尺寸**：png/jpeg/webp/gif 均可（实测 `qwen3.8-flash`）；边长 ≤10px 会被网关
  400 拒绝，adapter 分类为 `UNSUPPORTED_CONTENT`。
- **历史图片每轮重传**：OpenAI 兼容协议没有 file id / 对象存储，多轮会话里历史图片会随每次
  请求重发，这是协议固有成本；单请求预算与自动降级负责兜底。
- **不支持 `off` 档位**：网关对 `reasoning_effort=off` 返回 400 `InvalidParameter`，
  故只提供 `minimal/low/medium/high/max/xhigh`；不指定档位即用 provider 默认
- **强依赖 CANNWork 登录**：JWT 24h 过期，靠 CANNWork 自动续期；DSH 侧只读，
  令牌过期就跟着失效，重开 CANNWork 即恢复
- **`auth.json` 是 opencode 的密钥库**：读不到时按「未配置」降级，不抛错
- **模型按账号可见性返回**：换账号后重新请求即反映新 roster（无需重启）
- **内核版本敏感**：`LlmAdapter` 契约在 DSH 版本间可能变化，升级内核后请重跑 `npm run test:compat` 与 `node e2e.mjs`
- **文件不是 wire 模态**：PDF/代码等以宿主投影的只读 handle 文本到达模型，由模型用工具读取；
  插件不发送原始文件字节。音频/视频没有 DSH content block，不支持
- **图片计数上限是占位值**：网关未公布每请求图片数上限，`maxRequestImages` 默认 `1000000`
  只是类型占位；真正生效的是 8MiB 字节预算。实测到计数限制后再收紧
- **只支持 0.2.2 线及以上**：`engines.dsh` 为 `>=0.2.2-rc.3 <0.3.0`，Node `>=24.9.0`；
  alpha 线自身要求 Node `>=24.22.3`（由宿主约束）

### 8.1 图片能力实测与更新（2026-11-17）

`GET /cannbot/api/models/personal` 只给 `title / model / apiKey / contextLength /
completionOptions / roles`，**不含模态字段**，所以能力只能实测。探测脚本复用插件自己的
凭据读取与 catalog 逻辑：

```bash
node scripts/probe-vision.mjs                 # 退出码 0=全部有结论，1=环境问题，2=有模型超时或无法判定
node scripts/probe-vision.mjs --timeout-ms 40000
```

它对每个 catalog 模型各发一张 64×64 纯色 PNG（蓝、红各一次），两次都必须说出正确颜色才算
视觉——因为 200 和 token 计数本身都不能证明模型真的看到了图：

| 模型 | 实测结果 | 结论 |
|---|---|---|
| `deepseek-v4.1-flash`、`qwen3.8-max`、`qwen3.8-flash`、`glm-5.3-flash` | 蓝→`Blue`、红→`Red` | 视觉 |
| `glm-5.3` | 200 且计入图片 token，但称 base64 被截断、读不出颜色 | 文本 |
| `deepseek-v4-pro` | 400 `Invalid content type. image_url is only supported by certain models`（偶尔长时间无响应） | 文本 |
| `deepseek-v4-flash` | 多数带图请求超时；偶发一次成功读出颜色 | 不声明（挂起风险） |

网关模型变化后重跑脚本，把输出的 `visionModels:` 数组粘进 §7 的配置即可，无需改代码。

### 8.2 故障排查

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

### 兼容性声明与判定规则

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

**已验证**：0.2.2-rc.3 与 0.2.3-alpha.2 上同一套离线测试全部通过；alpha 的实机激活与模型
链路验证记录见 `docs/`（若尚未补录则为未验）。

---

## 9. 安全说明

### 9.1 凭据去向

本插件处理的只有两个凭据，都来自 CANNWork 写下的本机文件：

| 凭据 | 读取位置（按顺序） | 发送到 |
|---|---|---|
| JWT（`accessToken`） | 数据目录 `opencode/session.json` → 配置目录（`$XDG_DATA_HOME` / `$XDG_CONFIG_HOME`） | `baseURL` 与 `modelsURL` |
| VK（`cannbot.key`） | **配置目录优先** → 数据目录（当前 CANNWork 写配置目录，旧副本不得遮蔽新值） | 仅 `baseURL` |
| VK（legacy `cannbot-cli.refresh`，仅 `vk-` 前缀） | 数据目录 → 配置目录 | 仅 `baseURL` |
| VK（逐模型 `apiKey`，最高优先） | `modelsURL` 返回的对应模型行 | 仅 `baseURL` |

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
- **防头注入**：凭据经插件自己的 `normalizeCredential()` 校验——只允许可打印 ASCII、
  不含空格——换行之类无法进入 HTTP 头。该规则与旧宿主 `assertUsableApiKey` 一致，
  在 0.2.2 与 0.2.3-alpha 两条宿主线上都成立。
- **零运行时依赖**：不引入第三方供应链；安装期无 `postinstall`/`preinstall` 脚本。
- **不写盘**：插件只读凭据文件，从不写回。

### 9.3 回归测试

```bash
npm test              # 全部离线脚本，不需要 CANNBOT 登录
npm run test:compat   # 同一套脚本跑 0.2.2-rc.3 与 0.2.3-alpha.2 两条宿主线
npm run check         # 上面两项 + 密钥扫描
node e2e.mjs          # 实网端到端（需 CANNWork 登录，消耗额度）
```

| 脚本 | 覆盖 |
|---|---|
| `import-surface.mjs` | 插件导入的每个 `dsh-llm` 符号在该宿主存在；`schemastery` 默认导出可调用 |
| `config.mjs` | `Config` 默认值、显式值、非法类型/边界 |
| `manifest.mjs` | `package.json`、`dsh.bundle.patch`、patch 行 id/name、打包文件、无安装脚本、locale/icon/detail 元数据 |
| `plugin.mjs` | `apply` 注册 `cannbot`、返回 disposer、非法端点挂载期拒绝、无 `ctx.effect` 仍可挂载 |
| `wire.mjs` | 消息/工具/请求体 golden（含 reasoning 与 tool_calls）、SSE 分帧（CRLF/comment/`[DONE]`/尾帧） |
| `errors.mjs` | 401/403 模型/429/5xx/413/图片 400/上下文/配额 分类、Retry-After 秒与 HTTP-date、脱敏、端点校验 |
| `credentials.mjs` | 配置目录优先的 VK、legacy 回退、JWT 过期解码、`authStatus` 不含值、头注入规则 |
| `catalog.mjs` | 挂载拉取、并发单飞行、定时刷新、失败保留、`refreshSoon` 冷却、dispose 停止 |
| `adapter-meta.mjs` | `listModels`/`resolveModel`（context 取整、`defaultMaxTokens`）、图片计数/字节预算、file block 拒绝 |
| `adapter-finish.mjs` | `content_filter`/未知 finish → `INVALID_RESPONSE`、空响应、坏工具 JSON、流内 429 status |
| `security.mjs` | 明文端点拒绝、回环例外、重定向不外传凭据、失败文本脱敏 |
| `adapter-usage.mjs` | 网关 `prompt_tokens` 含缓存命中 → 内核 DISJOINT 三桶，含宿主 `normalizeUsage` gate |
| `adapter-auth.mjs` | 逐模型 VK 优先级、401/403 分类、凭据脱敏、缺失/格式非法凭据 |
| `adapter-image.mjs` | 图片模态声明、data URL/handle 序列化、附件只读一次、offload 预算、取消/超时分类 |

`test:compat` 通过 `scripts/host-matrix.mjs` 为每条宿主线建临时包根（复制 `lib/`、`test/`，
链接该宿主自己的 `@deepseek-ai/*`），所以 alpha 删除 `assertUsableApiKey` 这类变化会在
离线测试里直接失败，而不是等到 bundle 激活日志。

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
