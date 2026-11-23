# dsh-cannbot-connect

[![verify](https://github.com/gentle-knight/dsh-cannbot-connect/actions/workflows/verify.yml/badge.svg)](https://github.com/gentle-knight/dsh-cannbot-connect/actions/workflows/verify.yml)

在 **DeepSeek Harness (DSH)** 里使用 **CANNBOT 网关**的模型。

插件复用 **CANNWork** 已经为 opencode 建立的登录态：不需要另外填 API key，也不需要再走一遍
OAuth。安装后，CANNBOT 的模型会出现在 DSH 的模型选择器里。

> 这是非官方插件，连接的是 CANNBOT 网关。使用前请确认你的账号有对应模型的访问权限。

## 功能

- **复用 CANNWork 登录**：每个请求从本机 opencode 文件读取 JWT 与 VK，登录/续期后下一次请求
  立即生效，不需要重启 DSH。
- **模型目录自动更新**：启动时拉取当前账号可见的模型，之后在后台定期刷新。
- **图片输入**：对实测能读图的模型开放；其他模型保持纯文本。
- **文本、推理、工具调用**：支持 DSH 的多轮会话、工具调用与工具结果回放。
- **文件附件**：文件以只读路径交给模型读取，不会把文件字节直接发给网关。
- **无需额外服务**：插件不启动本地服务，也没有安装脚本或原生模块。

## 安装前准备

- DSH **0.2.2-rc.3 或更新**（`engines.dsh >=0.2.2-rc.3 <0.3.0`）
- Node.js **>=24.9.0**
- 已安装 **CANNWork**（`cannbot-toolkit`）并在 opencode 中登录过
- 能访问 `cannbot.hicann.cn`

> 插件的版本下限来自 DSH 0.2.2 本身；Node 版本由 DSH 的要求决定。

## 安装

### 从插件市场安装

本插件已收录于 DSH 插件市场，条目指向 GitHub 仓库。在 DSH 的插件管理/市场中搜索
**CANNBOT Connect**，按市场提示安装，然后重启 DSH。

### 手动安装

```bash
git clone https://github.com/gentle-knight/dsh-cannbot-connect.git

# 把 web 换成你实际使用的 profile（常见为 web 或 desktop）
dsh plugin --profile web add file:"$PWD/dsh-cannbot-connect"
```

Windows PowerShell 使用绝对路径，例如：

```powershell
dsh plugin --profile web add file:"$PWD\dsh-cannbot-connect"
```

安装完成后**重启 DSH**。

> 如果 CLI 无法写你的 profile（例如桌面版由 App 管理），请改用 Web/TUI profile，
> 或参考 [手动安装](docs/INSTALL.md)。

### 更新

```bash
cd dsh-cannbot-connect
git pull
dsh plugin --profile web add file:"$PWD"
```

然后重启 DSH。如果安装命令提示“已是最新”但版本没有变化，按
[手动安装](docs/INSTALL.md) 的强制更新步骤操作。

## 使用

1. 重启 DSH，打开模型选择器。
2. 选择 **CANNBOT** 分组里的模型。
3. 正常发送消息即可；文本、推理和工具调用都由插件转换。

模型列表来自你的账号，不同账号/时间可能不同。当前 CANNBOT 目录通常包含
`deepseek-v4.1-flash`、`deepseek-v4-flash`、`deepseek-v4-pro`、`qwen3.8-max`、
`qwen3.8-flash`、`glm-5.3`、`glm-5.3-flash` 等模型。

### 图片

直接粘贴或附加图片即可。当前实测支持图片输入的模型：

- `deepseek-v4.1-flash`
- `qwen3.8-max`
- `qwen3.8-flash`
- `glm-5.3-flash`

选择一个不在列表里的模型时，DSH 会把它当作纯文本模型，图片不会被发送。模型目录或图片
能力变化时，可通过配置覆盖，见 [配置](docs/CONFIGURATION.md)。

### 文件

PDF、代码等文件不会作为“文件字节”上传给网关，而是由 DSH 转成**只读路径**交给模型；
模型需要时用文件工具读取。因此：

- 文件内容不会出现在请求体里，适合较大的文档；
- 模型能否读到，取决于它是否调用了文件工具；
- 音频、视频不在 DSH 的消息类型里，本插件不支持。

### 推理档位

模型通常提供 `minimal`、`low`、`medium`、`high`、`max`、`xhigh` 六档。网关不接受 `off`，
所以不提供该档位；不选档位时使用服务端默认值。

## 配置

不配置也能用。常见调整项：

| 配置 | 用途 |
|---|---|
| `visionModels` | 哪些模型允许图片输入；`[]` 表示全部纯文本 |
| `maxRequestImageBytes` | 单次请求的图片总预算；超出时自动降级 |
| `catalogRefreshMs` | 模型目录的后台刷新间隔；`0` 表示关闭定时刷新 |
| `baseURL` / `modelsURL` | 指向公司镜像或本地代理时使用 |

完整字段、默认值和配置写法见 [配置文档](docs/CONFIGURATION.md)。

## 常见问题

**模型选择器里没有 CANNBOT？**
确认插件已安装并在当前 profile 中启用，然后重启 DSH；同时确认 CANNWork 已登录。

**提示缺少凭据或登录过期？**
打开 CANNWork（VS Code/Cursor 里的 `cannbot-toolkit`）重新登录，让它重写
`session.json` / `auth.json`；插件会在下一次请求使用新值。

**某个模型报无权限/不可用？**
这通常是账号没有该模型权限，或模型目录已变化。稍等目录刷新或重启 DSH；不要为了这个
错误重新登录。

**图片发不出去？**
当前模型不在图片支持列表里。换 `deepseek-v4.1-flash`、`qwen3.8-max`、
`qwen3.8-flash` 或 `glm-5.3-flash`，或把模型加进 `visionModels`（前提是实测能读图）。

**请求太大或图片被降级？**
DSH 会把最旧的图片替换成占位文本后重试；也可以减少图片数量，或调小
`maxRequestImageBytes`。

**macOS / Windows 能用吗？**
使用同一套安装与配置命令，凭据路径会自动查找。若遇到路径或文件权限问题，反馈时请附
系统与 DSH 版本。

更完整的错误说明见 [故障排查](docs/TROUBLESHOOTING.md)。

## 安全与隐私

- 插件只**读取** opencode 的 `session.json`（JWT）和 `auth.json`（VK），不写回。
- 凭据只发送到配置的 `baseURL` / `modelsURL`，默认是 CANNBOT 官方网关。
- 不跟随 HTTP 重定向；只接受 https（本机回环地址除外）。
- 网关返回的错误文本会先按实际凭据值脱敏，再进入日志/错误信息。
- 插件不启动本地服务、不收集遥测、不引入第三方运行时依赖。

更细的凭据去向、加固与残留风险见 [安全说明](docs/SECURITY.md)。

## 已知限制

- **必须保持 CANNWork 登录**：JWT 约 24 小时有效，插件不负责刷新，依赖 CANNWork 续期。
- **图片按模型开放**：只有实测能读图的模型声明 `image`；未知模型一律纯文本，避免“看似支持、
  实际读不到图”。
- **文件不是上传**：文件以只读路径交给模型，不是把原始字节发给网关。
- **音频/视频不支持**：DSH 的消息内容没有对应类型。
- **历史图片会随请求重发**：这是 OpenAI 兼容协议的限制；图片预算与自动降级负责兜底。
- **不提供 `off` 推理档位**：网关会拒绝该档位。
- **宿主范围**：DSH `>=0.2.2-rc.3 <0.3.0`、Node `>=24.9.0`；0.2.1 线不支持。

## 更多文档

使用相关：

- [配置](docs/CONFIGURATION.md)
- [故障排查](docs/TROUBLESHOOTING.md)
- [安全与隐私](docs/SECURITY.md)
- [手动安装](docs/INSTALL.md)

问题反馈：<https://github.com/gentle-knight/dsh-cannbot-connect/issues>

反馈时请附 DSH 版本、Node 版本、操作系统和复现步骤；**不要粘贴 JWT、VK 或任何密钥**。

## 许可

MIT，见 [LICENSE](./LICENSE)。
