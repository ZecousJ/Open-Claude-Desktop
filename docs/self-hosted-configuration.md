# 完整版自托管配置参考

以部署域名 `https://claudex.example.com` 为例，后台入口是 `/admin`。示例中的地址和凭据换成你的实际值。 [部署步骤](self-hosted.md)

| 配置位置 | 内容 |
| --- | --- |
| `deploy/claudex-server/.env` | 镜像、端口、PostgreSQL、Redis、首个管理员与签名密钥。Compose 只把服务的 `environment` 或 `env_file` 所引入的值传入容器 |
| 容器 `/app/data` | 服务端数据卷。首次初始化写入 `config.yaml` 和安装锁 |
| 管理控制台 `/admin` | SMTP、注册和登录、用户、支付、模型分组、设备及 Web 策略。设置存入 PostgreSQL |
| Runner 主机 | `/etc/claudex/runner.env`、令牌文件和状态目录 |
| 桌面构建环境 | `CLAUDEX_SUB2API_URL`。构建后还可以用应用数据目录中的配置覆盖 |

## 服务端环境

| 生产 `.env` 字段 | 填写方法 |
| --- | --- |
| `CLAUDEX_SERVER_IMAGE` | 已构建并载入的镜像，例如 `claudex-server:self-hosted` |
| `BIND_HOST`、`CLAUDEX_SERVER_PORT` | 宿主机监听地址和端口，默认 `127.0.0.1:8080`。Nginx 转发到该端口 |
| `POSTGRES_USER`、`POSTGRES_DB`、`POSTGRES_PASSWORD` | 默认用户和库名均为 `sub2api`。已有数据库改密码时，同时修改数据库账户 |
| `REDIS_PASSWORD` | 服务端与 Compose 内部 Redis 共用的密码 |
| `ADMIN_EMAIL`、`ADMIN_PASSWORD` | 首次初始化的管理员账号。后续在后台改密码 |
| `JWT_SECRET`、`TOTP_ENCRYPTION_KEY` | 各用一次 `openssl rand -hex 32` 生成。保留原值用于重建和恢复，否则已签发会话或二次验证凭据会受影响 |
| `TZ`、`JWT_ACCESS_TOKEN_EXPIRE_MINUTES` | 默认 `Asia/Shanghai` 和 60 分钟 |
| `SECURITY_URL_ALLOWLIST_ENABLED`、`SECURITY_URL_ALLOWLIST_UPSTREAM_HOSTS` | 开启后按逗号列出上游主机名。自建内网网关还需核对 `SECURITY_URL_ALLOWLIST_ALLOW_PRIVATE_HOSTS` 与 `SECURITY_URL_ALLOWLIST_ALLOW_INSECURE_HTTP` |
| `UPDATE_PROXY_URL` | 定价数据下载代理 |

[生产 Compose](../deploy/claudex-server/docker-compose.yml) · [环境变量样例](../deploy/claudex-server/.env.example)。

## 邮箱与登录

在 **系统设置 → 安全与认证 → 注册设置** 启用**邮箱验证**并保存，再进入 **系统设置 → 邮件设置 → SMTP 设置**。邮箱验证同时决定新用户注册时是否要求验证码。**开放注册**、**邀请码注册**和**邮箱域名白名单**也在注册设置中。

| 后台字段 | API 字段 | 填写示例 |
| --- | --- | --- |
| SMTP 主机 | `smtp_host` | `smtp.example.com`，填主机名 |
| SMTP 端口 | `smtp_port` | 587 常用于 STARTTLS，465 常用于直接 TLS。以服务商提供的端口为准 |
| SMTP 用户名 | `smtp_username` | `mailer@example.com` 或服务商给的 SMTP 登录名 |
| SMTP 密码 | `smtp_password` | SMTP 密码、应用专用密码或授权码。已保存密码时留空可保留当前值 |
| 发件人邮箱 | `smtp_from_email` | `mailer@example.com`，需获服务商授权 |
| 发件人名称 | `smtp_from_name` | `Claudex` |
| 使用 TLS | `smtp_use_tls` | 开启后要求加密连接，服务端支持直接 TLS 和强制 STARTTLS |

邮件由 Claudex 服务端通过 SMTP 发送。邮件服务商提供 SMTP 中继时，使用中继主机和 SMTP 登录凭据。服务商明确指定用于 SMTP 认证的 API Key 可作 SMTP 密码。 [SMTP 传输实现](../backend/backend/internal/service/email_service.go)

点**测试连接**确认连接和认证，再点**发送测试邮件**核对实际收件。在 **Claudex → 通用 → 登录** 打开**使用邮箱验证码登录**，桌面和网页才会提供验证码登录。需要密码找回时，在**注册设置**打开**忘记密码**，把**前端地址**设为用户访问的 HTTPS 地址。 [Claudex 登录配置](../backend/frontend/src/i18n/locales/zh/admin/claudexGeneral.ts)

### 用容器环境配置 SMTP

后台 SMTP 主机已填写时，服务端采用后台保存的整组配置。后台 SMTP 主机为空时，服务端读取 `CLAUDEX_SMTP_*`。类型支持 `qq`、`163`、`126`、`gmail`、`outlook`、`aliyun`、`custom`，留空时用 `qq`。预设可继承主机、端口和 TLS 设置。 [SMTP 环境变量解析](../backend/backend/internal/service/email_env.go)

在 `deploy/claudex-server` 创建权限为 `0600` 的 `.env.smtp`。下面是自定义服务的 587 示例。

```dotenv
CLAUDEX_SMTP_TYPE=custom
CLAUDEX_SMTP_HOST=smtp.example.com
CLAUDEX_SMTP_PORT=587
CLAUDEX_SMTP_USERNAME=mailer@example.com
CLAUDEX_SMTP_PASSWORD=replace-with-smtp-credential
CLAUDEX_SMTP_FROM=mailer@example.com
CLAUDEX_SMTP_FROM_NAME=Claudex
CLAUDEX_SMTP_USE_SSL=false
CLAUDEX_SMTP_USE_STARTTLS=true
```

用户名留空时使用发件人邮箱，发件人名称默认 `Claudex`。465 直连 TLS 对应 `CLAUDEX_SMTP_PORT=465`、`CLAUDEX_SMTP_USE_SSL=true` 和 `CLAUDEX_SMTP_USE_STARTTLS=false`。

在同一目录创建本机的 `compose.local.yml`，把文件引入服务端容器。

```yaml
services:
  claudex-server:
    env_file:
      - ./.env.smtp
```

从 `deploy/claudex-server` 应用配置。以后维护此实例时使用相同的 Compose 文件组合。

```bash
docker compose -f docker-compose.yml -f compose.local.yml config --quiet
docker compose -f docker-compose.yml -f compose.local.yml up -d
```

### 管理接口和故障排查

| 管理员接口 | 用途与请求 |
| --- | --- |
| `GET /api/v1/admin/settings` | 读取后台设置及密码配置状态 |
| `POST /api/v1/admin/settings/test-smtp` | 测试连接和认证。可传上表的连接字段，发送 `{}` 则测试当前生效配置 |
| `POST /api/v1/admin/settings/send-test-email` | 实际发送一封测试信。`{"email":"test@example.com"}` 使用当前生效配置 |
| `GET /api/v1/admin/settings/email-templates` | 查看模板。后台入口为**邮件设置 → 邮件模板** |

管理接口需要管理员认证。使用登录令牌时以 `Authorization: Bearer <管理员访问令牌>` 传入。POST 请求使用 `Content-Type: application/json`。 [接口实现及完整请求字段](../backend/backend/internal/handler/admin/setting_handler_email.go) · [管理路由](../backend/backend/internal/server/routes/admin.go)

| 现象 | 检查项 |
| --- | --- |
| 邮件设置提示邮箱验证未启用 | 启用**安全与认证 → 注册设置 → 邮箱验证**并保存 |
| `SMTP host is required` | 检查后台主机，或检查服务端容器是否读取了 `.env.smtp` 及其中的发件人和 SMTP 密码 |
| 连接超时或证书错误 | 检查服务端出站端口、TLS 模式和邮件服务器证书 |
| 认证失败 | 检查用户名、授权码和服务商的 SMTP 登录开关 |
| 测试连接通过但没收到信 | 使用**发送测试邮件**，再检查发件人权限、送达日志和垃圾邮箱 |
| 登录页没有验证码入口 | 查 **Claudex → 通用 → 登录** 的 SMTP 状态和开关。Backend 模式开启时普通用户无法登录 |
| 密码重置链接地址错误 | 将**注册设置 → 前端地址**设为实际访问的站点 |

## 模型、支付和听写

| 功能 | 后台位置 | 关键字段 |
| --- | --- | --- |
| 上游服务 | **账号管理**（`/admin/accounts`） | 平台、API Key 类型、上游 Base URL、上游 API Key、分组 |
| 模型权限和价格 | **分组管理**（`/admin/groups`）、**渠道定价**（`/admin/channels/pricing`） | 分组计费方式、限额、模型映射或白名单、渠道价格 |
| 设备 Key | **Claudex → 设备**（`/admin/claudex/devices`） | **设备登录时发放设备 Key**、分组策略、默认分组、允许的分组 |
| 模型菜单 | **Claudex → 模型目录**（`/admin/claudex/models`） | 默认模型、菜单位置、推理强度。要停用模型，在分组的白名单中移除 |
| 客户端权限 | **Claudex → 客户端策略**（`/admin/claudex/policy`） | 功能开关和权限默认值 |
| 听写 | **Claudex → 语音**（`/admin/claudex/voice`） | 识别服务的 `wss://` 地址、API 密钥、会话时长、音频上限和空闲超时。价格按分组的 `audio_stt_price_per_hour` 配置 |

支付在 **系统设置 → 支付设置**。先打开**启用支付**，再在**启用的服务商**选服务商，并在**管理服务商**创建启用的实例。

| 服务商 | 常用字段 | 异步回调 |
| --- | --- | --- |
| 支付宝官方 | App ID、应用私钥、支付宝公钥、通知地址和需要的同步跳转地址 | `/api/v1/payment/webhook/alipay` |
| 微信官方 | App ID、商户号、商户私钥、API v3 密钥、证书序列号、支付公钥与公钥 ID、通知地址 | `/api/v1/payment/webhook/wxpay` |
| 易支付 | 商户 ID、商户密钥、API 基础地址、通知和返回地址、对应渠道 | `/api/v1/payment/webhook/easypay` |

服务商的回调设为可公网访问的 HTTPS 地址，例如 `https://claudex.example.com/api/v1/payment/webhook/alipay`。此路径由支付处理器接收，代理需允许服务商访问。**余额充值倍率**是每支付 1 CNY 发放的 USD 余额，**订阅 CNY 换算汇率**是每 1 USD 套餐价格收取的 CNY。检查金额上下限、手续费和**禁用余额充值**开关。 [支付路由](../backend/backend/internal/server/routes/payment.go) · [后台支付字段](../backend/frontend/src/i18n/locales/zh/admin/settings.ts)

## 附件对象存储

在 `deploy/claudex-server` 创建权限为 `0600` 的 `.env.attachments`，填写 S3 兼容对象存储配置。

```dotenv
CLAUDEX_ATTACHMENTS_S3_ENDPOINT=https://s3.example.com
CLAUDEX_ATTACHMENTS_S3_BUCKET=claudex-attachments
CLAUDEX_ATTACHMENTS_S3_REGION=region-from-provider
CLAUDEX_ATTACHMENTS_S3_ACCESS_KEY_ID=replace-with-access-key-id
CLAUDEX_ATTACHMENTS_S3_SECRET_ACCESS_KEY=replace-with-secret-access-key
```

端点填 S3 API 的 HTTPS 根域名。浏览器使用 `https://claudex-attachments.s3.example.com` 的签名地址，桶域名需要可解析且证书有效。桶保持私有。凭据需要对该桶的对象执行上传、读取、元数据查询和删除。服务端经代理访问时可加 `CLAUDEX_ATTACHMENTS_S3_PROXY`，浏览器直传仍从用户浏览器访问桶域名。 [S3 实现](../backend/backend/internal/claudex/attachmentstore/s3.go)

在存储控制台配置桶 CORS。允许实际的 Claudex 网页源，如 `https://claudex.example.com`，并允许 `PUT`、`GET` 以及 `If-None-Match`、`X-Amz-Content-Sha256`、`Content-Type` 请求头。将 `./.env.attachments` 加入 [Compose 覆盖文件](#用容器环境配置-smtp) 的 `env_file` 列表。重建服务端容器后，在浏览器测试上传和下载。预检失败时检查桶 CORS 与网页源。预检通过但上传失败时检查签名端点、区域和桶权限。

## Runner 配置

**Claudex → 网页版**保存访问名单、浏览器会话数、总并发、每用户并发、最长运行时间和 Runner 注册记录。Runner 进程参数放在 Runner 主机。

| Runner 变量 | 默认值或用途 |
| --- | --- |
| `CLAUDEX_RUNNER_SERVICE_URL` | Claudex 的 HTTPS 根地址，同机环回地址允许 HTTP |
| `CLAUDEX_RUNNER_TOKEN_FILE` | 注册令牌文件，优先于 `CLAUDEX_RUNNER_TOKEN` |
| `CLAUDEX_RUNNER_STATE_DIR` | 默认 `/var/lib/claudex-runner`，保存工作状态和沙箱 |
| `CLAUDEX_RUNNER_CODEX` | Codex 可执行文件绝对路径 |
| `CLAUDEX_RUNNER_DRIVER` | 默认 `bwrap`，gVisor 用 `runsc` 并以 `CLAUDEX_RUNNER_IMAGE` 指定 rootfs |
| `CLAUDEX_RUNNER_MODES` | 默认 `chat`。运行云端 Code 时包含 `code` |
| `CLAUDEX_RUNNER_MAX_ENGINES`、`CLAUDEX_RUNNER_MAX_USERS` | 默认 1 和 20 |
| `CLAUDEX_RUNNER_CPUS`、`CLAUDEX_RUNNER_MEMORY_MB`、`CLAUDEX_RUNNER_PIDS` | 默认 1 核、768 MiB、512 个进程 |
| `CLAUDEX_RUNNER_NETWORK` | 默认 `trusted` |

[Runner 参数解析](../runner/src/runner-config.ts) · [沙箱网络配置](../runner/src/net-policy-compile.ts) · [gVisor rootfs](../deploy/claudex-runner/image/README.md)。

在 Runner 主机创建 `/etc/systemd/system/claudex-runner.service`。该示例使用已有的 `claudex-runner` 用户、`/opt/claudex` 源码目录和 `/usr/bin/node`，按实际安装位置修改。

```ini
[Unit]
Description=Claudex Runner
After=network-online.target
Wants=network-online.target

[Service]
User=claudex-runner
WorkingDirectory=/opt/claudex
EnvironmentFile=/etc/claudex/runner.env
ExecStart=/usr/bin/node /opt/claudex/dist-runner/runner.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启动后用 `systemctl status claudex-runner`、`journalctl -u claudex-runner -n 80` 和后台 Runner 列表查看状态。连不上时核对令牌、服务地址和代理对 `/api/v1/claudex/web/runner/link` 的 WebSocket 升级配置。 [链路实现](../backend/backend/internal/claudex/webhost/link.go)

## 客户端与网页版

桌面端的服务地址依次采用应用数据目录的 `backend/sub2api.json`、运行时的 `CLAUDEX_SUB2API_URL`、构建时的 `CLAUDEX_SUB2API_URL`。地址填 Claudex 服务端根地址。升级后仍连旧服务时，核对本机覆盖文件。 [地址配置实现](../server/sub2api-config.ts)

Web 页面和 API 由同一个 Claudex 服务端提供。文档预览使用独立的 HTTPS 源。构建时填入预览域名，构建脚本会自动准备工作区资源。

```sh
VITE_CLAUDEX_OFFICIAL_USERCONTENT_ORIGIN=https://preview.example.net npm run build:web
npm run build:runner
CLAUDEX_USERCONTENT_ROOT="$PWD/build/official-usercontent" \
CLAUDEX_USERCONTENT_PARENT_ORIGIN=https://claudex.example.com \
CLAUDEX_USERCONTENT_ORIGIN=https://preview.example.net \
node dist-runner/official-usercontent.mjs
```

将预览域名的 HTTPS 请求代理到预览服务的默认监听地址 `127.0.0.1:4350`。在服务端 Compose 中设置同一个预览源，并挂载 Web 产物。挂载路径以生产 Compose 所在目录为基准。

```yaml
services:
  claudex-server:
    environment:
      CLAUDEX_WEB_APP_DIR: /app/claudex-web
      CLAUDEX_USERCONTENT_ORIGIN: https://preview.example.net
    volumes:
      - ../../dist-web:/app/claudex-web:ro
```

用相同的两个 Compose 文件执行 `config --quiet` 与 `up -d`。确认目录包含 `index.html` 和 `assets/`，然后在 **Claudex → 网页版 → 访问** 打开需要的访问范围。Web 页面、静态资源和登录接口使用同一个公共 HTTPS 源。管理控制台仍由该服务的 `/admin` 提供。 [站点路由](../backend/backend/internal/web/site.go) · [反向代理示例](../deploy/claudex-server/nginx.conf.example)
