# Claudex

Claudex 是基于开源 Codex 执行引擎的聊天与开发工作台。

| 版本 | 适合谁 | 安装与数据 |
| --- | --- | --- |
| **本地版** | 已有模型 API，想直接使用聊天和 Code | [下载本地版](https://github.com/ZecousJ/Open-Claude-Desktop/releases/latest)。填写请求地址、API 密钥和模型即可进入工作区。执行引擎随客户端安装，对话保存在本机。 |
| **完整版** | 需要账号、集中模型路由、团队或云端会话 | 部署 Claudex 服务端与 Linux Runner，配置模型渠道和用户分组，再自行构建客户端。 |

[本地版使用和构建](docs/local.md) · [完整版部署手册](docs/self-hosted.md)

公开发行版使用 Claudex 自有界面和开放许可图标。托管环境中的界面资源、账号、预置模型、存储地址和运维凭据由部署方配置。

桌面端、Web 和 Runner 使用 Apache-2.0。仓库内的 Sub2API 分支使用 LGPL-3.0。第三方依赖保留各自的许可证。参见 [LICENSE](LICENSE)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [Sub2API 源码声明](backend/SOURCE_OFFER.md)。
