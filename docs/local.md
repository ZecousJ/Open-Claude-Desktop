# 本地版

从 [GitHub Releases](https://github.com/ZecousJ/Open-Claude-Desktop/releases/latest) 下载带 **Local** 或 **本地版** 标识的包。打开 macOS DMG，将 Claudex Local 拖入「应用程序」。Windows 使用安装程序。查看发行说明确认对应系统和架构。

首次启动填写以下内容，点击「进入工作区」。连接页保存的模型是默认模型，API 提供模型列表时，可用的对话模型也会进入模型菜单。

| 字段 | 示例与说明 |
| --- | --- |
| 请求地址 | `https://api.example.com/v1`。也可填完整的 `/v1/responses` 或 `/v1/chat/completions` 请求地址。 |
| API 密钥 | 模型服务或 Sub2API 为你发放的使用密钥。密钥存入系统加密凭据库。 |
| 模型 | 上游实际启用的模型 ID，例如服务管理台允许使用的名称。 |
| API 协议 | 裸 API 地址按选中的协议使用。带有请求路径的地址会自动采用对应协议。 |

### 本地执行和数据

Codex 引擎由桌面进程在本机启动。模型请求发往填写的 API，聊天、项目和 Code 会话记录留在本机。Web 同步、远程控制、云端 Runner 和托管协作属于完整版。关闭应用会结束本机的执行进程。

本地版和完整版使用独立的应用数据目录。可从桌面设置打开数据目录。备份会话记录时，请备份整个应用数据目录，模型密钥以系统凭据加密，迁到另一台电脑后应重新填写密钥。

### 从源码构建

安装 Node.js 24、npm 和 Git。构建 Windows 版还需安装 Go，用于编译 WSL 中的连接程序。从仓库根目录执行命令。

```bash
npm ci
npm run package:local -- darwin arm64
```

macOS 打包 DMG 时，通过 `CLAUDEX_MAC_SIGNING_IDENTITY` 指定自己的签名身份。Windows 和 Linux 分别使用 `npm run package:local -- win32 x64` 与 `npm run package:local -- linux x64`。产物位于 `release/local/`。打包脚本会获取指定平台的 Codex 二进制并放入应用资源。

打包脚本从 Release 获取对应的桌面工作区资源。离线构建时，可提前下载 `claudex-workspace-production-0.0.55.tar.gz`，用 `CLAUDEX_WORKSPACE_UI_ARCHIVE` 指定该文件的绝对路径。
