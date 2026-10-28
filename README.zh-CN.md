# Open Claude Desktop

Open Claude Desktop 是一个开源的 AI 模型工作台，应用名为 **Claudex**，有 macOS、Windows、Linux 桌面端，网页版，以及 iOS 和 Android 手机端。对话由开源的 [Codex](https://github.com/openai/codex) agent 运行，模型可以读文件、执行命令、修改代码、调用工具，关键操作需要你批准。

[English](README.md)

## 功能

- **Chat**：作品（HTML、SVG、React、Mermaid、文档）、文件附件、带独立指令和文件的项目、记忆、联网搜索与研究。
- **Code**：在本地文件夹、SSH 远程主机或云端 GitHub 仓库里运行会话。权限模式、计划、改动对比与审阅、终端、用于开发服务器的浏览器面板、后台任务、定时提示和多智能体工作流。
- 桌面端支持 **Computer use** 和 **iOS / Android 模拟器** 控制。
- **远程控制**：在网页或手机上接着操作桌面端的会话。
- **账户、套餐与用量** 由 Claudex 服务端提供。服务端是 [Sub2API](https://github.com/Wei-Shaw/sub2api) 的扩展分支，同时提供网页版和管理控制台。
- 界面支持 11 种语言。

## 结构

```
 桌面端（Electron）           网页版（浏览器）           手机端
   │  Codex 在本机运行          │                        │
   │                            ▼                        │
   │                      runner ── Codex 运行在 gVisor  │
   │                        │      或 bubblewrap 沙箱里  │
   ▼                        ▼                            ▼
 Claudex 服务端（backend/）：账户、模型、计费、同步、网页转发
   │
   ▼
 模型服务商（OpenAI 兼容接口等）
```

| 目录 | 内容 |
| --- | --- |
| `electron/`、`src/`、`shared/` | 桌面端：Electron 主进程、React 界面、两者共用的代码 |
| `src-web/`、`web.html` | 网页版：同一套界面加浏览器桥 |
| `runner/` | 在 Linux 主机上运行网页版会话，每个用户一个沙箱里的 Codex |
| `server/` | 桌面端的本地模型服务进程 |
| `backend/` | Claudex 服务端，Sub2API 分支（Go，管理控制台为 Vue） |
| `mobile/ios`、`mobile/android` | 原生手机端（SwiftUI、Jetpack Compose） |
| `deploy/` | 服务端和 runner 的镜像与部署脚本 |
| `scripts/` | 构建、打包和发布工具 |
| `tests/` | 测试（`node:test`） |
| `preview/` | 开发用的界面状态静态页 |

详见 [docs/architecture.md](docs/architecture.md)。

## 开始

需要 Node.js 24 和 npm。

```sh
npm ci
npm run dev
```

应用登录到一个 Claudex 服务端。可以在构建时用 `CLAUDEX_SERVICE_URL=https://claudex.example.com` 指定，也可以在登录页填写地址。自己部署服务端见 [docs/self-hosting.md](docs/self-hosting.md)。

其他命令：

```sh
npm test              # 全部测试
npm run build         # 类型检查并构建桌面端
npm run build:web     # 构建网页版到 dist-web/
npm run package:mac   # 安装包（另有 package:win、package:linux）
```

构建设置、签名、网页版、runner 和手机端见 [docs/building.md](docs/building.md)；更新渠道和界面包见 [docs/releasing.md](docs/releasing.md)。

## 参与

欢迎提 issue 和 pull request，见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可

Claudex 以 [Apache License 2.0](LICENSE) 发布；`backend/` 是 Sub2API 的分支，沿用 [GNU LGPL v3.0](backend/LICENSE)。随附的第三方软件和素材保留各自的许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

Open Claude Desktop（Claudex）是独立项目，与 Anthropic、OpenAI 没有关联，也未获其认可。Claude 是 Anthropic 的商标，Codex 是 OpenAI 的商标。
