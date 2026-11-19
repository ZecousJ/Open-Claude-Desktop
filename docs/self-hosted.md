# 完整版自托管

完整版由桌面客户端、Claudex 服务端和 Linux Runner 组成。服务端是本仓库 `backend/` 中的 Sub2API 分支，负责账户、策略、设备密钥、模型目录和 Runner 调度。Runner 连接服务端执行云端任务。用户桌面端向自托管域名登录。

```text
桌面客户端 / 可选 Web 界面
        │ HTTPS
   Claudex 服务端（Sub2API 分支） ─── 模型上游 API
        │ Runner 链路
   Linux Runner ─── Codex 执行引擎
```

| 要配置的内容 | 到哪里填写 |
| --- | --- |
| 镜像、端口、数据库、Redis、签名密钥 | `deploy/claudex-server/.env` |
| 注册验证、密码找回、SMTP | **系统设置 → 安全与认证、邮件设置** |
| 桌面与 Web 邮箱验证码登录 | **Claudex → 通用 → 登录** |
| 模型上游、模型定价、用户额度 | **账号管理、分组管理、渠道定价、用户管理** |
| 设备 Key、模型菜单、权限 | **Claudex → 设备、模型目录、客户端策略** |
| Runner 注册、Web 并发和访问权限 | **Claudex → 网页版**。Runner 进程配置放在 Runner 主机 |
| 支付、附件对象存储、听写 | **系统设置 → 支付设置**、服务端容器环境、**Claudex → 语音** |

字段、环境变量、管理 API 和验证方法见 [自托管配置参考](self-hosted-configuration.md)。

## 1. 启动服务端

准备 Docker Engine、Compose v2、数据库存储、Redis、域名和 TLS。正式环境使用 [生产部署说明](../deploy/claudex-server/README.md)。先在单机验证时，可使用独立开发栈。

```bash
docker compose -f deploy/claudex-server/docker-compose.dev.yml up -d --build
curl -fsS http://127.0.0.1:8080/health
```

生产环境从根目录构建镜像，然后配置并启动 Compose。

```bash
deploy/claudex-server/build-image.sh --tag claudex-server:self-hosted
cd deploy/claudex-server
cp .env.example .env
chmod 600 .env
# 填写 CLAUDEX_SERVER_IMAGE=claudex-server:self-hosted，
# 并设置管理员账号、持久化数据库凭据、JWT 和 TOTP 密钥。
docker compose config --quiet
docker compose up -d
docker compose ps
```

服务变为 `healthy` 后配置 Nginx 和 TLS。单服务器部署时，示例中指向 `127.0.0.1:18080` 的上游也要改为实际的 `CLAUDEX_SERVER_PORT`。保留 Host、HTTPS 转发头、WebSocket 升级头和 SSE 无缓冲配置。运行 `nginx -t`，重新加载后检查公网域名的 `/health`。PostgreSQL 和 Redis 使用 Compose 内部网络。 [Nginx 示例](../deploy/claudex-server/nginx.conf.example)

访问 `https://claudex.example.com/admin`，用 `ADMIN_EMAIL` 和 `ADMIN_PASSWORD` 登录。由部署所有者在控制台完成 Sub2API 的运营承诺。后台接口返回 `423 ADMIN_COMPLIANCE_ACK_REQUIRED` 时检查承诺状态。 [服务端检查与备份](../deploy/claudex-server/README.md)

## 2. 配置邮箱与登录

在 **系统设置 → 安全与认证 → 注册设置** 启用**邮箱验证**并保存，再打开 **系统设置 → 邮件设置 → SMTP 设置**。填写主机、端口、用户名、SMTP 凭据和发件人，开启**使用 TLS**。依次点**测试连接**和**发送测试邮件**，确认测试邮箱实际收到后保存。

需要桌面端和网页验证码登录时，在 **Claudex → 通用 → 登录** 打开**使用邮箱验证码登录**。需要找回密码时，在**注册设置**启用**忘记密码**，填写用户实际访问的 HTTPS **前端地址**。用测试账户完成实际启用的流程。 [SMTP 字段、Compose 写法和测试接口](self-hosted-configuration.md#邮箱与登录)

## 3. 在 Sub2API 控制台配置模型

1. 在 **分组管理**（`/admin/groups`）创建 OpenAI 平台分组。选择标准或订阅计费，再设置并发和限额。
2. 在 **账号管理**（`/admin/accounts`）新增上游账户，类型选 **API Key**。填写授权使用的请求地址和密钥，关联该分组。已有的独立 Sub2API 也可作为 OpenAI 兼容上游，使用它发放的普通调用密钥，不填写管理员密钥。
3. 在 **渠道定价**（`/admin/channels/pricing`）将渠道绑定分组并配置价格。配置支持的模型白名单或映射。在 **Claudex → 模型目录** 选择显示位置和默认模型，核对推理强度在上游可用。
4. 在 **Claudex → 设备** 启用**设备登录时发放设备 Key**，设置允许的分组、分组策略和默认分组。在 **用户管理** 添加用户并授权分组，再分配余额或订阅。
5. 在控制台测试上游连通性。再用普通用户登录，确认能领取设备密钥、看到正确模型并产生一条调用记录。

需要以脚本初始化时可参考 [Sub2API 配置脚本](../deploy/sub2api/README.md) 与 [参数示例](../deploy/sub2api/seed.env.example)。接入标准 Sub2API 时，账户管理和 Runner 连接使用本仓库的 Claudex 服务端接口；独立 Sub2API 仅承担上游模型网关角色。

## 4. 注册并运行 Linux Runner

在服务端管理台的 **Claudex → 网页版 → Runner** 点**添加 runner**并生成令牌，复制注册令牌并保存为权限为 `0600` 的文件。Runner 主机需有 Node.js 24、Git 和 Linux 隔离运行时。生产多用户部署推荐使用 gVisor，可参考 [Runner 沙箱镜像](../deploy/claudex-runner/image/README.md)；单机也支持 bubblewrap。

```bash
npm ci
npm run build:runner
npm install -g @openai/codex@0.149.1

export CLAUDEX_RUNNER_SERVICE_URL=https://claudex.example.com
export CLAUDEX_RUNNER_TOKEN_FILE=/etc/claudex/runner.token
export CLAUDEX_RUNNER_STATE_DIR=/var/lib/claudex-runner
export CLAUDEX_RUNNER_CODEX="$(command -v codex)"
export CLAUDEX_RUNNER_DRIVER=bwrap
export CLAUDEX_RUNNER_MODES=chat,cowork,code
node dist-runner/runner.mjs
```

确保运行 Runner 的系统用户能读取令牌文件、写入状态目录并启动配置的沙箱。常驻部署使用 systemd，把环境变量写进受限的 `EnvironmentFile`，设置 `WorkingDirectory` 为仓库所在路径，`ExecStart` 使用上述 Node 命令的绝对路径。管理台的 Runner 列表应显示**在线**和可用容量。Web 版在同页的**访问**中启用，并按需加入允许的邮箱或用户 ID。 [Runner 参数与 systemd 示例](self-hosted-configuration.md#runner-配置)

## 5. 自行构建客户端

从仓库根目录指定自己的服务端地址。客户端登录后由服务端发现和分配 Runner。Runner 的令牌只留在 Runner，用户客户端不需要它。

```bash
npm ci
export CLAUDEX_SUB2API_URL=https://claudex.example.com
export CLAUDEX_MAC_SIGNING_IDENTITY="your signing identity"
npm run package:full -- darwin arm64
```

在 Windows 上额外安装 Go。Windows PowerShell 用 `$env:CLAUDEX_SUB2API_URL = "https://claudex.example.com"` 设置服务地址，再运行 `npm run package:full -- win32 x64`。Linux 使用 `npm run package:full -- linux x64`。构建产物位于 `release/full/`。

启用 Web 客户端时运行 `npm run build:web`。把 `dist-web/` 只读挂载到同一个 Claudex 服务端，并设置 `CLAUDEX_WEB_APP_DIR`。Web 页面和 API 使用同一个 HTTPS 源，管理控制台仍使用 `/admin`。 [Web 挂载与客户端地址覆盖](self-hosted-configuration.md#客户端与网页版)

## 6. 验收和运维

- 从普通用户桌面客户端登录，核对设备、模型目录和默认模型。
- 各发一条本地和云端消息。查看 Runner 状态、服务端用量记录，以及退出重开后会话能否恢复。
- 对云端 Code 用自己的测试 Git 仓库验证工作目录、Shell 和文件保存。上线前为需要使用的云端环境和仓库按部署策略配置最小访问权限。
- 启用了 SMTP、支付或对象存储时，分别测试收件、回调到账、浏览器上传与下载。 [支付配置](self-hosted-configuration.md#模型支付和听写) · [附件配置](self-hosted-configuration.md#附件对象存储)
- 使用 [备份与恢复步骤](../deploy/claudex-server/README.md#备份与恢复--backup-and-restore) 持久化服务端数据库和数据卷，单独保留 Runner 状态目录。轮换 Runner 令牌时，在更换令牌文件后重启 Runner。
