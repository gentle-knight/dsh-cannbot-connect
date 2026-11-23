# 配置

插件不配置也能用。需要调整时，在 profile 的 `cordis.patch.yml` 里给
`llm-cannbot` 行加 `config`：

```yaml
- id: llm-cannbot
  name: dsh-cannbot-connect
  config:
    catalogRefreshMs: 600000
    visionModels:
      - deepseek-v4.1-flash
      - qwen3.8-max
      - qwen3.8-flash
      - glm-5.3-flash
```

修改后重载插件或重启 DSH。

## 常用字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseURL` | CANNBOT 官方网关 | OpenAI 兼容的 chat completions 端点；只支持 https（本机回环除外） |
| `modelsURL` | CANNBOT 模型目录 | 返回当前账号可见模型列表的端点 |
| `catalogRefreshMs` | `600000` | 后台刷新模型目录的间隔；`0` 关闭定时刷新 |
| `visionModels` | 实测白名单 | 允许图片输入的模型 id；不在列表里的模型只收文本。`[]` 表示全部纯文本 |
| `maxRequestImageBytes` | `8388608` | 单请求累计 base64 图片上限；超出时自动降级（见下） |
| `requestImageMaxBytes` | `1048576` | 单张图片编码后的字节目标 |
| `requestImagePixelBudget` | `4194304` | 单张图片缩放后的像素上限（不放大） |
| `maxRequestImages` | `1000000` | 单请求图片计数上限；网关未公布限制，默认是占位大值 |
| `imageOffloadCountQuantum` | `1000000` | 计数超限时一次降级的步长，不得大于 `maxRequestImages` |
| `streamIdleTimeoutMs` | `300000` | 单次上游读取的空闲上限 |
| `defaultContextWindow` | `1048576` | 目录没有给上下文长度时的兜底 |
| `defaultMaxTokens` | `131072` | 目录没有给输出上限时的兜底 |

## 图片降级

当一次请求携带的历史图片超过 `maxRequestImageBytes`（或 `maxRequestImages`）时，插件会向
DSH 返回 `IMAGE_OFFLOAD_REQUIRED`，由 DSH 把最旧的图片替换成占位文本后重试。这是正常
的自动降级，不需要手动处理；如果频繁出现，可以减小 `maxRequestImageBytes`，或者少发
一些图片。

## 自定义网关

如果使用公司镜像或本地代理，把 `baseURL` 和 `modelsURL` 指到自己的端点，并确认该端点
同样接受 `Authorization: Bearer <JWT>` 与 `x-api-vkey`/`api-key` 两个请求头。只支持
https，本机回环地址可以用 http。

## 完整字段

字段定义在 `lib/config.js`，每一行都有默认值和边界；不需要改代码。
