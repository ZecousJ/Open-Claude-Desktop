# Computer use 驱动：选型、固定版本、打包与许可证

本文只记录 computer use 的驱动本身：选了什么、固定在哪个版本、怎么下载校验、怎么打包、验证到了哪一步、以及给后续包的接入约束。

## 1. 结论

- **驱动：Open Computer Use 0.3.5**（npm 包 `open-computer-use`，上游 https://github.com/iFurySt/open-codex-computer-use ，提交 `386a260d1ab8b690adbbb27f7471595cf0c2b752`，tag `v0.3.5`，MIT）。主选成立，**不切换 cua-driver**：原本担心的“坐标点击会移动真实光标”在 0.3.x 已不成立——macOS 默认用 `app_post` / `sky_click` 把事件直接投递给目标应用，不动系统指针；只有显式设置 `OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS=1` 才会用全局指针（窗口拖动、文本选择、Finder 拖放等）。这正好对应原版的 Background / Full control 两种方式。
- **分发来源：npm 注册表的 tarball**。GitHub Releases 只有 CursorMotion 演示 DMG，没有驱动二进制；npm 包由上游 GitHub Actions 通过 OIDC 发布，带 SLSA provenance 证明。
- **运行方式：由 Claudex 主进程直接拉起，stdio MCP，进程内模式**（`OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY=1`）。见第 4 节。
- **许可证：** MIT（驱动）+ MIT（驱动内派生自 Cua Driver 与 yabai 的代码）+ BSD-3-Clause（Windows 版静态链接的 Go 运行时）。上游包里有一张**不属于 MIT 的图片**，打包时剔除，见第 5 节。

## 2. 固定版本与校验（`scripts/computer-use/drivers.json`）

| 项 | 值 |
| --- | --- |
| tarball | `https://registry.npmjs.org/open-computer-use/-/open-computer-use-0.3.5.tgz`，5 844 280 字节 |
| tarball SHA-256 | `7c16a87c8cd357787b02c0ebd040dd5f93880c1fb51c1901caa2e0c05d063130` |
| npm integrity | `sha512-KKRY42by…FdpjQ==`（与注册表元数据一致，SHA-1 `685935769e5f0cd3169ab87c37656e977dc8da5f`） |
| LICENSE SHA-256 | `0fdb775e00e6fdde23984b4f1184cd13c34135caac1e714ad489141c239704bc` |
| macOS 可执行文件（universal x86_64 + arm64） | `Open Computer Use.app/Contents/MacOS/OpenComputerUse`，上游 SHA-256 `245ec7c8…6fd8b2110761230501445bd08a08bc8` |
| Windows x64 | `dist/windows/amd64/open-computer-use.exe`，SHA-256 `e0739e9c…1d72a6309b4a32562` |
| Windows arm64 | `dist/windows/arm64/open-computer-use.exe`，SHA-256 `f31cb912…4eee38d5a04cc9c7` |

完整哈希（包括 bundle 内每个文件）在 `drivers.json`。Linux 构建存在于上游包中，但 Claudex 不发布 Linux 版，不安装。

`node scripts/computer-use/fetch-driver.mjs [darwin|win32] [arm64|x64] [--download-only] [--force]`：

1. 下载到 `build/downloads/computer-use/`（已被 git 忽略）；网络不稳时自动重试（默认 6 次，指数退避，单次 60 秒无数据即中止），中断后用 HTTP Range 续传；只允许 HTTPS（测试用的 127.0.0.1 除外）。
2. 校验 tarball 的 SHA-256 与 npm integrity，不符即删除下载文件并失败。
3. 解包到临时目录，校验 LICENSE；目标布局目录下**每个文件**都必须在清单里且哈希一致，多一个、少一个或内容不同都失败；不允许符号链接。
4. 清空 `build/computer-use/`（保留 `.gitkeep`），安装目标平台的运行时，复制 `LICENSE` 与 `scripts/computer-use/licenses/open-computer-use-NOTICES.md`（→ `NOTICES.md`），写 `manifest.json`（驱动名、版本、平台、可执行文件相对路径与安装后的 SHA-256、签名方式、剔除的文件、启动参数、环境变量档位、工具清单，以及 `installedFiles`：安装目录内每个文件的 SHA-256）。再次运行时只有全部文件与 `installedFiles` 一致（不缺、不多、不改）才跳过；用 `--out` 指定的非默认目录若非空且没有本脚本写的 `manifest.json`，脚本拒绝清空。
5. 已安装且版本、平台、tarball 哈希与可执行文件哈希都一致时跳过；`--force` 强制重装；`--download-only` 只下载校验不改输出目录。

macOS 目标必须在 macOS 上准备（需要 `codesign`）。

`node scripts/computer-use/smoke.mjs [--list-apps]`：按 Claudex 的方式拉起已安装的驱动（校验 manifest 哈希、`--version`、MCP `initialize` → `tools/list`，可选 `list_apps` 只输出行数，不输出应用名），不执行任何界面操作。

## 3. 打包接入

打包需要：

- `build.extraResources` 增加 `{ "from": "build/computer-use", "to": "computer-use" }`（`.gitkeep` 会一并带入，无害；也可加 `filter: ["**/*", "!.gitkeep"]`）。
- `package:mac` 在 electron-builder 之前运行 `node scripts/computer-use/fetch-driver.mjs`（本机平台；需要同时出 x64 包时传 `darwin x64`，macOS 两种架构用的是同一个 universal bundle）；`package:win` 运行 `node scripts/computer-use/fetch-driver.mjs win32 x64`。
- 运行时路径：`path.join(process.resourcesPath, "computer-use", manifest.executable)`；开发模式下是 `build/computer-use/`。DriverHost 启动前应按 `manifest.executableSha256` 校验一次可执行文件。

## 4. 运行时约束

### 4.1 启动方式与 TCC 身份

- 上游默认（未设 `OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY`）会通过 LaunchServices 另起一个 `Open Computer Use.app` 代理进程，并在系统临时目录建一个 Unix 套接字，所有 MCP 请求经这个套接字转发。这样 macOS 的辅助功能 / 屏幕录制授权归属到 `com.ifuryst.opencomputeruse` 而不是 Claudex，而且同一用户下的任何进程都能连上这个套接字，绕开 Claudex 的 Broker。
- **Claudex 必须设置 `OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY=1`**（已写入 `manifest.env.base`）：驱动在 Claudex 主进程拉起的子进程里直接服务 MCP，不启动代理 app、不建套接字。实测（本机 macOS，未打包的开发环境）：`smoke.mjs --list-apps` 通过，结束后没有残留的驱动或代理进程。
- 进程内模式下，macOS 把子进程的隐私权限记在“负责进程”（拉起它的 Claudex.app）名下，所以 Electron 的 `systemPreferences.isTrustedAccessibilityClient(false)` 与 `getMediaAccessStatus("screen")` 反映的就是驱动实际拥有的权限，设置页不需要显示第三方助手的名字。**未实机验证**：需要在打包后的 Claudex.app 上确认（开发环境里负责进程是终端或 Electron 开发版）。
- 不要调用驱动的 `doctor` 或无参数启动：权限缺失时它会弹出上游自己的引导窗口。权限状态与申请由 Claudex 自己的 `permissions.ts` 负责。

### 4.2 环境变量档位（`manifest.env`）

| 变量 | base（Background） | fullControl | 作用 |
| --- | --- | --- | --- |
| `OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY` | 1 | （继承 1） | 进程内模式，见上 |
| `OPEN_COMPUTER_USE_VISUAL_CURSOR` | 0 | 1 | 屏幕上的软件光标覆盖层；后台模式不显示 |
| `OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS` | 0 | 1 | macOS：允许移动真实指针（`click_method: global`、跨窗口拖放） |
| `OPEN_COMPUTER_USE_WINDOWS_ALLOW_APP_LAUNCH` | 0 | 1 | Windows：目标未运行时允许 `Start-Process` 启动 |
| `OPEN_COMPUTER_USE_WINDOWS_ALLOW_FOCUS_ACTIONS` | 0 | 1 | Windows：允许 SetFocus（会抢前台） |
| `OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK` | 0 | 1 | Windows：ValuePattern 文本回退（可能把目标带到前台） |

环境变量在进程启动时读取，切换 Background / Full control 需要重启驱动子进程（fullControl = base 覆盖 fullControl 中的项）。

### 4.3 工具面（0.3.5，macOS 与 Windows 相同）

`list_apps`、`get_app_state`、`click`、`perform_secondary_action`、`scroll`、`drag`、`type_text`、`press_key`、`set_value`。MCP 协议版本 `2025-03-26`，按行 JSON-RPC。没有截图单独工具（`get_app_state` 返回应用窗口截图 + 无障碍树），也没有 `open_application`、剪贴板、全控切换工具——设计里的 `request_access`、`list_granted_applications`、`open_application`、`screenshot`、`request_full_control` / `release_full_control`、剪贴板等由 Claudex 适配器 / Broker 自己实现或组合（`screenshot` = 取 `get_app_state` 的图像部分）。

### 4.4 安全相关的上游行为（Broker 必须处理）

- **应用解析不严格**：
  - macOS：`app` 参数若含 `.` 按 bundle id 精确匹配（不区分大小写）；否则按应用名 / 可执行名匹配。上游自带一份很短的拒绝表（只有 1Password、Bitwarden、Dashlane、LastPass、NordPass、Proton Pass 的 bundle id），不含钥匙串访问、系统设置、KeePassXC 和 Claudex 自身。
  - Windows：`app` 为纯数字时按 PID 精确匹配；否则按进程名匹配，**同时也匹配窗口标题的子串**（`MainWindowTitle -ilike "*query*"`），任何窗口标题里含有该字符串的进程都可能被选中。
  - 因此 Broker 在授权后必须**自己解析出目标并以精确标识调用驱动**：macOS 传 bundle id，Windows 传 PID（由 Broker 按可执行文件路径与发布者核对后得到），不把模型给的名字原样转发。Claudex 自己的“永不授权”表（设计第 6 节第 3 条）必须在 Broker 里执行，不能依赖上游的表。
- **macOS 会自动启动未运行的应用**（`NSWorkspace.openApplication`，没有环境变量开关）：Broker 只能对已授权的应用发出调用。
- **Windows 运行时**是 Go 程序内嵌的 PowerShell 脚本，每次调用以 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <临时脚本>` 执行；需要系统有 `powershell.exe`。
- 驱动本身没有令牌或会话概念，任何能写它 stdin 的进程都能操作电脑：只能由主进程持有 stdio，不能交给 Codex 或放到套接字上。

## 5. 许可证

- 驱动：MIT，Copyright (c) 2026 Leo。安装时 `LICENSE` 放在 `resources/computer-use/LICENSE`。
- 上游 `THIRD_PARTY_NOTICES.md`：macOS 版的 `sky_click` 事件与 SkyLight 桥派生自 Cua Driver（MIT，提交 `b8a0f32a…`），不抢焦点的事件记录派生自 yabai（MIT）。npm 包没有带这份文件，Claudex 从上游同一提交复制到 `scripts/computer-use/licenses/open-computer-use-NOTICES.md`，安装为 `resources/computer-use/NOTICES.md`。Cua 的 AGPL-3.0 扩展 `cua-perception` 不在其中，也不引入。
- Windows 版是 Go 静态链接的程序（无第三方 Go 模块，`go.mod` 无依赖），附 Go 的 BSD-3-Clause 声明（同一 NOTICES 文件）。
- **剔除的文件**：macOS bundle 里的 `Contents/Resources/official-software-cursor-window-252.png`。上游文档写明这张图是从另一家厂商（Codex 官方 Computer Use 应用）的 app bundle 中提取的，不在 MIT 授权范围内，Claudex 不再分发。缺少这张图时驱动退回自己程序绘制的光标（上游 `loadReferenceCursorWindowImage()` 返回 nil 时的既有路径），只影响 Full control 时的软件光标外观。
- 仓库根 `THIRD_PARTY_NOTICES.md` 已增加“Computer use driver”一节。

## 6. 签名

- 上游 bundle 由 `Developer ID Application: Yifan PANG (J9P29FA5BX)` 签名并已公证（`spctl`：`accepted, source=Notarized Developer ID`；未装订公证票据），启用 hardened runtime，无 entitlements。
- 剔除图片会使上游签名的资源封印失效，所以 `fetch-driver.mjs` 用 `codesign --force --sign - --options runtime --timestamp=none` 对 bundle 重新做 ad hoc 签名并 `codesign --verify --strict` 校验；结果可复现（重复安装得到相同的可执行文件哈希 `c160d3a8a4b6cad303b73889da0977c1cd3b7fff1b7f4d9bd19dbaf211bd74c9`，arm64 主机实测）。
- Claudex 目前 `mac.identity: null`（不签名）。将来有 Developer ID 时，electron-builder 会用 Claudex 的身份重新签名 `resources/` 下的 Mach-O，驱动随之带上 Claudex 身份；在那之前，每次更新 Claudex 都可能需要用户重新授予辅助功能与屏幕录制（设计风险 R2）。
- Windows 版上游未做 Authenticode 签名（PE 证书表为空）；Claudex 的 Windows 包目前也不签名（`signExecutable: false`）。

## 7. 验证记录

| 项 | 结果 |
| --- | --- |
| tarball、integrity、LICENSE、每个文件的 SHA-256 | 通过（darwin-arm64 安装；win32-x64、win32-arm64 `--download-only`） |
| 上游签名（原始 bundle） | `codesign --verify --deep --strict` 通过，已公证 |
| 重签名后 | `codesign --verify --strict` 通过，ad hoc + runtime |
| `smoke.mjs --list-apps`（macOS arm64，开发环境） | `--version` = 0.3.5；`initialize` → `open-computer-use 0.3.5`，协议 `2025-03-26`；9 个工具齐全；`list_apps` 正常返回；无残留进程 |
| 单元测试 `tests/computer-use-fetch-driver.test.ts` | 安装与复用、篡改后重装、断点续传、哈希 / integrity / LICENSE / 多余文件拒绝、`--download-only`、不安全配置拒绝、固定清单完整性 |
| 真实界面操作（点击、输入、截图） | **未做**：需要授予辅助功能 / 屏幕录制，且应在打包后的 Claudex.app 上由 Broker 驱动完成 |
| Windows | **未实机验证**（无 Windows 机器） |
| 打包后 TCC 归属 | **未实机验证**（需要打包构建；见 4.1） |

## 8. 升级驱动的步骤

1. 在 npm 查看新版本的 `dist.tarball`、`dist.integrity`、`gitHead`，核对上游 tag 与 provenance。
2. 下载 tarball，逐个计算 `drivers.json` 中列出文件的 SHA-256；检查布局目录里是否有新增文件（新增文件会让脚本失败，需要逐个判断许可证后加入 `files` 或 `exclude`）。
3. 对照上游该提交的 `THIRD_PARTY_NOTICES.md` 更新 `licenses/open-computer-use-NOTICES.md` 与根 `THIRD_PARTY_NOTICES.md`。
4. 核对工具面与环境变量（`grep -o 'OPEN_COMPUTER_USE_[A-Z_]*'`）是否变化，更新 `drivers.json` 的 `tools` / `env` 与本文第 4 节。
5. `node scripts/computer-use/fetch-driver.mjs --force && node scripts/computer-use/smoke.mjs --list-apps`，以及 `npx tsx --test tests/computer-use-fetch-driver.test.ts`。
