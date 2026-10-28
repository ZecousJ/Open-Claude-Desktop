# SSH 远程环境使用说明

Claudex 的 Code 会话可以在一台通过 SSH 连接的主机上运行：模型在主机上读写文件、执行命令，终端、Changes 面板、@ 文件、分支芯片都显示主机上的内容。本说明面向终端用户和管理员；最后一节是开发者的端到端测试说明。

> 窗口里的 SSH 入口由 `src/ssh/availability.ts` 的 `remoteCodeSessions` 开关控制，关闭时界面上不出现 SSH。

## 1. 要求

**本机（Claudex 所在电脑）**

- 使用电脑自带的 OpenSSH，不内置 SSH 实现：
  - macOS / Linux：PATH 中第一个可执行的 `ssh`（只接受绝对目录）。
  - Windows：PATH 中的 `ssh.exe`，其次 `C:\Windows\System32\OpenSSH\ssh.exe`（“可选功能 → OpenSSH 客户端”）。
- 找不到 ssh 时界面显示 “OpenSSH isn't installed on this computer.”。
- 连接的 “Advanced → SSH program” 可以指定别的 ssh（必须是完整路径、文件名为 `ssh` / `ssh.exe`）。

**主机**

- Linux（x86_64、aarch64）或 macOS（Intel、Apple 芯片）。Windows 主机暂不支持（后续实验性子包）。
- 有 `sh`、`tar`、`base64`；有 `curl` 或 `wget` 时主机自己下载运行时，否则由本机上传；校验需要 `sha512sum`、`shasum` 或 `openssl` 之一。
- 登录账户的 home 可写（或在连接的 “Remote folder for Claudex” 里指定别的可写目录）。
- sshd 允许 TCP 转发（`AllowTcpForwarding yes` 或 `remote`，这是 OpenSSH 默认值）。
- 命令沙箱：Codex 在 Linux 上用 bubblewrap 隔离命令，需要主机允许非特权用户命名空间。不允许时（例如在使用默认 seccomp 配置的 Docker 容器里；部分发行版如 Ubuntu 23.10 及以后用 AppArmor 限制这项能力），沙箱内的命令会直接失败，输出 `bwrap: No permissions to create a new namespace…`。可请主机管理员放开，或在该文件夹使用 Bypass permissions（由你自己决定）。
- BusyBox 系统（Alpine 等）可用：端到端测试的主机就是 Alpine。

## 2. 添加连接

Code 首页环境芯片 `Local` → `SSH ›` → `Add SSH connection…`，或 Settings → Claude Code → SSH connections → `Add connection`。

| 字段 | 说明 |
|---|---|
| Host | `user@hostname`，或 `~/.ssh/config` 里的别名（下方会列出配置里不含通配符的 Host 名）。 |
| Name | 显示名，默认与 Host 相同。 |
| Port | 可选，缺省按 ssh 配置（通常 22）。 |
| Identity file | 可选，只保存路径，Claudex 从不读取私钥内容。 |
| Default folder | 可选，连上后自动选中的主机目录，例如 `~/projects/app`。 |
| Advanced → Remote folder for Claudex | Claudex 在主机上存放运行时的父目录，默认 `~/.claudex-remote`；home 在网络文件系统上或不可写时改这里。 |
| Advanced → SSH program | 本机 ssh 的完整路径。 |

`Test connection` 会真的连一次并报告主机平台（例如 “Linux x86_64”）。连接记录保存在本机数据目录的 `ssh-hosts.json`（权限 0600）；其中一条记录损坏只会跳过那一条。

## 3. 登录与主机密钥

- 认证完全交给 ssh：`~/.ssh/config`、IdentityFile、ssh-agent、1Password 等 agent 都照常生效。推荐使用 SSH 密钥 + ssh-agent，这样不会有任何弹窗。
- 需要密码、密钥口令时，ssh 通过 Claudex 的询问窗口（askpass）向你提问：标题为 “Sign in to …” 或 “Unlock SSH key”。**Claudex 不保存密码或口令**：只在写给 ssh 的那一刻存在于内存，不写日志、诊断或连接记录；没有 “Remember” 选项。120 秒无人回答自动取消。
- 第一次连接一台主机时会弹出 “Verify host”，显示主机密钥指纹（`SHA256:…`）。请与服务器管理员提供的指纹核对后再点 `Connect`；点 `Cancel` 时不会写入 known_hosts。
- 主机密钥变化时 ssh 直接拒绝，Claudex 显示 “The host key for … has changed …”，**不提供一键覆盖**。确认变化可信后，自己从 known_hosts 删除旧记录（`ssh-keygen -R <host>`）再重试。
- 后台自动重连不会弹窗：需要密码的主机断线后显示 `Sign in` 按钮，由你手动点。
- 默认不转发 ssh-agent（`ForwardAgent=no`，覆盖 `~/.ssh/config` 的设置），也不转发 X11。

## 4. 第一次连接：安装运行时

Claudex 在主机上运行与本机同版本的 Codex 引擎（当前 0.144.1），放在 `~/.claudex-remote/<clientId>/`（`clientId` 是本机设备 id 的哈希前 12 位，两台电脑连同一主机互不干扰）：

```
bin/codex-<版本>-<平台>/bin/codex   引擎
codex-home/   attachments/   run/   tmp/
```

安装顺序（界面显示 “Setting up Claudex on … 42%”）：

1. 已安装且校验标记匹配 → 跳过。
2. 主机自己用 curl/wget 下载（先用管理员配置的镜像，再用 npm 官方源），把 sha512 交回本机，由本机与内置清单比对（不信任主机的判断）。
3. 失败时本机下载（缓存在本机数据目录 `runtime-cache/`，支持断点续传），分块上传到主机，再次校验大小与 sha512。

目录权限为 700。旧版本和上次遗留的引擎进程只在本客户端目录内清理。

## 5. 在主机上工作

- 选中主机后，文件夹芯片列出该主机最近用过的目录，`Open folder…` 打开远程目录浏览窗口（输入路径或逐级浏览）。
- 模型请求：主机上的 Codex 访问主机回环地址上的一个转发端口，经 SSH 反向转发回到本机网关，再由本机网关发往 Claudex 服务。**设备 Key 与登录令牌永不离开本机**；主机只拿到一个仅在本次连接期间有效的网关令牌，经 stdin 传入，不出现在任何命令行、不写磁盘，断开即失效。转发端口只绑定主机的 127.0.0.1。
- 可用：对话与工具调用、终端（主机登录 shell，标题形如 `bash — <主机名>`）、Changes 面板、@ 文件、分支芯片、生成文件预览、审批。
- 不可用（界面隐藏或明确拒绝）：Reveal in Finder / Open in editor 等本机动作、dev servers 与 Browser 面板对主机端口、Chat 与 Cowork、定时任务（Routines 只支持 Local）、Windows 沙箱设置。
- MCP：只复制管理员允许、且不含密钥（env、headers、bearer token）的 MCP 服务器到主机；带密钥的服务器留在本机。
- 本机的附件：文本内联发送，图片以 data URL 发送（主机读不到本机文件）。

## 6. 断线与重连

- 连接断开后自动重连（2 秒起指数退避，最长 60 秒；电脑从睡眠唤醒或解锁时立即重试）。会话上方显示 “Reconnecting to …”。
- 断线期间写的消息进入待发送队列（显示 “Will send when … reconnects”，重启 Claudex 后仍保留）；重连后先检查主机上是否已收到，保证**只发送一次**。
- 关闭 Claudex 后主机上的任务不会继续（模型请求必须经过本机网关）；进行中的回合会标记为中断，重连后可重试。

## 7. 管理员

在管理控制台的客户端策略（Claudex policy）里：

- `ssh_remote`（SSH remote environments）：默认允许；关闭后桌面端不显示 SSH，拒绝连接，已有连接断开。
- `codex_runtime_mirror`：可选 https 地址，代替 `https://registry.npmjs.org/` 下载运行时（适合国内网络）；校验仍用客户端内置的 sha512，镜像无法替换内容。
- 设备的 `managed-settings.json` 支持 `sshHostAllowlist`：精确主机名或 `*.example.com`（包含根域名及任意层级的子域名），不区分大小写。使用 `ssh -G` 解析后的 `HostName` 校验别名；无法解析时校验输入的主机名。省略表示不限制，空数组拒绝所有主机。连接、测试及自动重连都会校验；策略变化会关闭已有连接。
- `sshClientPath` 可固定 OpenSSH 程序（例如 `/opt/openssh/bin/ssh`），优先于每个连接的程序设置；不可用或版本过旧时不会回退。最低版本为 OpenSSH 7.6，Windows 为 9.4。该设置也用于远程引擎的 SSH 通道。
- SSH 错误会区分密钥权限、格式、口令、代理拒绝、密钥过多、签名算法、配置错误、MaxSessions、磁盘已满及只读文件系统。测试连接失败后可展开 `Technical details` 查看有长度限制且已移除终端控制字符的原始诊断；诊断不写入日志。
- 用量：主机上的请求走同一台设备、同一把设备 Key，受相同的用量规则约束。

## 8. Windows 客户端

- Windows 版 OpenSSH 没有连接复用（ControlMaster）：每条命令是一个独立的 ssh 进程，远程引擎的 ssh 进程自己带反向转发（`-R`），Claudex 从它的 “Allocated port N …” 输出读取端口。使用密码登录时可能被多次询问，推荐启用 “OpenSSH Authentication Agent” 服务并 `ssh-add` 密钥。
- 需要 OpenSSH 8.4 以上才支持 `SSH_ASKPASS_REQUIRE`（Windows 10 早期自带 7.7 版本不支持，只能用 agent 或无口令密钥）。
- 本仓库提供 `scripts/ssh-e2e/windows-check.ps1`，在 Windows 电脑上检查 ssh.exe 版本、agent 服务，并可对一台主机实测 askpass 调用与 “Allocated port” 行（见第 10 节）。

**Windows 手测清单**（尚未在 Windows 实机验证）：

1. 系统 OpenSSH 存在 / 被移除时，Add 对话框与环境菜单的提示。
2. ssh-agent 服务停止时的密码询问、多次询问的体验。
3. askpass `.cmd` 包装：安装目录含空格、中文用户名。
4. 无 ControlMaster：连接、安装运行时（上传进度）、发送消息、终端、Changes。
5. 断网 → 重连 → 队列消息只发送一次。
6. 退出 Claudex 后任务管理器里没有残留的 ssh.exe。

## 9. 常见错误

| 界面提示 | 原因与处理 |
|---|---|
| OpenSSH isn't installed on this computer. | 安装系统 OpenSSH 客户端，或在 Advanced 指定 ssh 路径。 |
| Couldn't sign in to … | 密钥未被接受、agent 未加载密钥、密码错误。先在终端 `ssh <host>` 确认。 |
| The host key for … has changed … | 见第 3 节，核实后手动删除 known_hosts 中的旧记录。 |
| Can't reach … / Connecting to … timed out. | 网络、端口、防火墙；在终端用同一 Host 测试。 |
| Claudex can't run on … yet. | 主机不是 Linux/macOS x64/arm64。 |
| Couldn't set up Claudex on … | 目录不可写、磁盘满、下载与上传都失败；可改 “Remote folder for Claudex” 或请管理员配置镜像。 |
| Couldn't open the connection Claudex needs on … | sshd 不允许 TCP 转发（`AllowTcpForwarding no`）。 |
| Claudex stopped running on … | 主机上的引擎退出（内存不足等）；点 Try again。 |
| 命令输出 `bwrap: No permissions to create a new namespace…` | 主机不允许非特权用户命名空间，见第 1 节“命令沙箱”。 |
| Your administrator turned off SSH connections. | 管理员关闭了 `ssh_remote`。 |

## 10. 开发者：端到端测试

单元与集成测试（假 ssh + 真实 codex）随 `npm test` 运行。真实 OpenSSH 的端到端测试默认跳过，用脚本启动：

```sh
# 机器上有排队脚本时经它运行（Docker 内存紧张）
GOLOCK_WEIGHT=1 <golock.sh> scripts/ssh-e2e/run.sh            # 本机架构（Apple 芯片为 arm64）
GOLOCK_WEIGHT=1 <golock.sh> scripts/ssh-e2e/run.sh --arch amd64  # x86_64 主机（需要 Docker 开启 amd64 仿真，较慢）
scripts/ssh-e2e/run.sh -- --test-name-pattern "password"         # 只跑部分用例
```

- `scripts/ssh-e2e/Dockerfile`、`sshd_config`、`entrypoint.sh`、`docker-compose.yml`：Alpine（musl）上的 sshd，只监听 127.0.0.1 的随机端口；`dev` 账户用测试密钥登录，`pw` 账户只允许密码登录；每次启动生成新的主机密钥。
- `run.sh` 在 `/tmp/cxssh.*`（控制 socket 路径长度有限，可用 `CLAUDEX_SSH_E2E_TMP` 改父目录）生成一次性密钥、随机密码、独立的 `ssh_config` 与 `known_hosts`，以及一个只加 `-F <该配置>` 的 ssh 包装脚本，交给 Claudex 作为主机的 SSH program。**不读写 `~/.ssh`，不使用本机 ssh-agent**。结束时删除容器与临时目录（`--keep` 保留以便排查）。
- 主机用的 Codex 包下载一次到 `scripts/ssh-e2e/.cache/`（git 忽略）。
- `tests/ssh/e2e.test.ts` 覆盖：拒绝/接受新主机密钥（核对指纹）、master 复用、运行时上传安装与主机自行下载（`CLAUDEX_SSH_E2E_OFFLINE=1` 跳过后者）、经 `ssh -O forward` 的真实对话（命令在主机执行、令牌不在任何命令行、转发只绑回环、停止后引擎与转发都消失）、远程 Changes/分支/文件列表/读文件（经主机 Codex 与经 SSH 两种通道结果一致）、终端（主机登录 shell、所选目录）、master 断开自动重连、Windows 方式（无 master、`-R` + “Allocated port”）与断线期间消息只发一次、密码登录（错误密码、正确密码、密码不落盘、后台重连不弹窗）、主机密钥变化、端口拒绝、断开后无残留 ssh 进程。
- `scripts/ssh-e2e/windows-check.ps1`：Windows 客户端检查（见第 8 节）。
