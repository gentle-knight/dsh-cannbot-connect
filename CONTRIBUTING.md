# 参与开发

面向维护者。普通安装与使用请看 [README](README.md)。

## 环境

- Node.js **>=24.9.0**（与 DSH 0.2.2 线一致）
- 本机安装 DSH 宿主；`DSH_INSTALL_DIR` 指向它时，宿主矩阵可以直接运行
- 实网测试需要 CANNWork 登录，会消耗网关额度

## 常用命令

```bash
npm install
npm test                 # 23 组离线测试，不联网、不读真实凭据
npm run test:compat      # 0.2.2-rc.3 + 0.2.3-alpha.2 宿主矩阵
npm run test:coverage    # V8 覆盖率门槛：行 >=98%、函数 >=90%
npm run check            # 语法 + 离线测试 + 宿主矩阵 + 覆盖率 + 密钥扫描
node e2e.mjs             # 实网 e2e（需要 CANNWork 登录与额度）
```

宿主矩阵在缺少宿主时会跳过；可用 `CANNBOT_HOST_STABLE` / `CANNBOT_HOST_ALPHA`
显式指定宿主目录。

## 浏览器半部

`client.js` 是手写的 DSH loader 模块（`settings.section` + `settings.models.footer`），没有打包步骤；
修改后至少运行 `node --check client.js`，并在 DSH Web 里打开设置页验证保存、刷新与冲突提示。

## 文档

- [测试方案](docs/TEST-PLAN.md)
- [架构、依赖与兼容性](docs/ARCHITECTURE.md)
- [平台差异与风险](docs/PLATFORMS.md)
- [仓库同步](docs/REPOSITORY-SYNC.md)
- [配置字段](docs/CONFIGURATION.md)
- [故障排查](docs/TROUBLESHOOTING.md)

## 提交与仓库

- 开发主仓是 GitCode；GitHub 是市场用的镜像。提交到 GitCode，由 Push 镜像同步 GitHub。
- 不要直接向 GitHub 提交，否则下一次镜像会覆盖。
- 新增行为要有测试；修复 bug 要带回归测试（例如 alpha 删除 `assertUsableApiKey`
  对应 `test/import-surface.mjs`）。
