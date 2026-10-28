# Open Claude Desktop

Open Claude Desktop 是一个开源的 AI 模型工作台，应用名为 **Claudex**：macOS、Windows、Linux 桌面端，网页版，以及 iOS 和 Android 手机端，都登录到你自己部署的服务端。对话由开源的 [Codex](https://github.com/openai/codex) agent 运行，模型可以读文件、执行命令、修改代码、调用工具，关键操作需要你批准。

[English](README.md)

![对话旁边打开了一个 HTML 作品](docs/images/screenshot-chat-artifact.png)

**目录：** [功能](#功能) · [整体结构](#整体结构) · [部署](#部署) · [开发](#开发) · [许可](#许可)

桌面端截图来自离线界面预览（`node --import tsx scripts/preview/ui-preview.mts`），用示例数据运行真实界面；手机截图来自 Android 应用的 `demo` 版本和模拟器里的 iOS 应用。

## 功能

### Chat

提问、附上文件和图片，回答里的 Markdown、代码、公式、表格和图表都会排版好。篇幅较长的产出会成为**作品**（HTML 页面、React 组件、SVG、Mermaid、Markdown 等文档），显示在对话旁边，有版本记录、可以分享，所有作品集中在作品库里。**项目**把各自的指令、文件和对话放在一起。Chat 还可以联网搜索、做多步研究、记住关于你的信息（记忆可以查看和修改）、语音听写。

![项目](docs/images/screenshot-projects.png)

### Code

Code 会话在你电脑上的文件夹里、通过 SSH 连到的另一台电脑上，或者云端的 GitHub 仓库里工作。Codex 在那里读写文件、执行命令；每一步都看得到，改了哪些文件、完整的改动对比都列出来，可以审阅、撤销。会话侧栏显示运行环境、上下文用量、连接器和后台任务。对话旁边还有内置终端，以及用来看开发服务器的浏览器面板。

![一个 Code 会话和它的改动](docs/images/screenshot-code.png)

![会话改动的完整对比](docs/images/screenshot-code-diff.png)

**权限模式**决定哪些操作需要你批准：**Manual** 每次改动前都询问；**Accept edits** 自动接受文件修改，执行命令仍会询问；**Plan** 先写计划，你批准后再动手；**Auto** 由 Claudex 自行判断权限；**Bypass permissions** 全部放行（适合你信任的沙箱）。待批准的请求停在输入框上方，等你处理。

![等待批准的命令](docs/images/screenshot-approval.png)

### Workflow 与后台任务

大一点的任务可以用 **workflow**：多个 agent 分阶段工作（比如先审查、再核实），各自有独立的上下文，最后汇总成一个结果。耗时的命令在后台继续跑，不影响你接着对话；会话侧栏列出运行中和已完成的任务，以及定时提示和循环任务的下次运行时间。

![一次完成的审查 workflow](docs/images/screenshot-workflow.png)

### 定时任务

让一段提示按计划运行（每天、工作日、每周，或手动），在 Chat 或 Code 里、本地或云端都可以。每次运行都是一个可以打开查看的对话，结果也可以发到邮箱。

![定时任务](docs/images/screenshot-scheduled.png)

### 云端隔离环境

云端 Code 会话和网页版的所有对话都运行在 **runner** 上：一台 Linux 主机，每个用户的 Codex 在各自的 gVisor（或 bubblewrap）沙箱里运行。沙箱从只读镜像启动，没有自己的网络接口，内存、CPU、进程数和磁盘都有上限。**环境**设定网络访问级别（不联网、仅可信站点、完全联网）、初始化脚本和环境变量。网络流量经过 runner 的出口代理；模型请求经过一个代理，真正的密钥留在沙箱外；Git 的克隆和推送经过一个中转服务，使用短时有效的 GitHub App 令牌。

![编辑云端环境](docs/images/screenshot-cloud-env.png)

![runner 与它的沙箱](docs/images/cloud-sandbox.svg)

### 远程控制

打开远程控制后，桌面端和服务端保持连接，你可以在手机或浏览器上接着操作：选一台在线的电脑，打开它的某个 Code 会话，发消息、停止、批准请求，或者在那台电脑上开新会话。文件和命令都留在那台电脑上。电脑可以要求每部手机或每个浏览器先经过信任才能连接。

![远程控制如何连接](docs/images/remote-control.svg)

### 电脑操控与模拟器

在桌面端，Codex 可以操作你电脑上的应用（按应用授权，浏览器只能查看，管理员可以设策略），也可以驱动 iOS 模拟器和 Android 模拟器来构建、运行、检查手机应用。每一步做了什么都会显示出来，附带截图。

![一次电脑操控任务](docs/images/screenshot-computer-use.png)

### Skills、连接器与插件

**Skills** 是可复用的指令，任务需要时 Codex 会自动载入。**连接器**通过 MCP 服务器接入工具和数据，可以是远程服务，也可以是你电脑上的本地服务。**插件**把 skills、连接器和 hooks 打包在一起，可以从你添加的插件市场或 Git 仓库安装。

![Skills](docs/images/screenshot-customize.png)

![连接器](docs/images/screenshot-connectors.png)

### 手机端

iOS（SwiftUI）和 Android（Jetpack Compose）原生应用，使用同一个账号：对话和项目、云端 Code 会话和它们的改动对比、作品、定时任务、语音听写、批准请求。Code 页列出你的电脑，所以手机也能通过远程控制操作桌面端的会话。对话内容用的是桌面端和网页版同一套 React 渲染。

<p>
<img src="docs/images/phone-android-home.png" width="19%" alt="Android 新对话">
<img src="docs/images/phone-android-drawer.png" width="19%" alt="Android 导航">
<img src="docs/images/phone-android-chat.png" width="19%" alt="Android 对话">
<img src="docs/images/phone-android-review.png" width="19%" alt="Android 审阅改动">
<img src="docs/images/phone-android-codehome.png" width="19%" alt="Android 的 Code 会话和电脑列表">
</p>
<p>
<img src="docs/images/phone-android-code.png" width="19%" alt="Android 的 Code 会话">
<img src="docs/images/phone-ios-sign-in.png" width="19%" alt="iOS 登录">
</p>

### 网页版、主题与语言

网页版就是服务端提供的同一套界面，会话运行在 runner 上。各端都有浅色和深色主题，可以跟随系统；界面支持英语和另外 11 种语言。

![深色主题下的新对话页](docs/images/screenshot-home-dark.png)

### 账号、套餐与管理

服务端是 [Sub2API](https://github.com/Wei-Shaw/sub2api) 的扩展分支：用户和分组、上游模型账号及调度、模型白名单和价格、余额、按日/周/月限额的订阅套餐、支付、用量记录和管理控制台。Claudex 在此之上加了客户端看到的模型目录、客户端策略、桌面端更新的发布渠道、公告、服务状态，以及网页版和 runner 的管理。

## 整体结构

![Claudex 的整体结构](docs/images/architecture.svg)

| 路径 | 内容 |
| --- | --- |
| `electron/`、`src/`、`shared/` | 桌面端：Electron 主进程、React 界面、两者共用的代码 |
| `src-web/`、`web.html` | 网页版：同一套界面加上浏览器桥接 |
| `runner/` | 在 Linux 主机上运行网页版和云端会话，每个用户一个沙箱里的 Codex |
| `server/` | 桌面端本地的模型服务进程 |
| `backend/` | Claudex 服务端，Sub2API 的分支（Go，带 Vue 管理控制台） |
| `mobile/ios`、`mobile/android` | 手机原生应用（SwiftUI、Jetpack Compose） |
| `deploy/` | 运行服务端和 runner 的镜像与脚本 |
| `scripts/` | 构建、打包、预览和发布工具 |
| `tests/` | 测试（`node:test`） |

详见 [docs/architecture.md](docs/architecture.md)。

## 部署

一套部署包括：一个服务端（带 PostgreSQL 和 Redis）；需要网页版和云端会话时再加一台或几台 runner；以及指向你服务端的各个客户端。

![部署步骤](docs/images/deployment.svg)

### 1. 服务端

需要一台装了 Docker Engine 和 Compose v2 的 Linux 主机、一个域名和 TLS 证书。

```sh
# 构建镜像（任何装了 Docker 的机器都可以）
deploy/claudex-server/build-image.sh            # claudex-server:<版本>

# 在服务器上
cd deploy/claudex-server
cp .env.example .env && chmod 600 .env          # 把每个 change-me 换成真实值；密钥用 openssl rand -hex 32 生成
docker compose config --quiet                   # 缺少必填项时会提示
docker compose up -d
ADMIN_EMAIL=… ADMIN_PASSWORD=… ./check.sh http://127.0.0.1:8080
```

- 服务端只监听 `127.0.0.1:8080`，前面用 `nginx.conf.example` 做 TLS 反向代理（流式回复不缓冲，访问日志不记录查询串）。
- 首次启动会建库，并用 `ADMIN_EMAIL`、`ADMIN_PASSWORD` 创建管理员。
- 用 `deploy/claudex-server/backup.sh` 备份；升级 = 构建新镜像、先备份、再改 `CLAUDEX_SERVER_IMAGE`。

密钥用文件提供、恢复和升级的细节见 [deploy/claudex-server/README.md](deploy/claudex-server/README.md)。

### 2. 管理控制台

打开 `https://你的域名/admin`，用管理员登录。

1. 接受 Sub2API 的《部署与运营合规承诺》。接受之前，控制台和管理 API 拒绝所有请求；没有任何脚本会替你接受。
2. 添加上游账号（你有权使用的 OpenAI 兼容或其他服务商的 API Key）。
3. 建分组（模型白名单）、定价、建套餐和限额，设置谁可以注册。
4. 在 Claudex 页面里：模型目录（名称、说明、推理强度）、客户端策略、发布渠道、公告、服务状态。
5. 打开网页版，创建 runner（下一步）。

[`deploy/sub2api/seed-claudex.sh`](deploy/sub2api/README.md) 可以按配置批量建好分组、账号和价格。可选服务（语音听写、联网搜索、生图、邮件、支付）见 [docs/self-hosting.md](docs/self-hosting.md)。

### 3. Runner

Runner 是一台 Linux 主机（Ubuntu 24.04，或开了 systemd 的 WSL2），需要 Node.js 22 或更新版本。它主动连到服务端，不需要开放入站端口。

```sh
# 在构建机上
node scripts/build-runner.mjs                     # 生成 dist-runner/
deploy/claudex-runner/image/build.sh amd64        # gVisor 用的沙箱镜像

# 在 runner 主机上，以 root 身份、在 deploy/claudex-runner/ 目录下
useradd --system --create-home --home-dir /var/lib/claudex-runner claudex-runner
install -d -o claudex-runner /opt/claudex-runner /etc/claudex-runner
cp dist-runner/* /opt/claudex-runner/
(cd /opt/claudex-runner && npm install @openai/codex@0.144.1)
install -m 0600 -o claudex-runner runner.env.example /etc/claudex-runner/runner.env
install -m 0440 claudex-runner.sudoers /etc/sudoers.d/claudex-runner
install -m 0644 claudex-runner.service /etc/systemd/system/
image/install-image.sh claudex-sandbox-<版本>-amd64.rootfs.tar.zst
```

在控制台的 **Runners** 页面创建 runner，把只显示一次的令牌保存到 `/etc/claudex-runner/token`（权限 0600，属主 `claudex-runner`），改好 `runner.env`，然后：

```sh
systemctl daemon-reload
systemctl enable --now claudex-runner
journalctl -u claudex-runner -f
```

推荐用 gVisor（`runsc`）做沙箱；小规模的私有部署也可以用 bubblewrap。要在云端对 GitHub 仓库跑 Code，需要注册一个 GitHub App 并填进控制台。详见 [deploy/claudex-runner/README.md](deploy/claudex-runner/README.md)。

### 4. 客户端

**网页版。** 服务端在根路径提供网页版，在 `/admin` 提供管理控制台。在控制台打开网页版后，直接访问你的域名即可。

**桌面端。** 构建时写入你的服务端地址（不写的话，登录页会让用户自己填），然后打包：

```sh
npm ci
export CLAUDEX_SERVICE_URL=https://你的域名
npm run package:mac      # macOS .zip
npm run package:win      # Windows NSIS 安装包
npm run package:linux    # x64 与 arm64 的 .deb、.rpm、.tar.gz
```

用你自己的证书给安装包签名（见 [docs/building.md](docs/building.md)），用 `scripts/release/publish.ts` 上传，再在控制台的发布页面发布，已安装的客户端会自动更新。只改界面的版本可以发签名的界面热更新包，不需要新安装包。详见 [docs/releasing.md](docs/releasing.md)。

**Android。**

```sh
cd mobile/android
./gradlew :app:assembleProductionRelease -PclaudexOrigin=https://你的域名
```

签名配置见 [mobile/android/README.md](mobile/android/README.md)；`demo` 版本不需要服务端，用示例数据运行。

**iOS。** 在 target 的构建设置里填 `CLAUDEX_SERVICE_URL`，选好你的开发团队和 bundle id，在 Xcode 里构建 `Claudex` scheme；详见 [mobile/ios/README.md](mobile/ios/README.md)。

## 开发

需要 Node.js 24 和 npm。

```sh
npm ci
npm run dev           # 桌面端，改动自动重载
npm run dev:web       # 网页版，http://127.0.0.1:5174
node --import tsx scripts/preview/ui-preview.mts   # 不需要服务端，用示例数据跑整个界面
```

```sh
npm test              # 全部测试
npm run build         # 类型检查并构建桌面端
npm run build:web     # 构建网页版到 dist-web/
```

构建设置、签名、网页版、runner、服务端和手机端的构建见 [docs/building.md](docs/building.md)。

## 参与贡献

欢迎提 issue 和 pull request，见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可

Claudex 以 [Apache License 2.0](LICENSE) 发布；`backend/` 作为 Sub2API 的分支，沿用 [GNU LGPL v3.0](backend/LICENSE)。打包的第三方软件和素材保留各自的许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

Open Claude Desktop（Claudex）是独立项目，与 Anthropic、OpenAI 没有关联，也未获其认可。Claude 是 Anthropic 的商标，Codex 是 OpenAI 的商标。
