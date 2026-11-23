# 手动安装与挂载

通常只需要 README 的安装命令。本文覆盖 CLI 不可用、特殊 profile、以及手动编辑 patch 的场景。
安装并重启后，打开 **设置 → CANNBOT** 即可使用完整配置页；Models 页底部的 CANNBOT 卡片也是同一入口。

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
