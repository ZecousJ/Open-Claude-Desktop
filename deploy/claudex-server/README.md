# Claudex server deployment / Claudex 服务端部署

本目录构建并运行 Claudex 服务端，即本仓库 `backend/` 中的 Sub2API 分支（Sub2API 的全部原有功能，加上 Claudex 扩展；修改清单见 [`backend/CLAUDEX_CHANGES.md`](../../backend/CLAUDEX_CHANGES.md)）。网页控制台只给管理员用，终端用户使用 Claudex 桌面端。

| 文件 | 用途 |
|---|---|
| `Dockerfile`、`Dockerfile.dockerignore` | 从 `backend/` 构建镜像（构建上下文是 `backend/`，上游 `backend/Dockerfile` 不改） |
| `build-image.sh` | 填好版本号与提交号后构建镜像 |
| `docker-compose.dev.yml` | 开发环境：从源码构建，`127.0.0.1:8080`，PostgreSQL 18、Redis 8，命名卷 |
| `docker-compose.yml`、`.env.example` | 生产环境：使用构建好的镜像 `${CLAUDEX_SERVER_IMAGE}` |
| `nginx.conf.example` | TLS 反向代理（`underscores_in_headers on`、SSE 不缓冲、访问日志不记录查询串） |
| `check.sh` | 只读检查：健康、数据库、公开接口、合规闸门状态 |
| `backup.sh` | 数据库转储与数据卷归档，保留最近 N 份 |

初始化 Claudex 的分组、上游账号、定价和测试用户用 [`deploy/sub2api/seed-claudex.sh`](../sub2api/README.md)。

## 许可 / License

`backend/` 按 LGPL-3.0 发布（上游 `LICENSE` 原样保留，另附 GPL-3.0 全文 `COPYING`），仓库其余部分为 Apache-2.0。上游 README 声明其开发者未授权任何商业化运营，对外提供服务前请先阅读（见 `backend/SOURCE_OFFER.md` 末节）。镜像里带有：

- `/app/LICENSE`（LGPL-3.0 全文）、`/app/COPYING`（LGPL-3.0 所依据的 GPL-3.0 全文）、`/app/CLAUDEX_CHANGES.md`（对 Sub2API 的修改清单）；
- `/app/SOURCE.txt`：版本、上游 Sub2API 提交、本仓库地址与提交号，对应源码就是该提交的 `backend/` 目录加本目录的 `Dockerfile`；
- OCI 标签 `org.opencontainers.image.source`、`org.opencontainers.image.revision`、`org.opencontainers.image.licenses=LGPL-3.0-only`。

分发镜像或二进制时要同时提供对应源码，做法见 [`backend/SOURCE_OFFER.md`](../../backend/SOURCE_OFFER.md)。工作区有未提交改动时，提交号带 `-dirty`，`SOURCE.txt` 会写明“不得分发”；只分发从干净提交构建的镜像。

## 构建镜像 / Build the image

```bash
deploy/claudex-server/build-image.sh                    # claudex-server:<版本> 与 claudex-server:latest
deploy/claudex-server/build-image.sh --tag registry.example.com/claudex-server:0.2.8-claudex.7
docker build -f deploy/claudex-server/Dockerfile backend/   # 等价的原始命令（版本号为 +claudex.0，提交号 unknown）
```

- 版本号为 `<backend/backend/cmd/server/VERSION>+claudex.<N>`（semver 的 build 元数据），`N` 是修改过 `backend/` 的提交数（`CLAUDEX_REV` 可覆盖），构建类型 `source`。`/api/v1/claudex/release` 和 `sub2api --version` 都显示它。不能写成预发布形式 `-claudex.N`：上游插件兼容检查用 semver 比较，`0.2.8-claudex.N` 低于 `0.2.8`，要求 `>=0.2.8` 的插件会全部被判为不兼容。镜像标签不能含 `+`，所以 `build-image.sh` 默认标签把 `+` 换成 `-`（`claudex-server:0.2.8-claudex.N`）。
- 构建分三段：`node:24-alpine` + pnpm 9 构建控制台，`golang:1.27.0-alpine` 编译内嵌控制台的服务端（`-tags embed`），`alpine:3.21` 运行（用户 `sub2api`，uid 1000，非 root）。镜像带 PostgreSQL 18 的 `pg_dump`/`psql`。
- 网络不稳时：下载步骤会重试；Go 模块在 `https://proxy.golang.org` 和 `https://goproxy.cn` 之间交替；npm 前两次用官方源，之后换 `NPM_MIRROR_REGISTRY`（默认 npmmirror，包内容仍按 `pnpm-lock.yaml` 的哈希校验）。可用 `--build-arg NPM_CONFIG_REGISTRY=...`、`--build-arg GOPROXY=...` 固定来源，`--build-arg NPM_MIRROR_REGISTRY=` 关闭换源。
- 内存小的机器加 `-- --build-arg GOFLAGS=-p=2`。
- 生产机器上可以 `docker save claudex-server:<版本> | ssh host docker load`，或推到自己的镜像仓库；不需要推送到任何公共仓库。

## 开发环境 / Development stack

```bash
docker compose -f deploy/claudex-server/docker-compose.dev.yml up -d --build
deploy/claudex-server/check.sh --dev
docker compose -f deploy/claudex-server/docker-compose.dev.yml logs -f claudex-server
docker compose -f deploy/claudex-server/docker-compose.dev.yml down        # 保留数据；down -v 连数据一起删除
```

- 只监听 `127.0.0.1:${CLAUDEX_DEV_PORT:-8080}`；数据库密码固定、Redis 无密码，都只在内部网络上，不能用于生产。
- 首个管理员是 `admin@claudex.local`。不设 `CLAUDEX_DEV_ADMIN_PASSWORD` 时，服务端首次启动在日志里打印一次性密码（`Generated admin password (one-time)`），`check.sh --dev` 会从日志读取它。容器重建（例如再次 `up --build`）后日志里就没有这个密码了，记下它，或用 `ADMIN_PASSWORD=... check.sh --dev`，或 `down -v` 从头开始。
- JWT 密钥首次启动时生成并保存在数据卷的 `config.yaml`；TOTP 密钥每次启动随机，所以开发环境不能开启双因素登录（需要时设置 `CLAUDEX_DEV_TOTP_ENCRYPTION_KEY`）。
- 变量都带 `CLAUDEX_DEV_` 前缀，本目录里生产用的 `.env` 不会作用到开发环境。
- `scripts/backend/dev-stack.sh` 是另一套开发环境（直接运行 `scripts/backend/build.sh` 编出的二进制，并带模拟上游），两者可以并存（端口 18080 与 8080）。

## 生产部署 / Production

需要 Docker Engine + Compose v2、一个域名和 TLS 证书。

```bash
cd deploy/claudex-server
cp .env.example .env && chmod 600 .env
# 把每个 change-me 换成真实值；密钥用 openssl rand -hex 32 生成；CLAUDEX_SERVER_IMAGE 写构建好的镜像
docker compose config --quiet          # 缺少必填项时给出明确提示
docker compose up -d
docker compose ps                      # 迁移完成后 claudex-server 变为 healthy
ADMIN_EMAIL=... ADMIN_PASSWORD=... ./check.sh http://127.0.0.1:8080
```

- 首次启动执行 `AUTO_SETUP`：建库迁移、用 `ADMIN_EMAIL`/`ADMIN_PASSWORD` 创建首个管理员、把 `config.yaml` 写入数据卷。之后在控制台修改管理员密码。
- `JWT_SECRET`、`TOTP_ENCRYPTION_KEY` 必须固定：更换会让所有人登出、已保存的双因素密钥失效。
- **登录令牌（access token）有效期 60 分钟**（`JWT_ACCESS_TOKEN_EXPIRE_MINUTES=60`），刷新令牌机制不变，桌面端自动续期。令牌越短，“登出所有设备”之后旧令牌还能用的时间越短。
- 建议在控制台开启 step-up 双因素验证（系统设置）。开启后，放宽策略、吊销设备等敏感管理操作需要最近通过双因素验证的管理员会话，管理员 API Key 不能再做这些操作。
- **密钥也可以用文件提供**：镜像入口脚本支持 `<名称>_FILE=/路径`（`DATABASE_PASSWORD`、`REDIS_PASSWORD`、`JWT_SECRET`、`TOTP_ENCRYPTION_KEY`、`ADMIN_PASSWORD`），适合 Docker/Kubernetes secrets；同一个密钥同时给值和文件、文件不可读、或者值仍是 `change-me` 占位符时，容器拒绝启动。本目录的 compose 从 `.env` 传入这些值；改用文件时在 `docker-compose.override.yml` 里把对应变量设为空串并加上 `<名称>_FILE`（例如 compose 的 `secrets:`），文件要对容器用户 uid 1000 可读。注意首次启动的 `AUTO_SETUP` 仍会把数据库密码、Redis 密码和 JWT 密钥写进数据卷里的 `config.yaml`（上游行为），所以数据卷和备份都要按密钥对待。
- 服务端只发布在 `127.0.0.1`，由同机的 TLS 反向代理转发。Redis 只存缓存、限流窗口和会话。

## 合规承诺 / Compliance commitment（必须由所有者本人完成）

分支原样保留 Sub2API 的管理员合规闸门：在管理员接受《Sub2API 部署与运营合规承诺》之前，控制台和所有 `/api/v1/admin/*` 请求（包括管理员 API Key 发出的）都返回 **423 `ADMIN_COMPLIANCE_ACK_REQUIRED`**，Claudex 的管理接口 `/api/v1/admin/claudex/*` 同样在闸门之后。接受承诺是一项电子协议，记录管理员账号、时间、IP 和 User-Agent。

**只有项目所有者本人能在控制台里接受这项承诺。** 本仓库的任何脚本、迁移、测试都不会接受它、输入确认短语、写入承诺记录或绕过闸门；`check.sh` 只报告状态，`seed-claudex.sh` 在承诺未接受时以退出码 3 停止且不写入任何数据。只接入你有权通过 API Key 使用的上游，不要接入消费级订阅或 Claude 账号。

## TLS 与反向代理 / TLS and reverse proxy

`nginx.conf.example` 基于 `backend/deploy/EDGE_SECURITY.md`，已用 `nginx -t` 检查：

- `underscores_in_headers on;`：否则 nginx 丢弃带下划线的请求头，例如 Codex 类客户端用于粘性路由的 `session_id`。
- SSE：`proxy_buffering off`、`proxy_request_buffering off`、1800 秒读写超时、不压缩；模型回复会以 SSE 持续数分钟。
- **访问日志不记录查询串**（`claudex_noquery` 格式，整个站点生效）：上游网页支付页的 `/payment/stripe?client_secret=...`、Stripe 跳转回 `/payment/result` 时附加的 `payment_intent_client_secret`、Google 风格客户端的 `?key=...`，以及支付页 URL 出现在其静态资源请求的 `Referer` 里，都可能带密钥；日志只记录路径和不含查询串的 Referer。桌面端结账页 `/desktop-pay` 的一次性令牌放在 URL fragment 里，本来就不会发到服务端。nginx 的错误日志在出错时仍可能引用完整请求行，限制其读取权限。
- `/api/v1/auth/` 限流；可选只允许运维网络访问 `/api/v1/admin/`（桌面端从不调用它）。
- 客户端 IP：默认信任 `X-Real-IP`/`X-Forwarded-For`。要强制可信代理链，在 `claudex-server` 的环境里加 `SERVER_TRUSTED_PROXIES=<代理地址>`，并按 `EDGE_SECURITY.md` 在控制台安全设置里关闭转发 IP 开关；compose 默认不传这个变量，因为即使是空值也会改变模式。
- 上游确定后建议设置 `SECURITY_URL_ALLOWLIST_ENABLED=true`、`SECURITY_URL_ALLOWLIST_UPSTREAM_HOSTS=<上游主机>`、`SECURITY_URL_ALLOWLIST_ALLOW_INSECURE_HTTP=false`。

桌面端从 Electron 主进程调用服务端，不需要 CORS。

## 备份与恢复 / Backup and restore

```bash
deploy/claudex-server/backup.sh                    # 写入 deploy/claudex-server/backups/，保留最近 14 份
deploy/claudex-server/backup.sh --keep 30 --dir /srv/backups/claudex
# cron：30 3 * * * /opt/claudex/deploy/claudex-server/backup.sh --keep 30
```

`backup.sh` 在 postgres 容器内执行 `pg_dump -Fc`（服务运行时也一致）并用 `pg_restore --list` 校验，再把服务端数据卷 `/app/data`（`config.yaml`、安装锁，不含日志）打包。文件权限 600，因为 `config.yaml` 含数据库密码和 JWT 密钥。把 `.env` 加密后与备份一起保存。

恢复到新机器或新卷（`<time>` 为备份时间）：

```bash
cd deploy/claudex-server
docker compose up -d --wait postgres redis
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < backups/claudex-db-<time>.dump
docker compose run --rm --no-deps -T --entrypoint tar claudex-server xzf - -C /app < backups/claudex-data-<time>.tgz
docker compose up -d
./check.sh
```

## 升级 / Upgrade

上游在线更新在分支里已关闭（控制台显示 “Online update is disabled”）。升级 = 合并上游后重建镜像：

1. 按 `backend/CLAUDEX_CHANGES.md` 的“同步上游”步骤合并新的上游提交（`git subtree pull --prefix=backend --squash ...`），逐条核对修改清单，跑 CI（`.github/workflows/backend.yml`）。
2. `deploy/claudex-server/build-image.sh`，把镜像推到自己的仓库或载入服务器。
3. 备份（上一节）。迁移只向前执行。
4. 改 `.env` 里的 `CLAUDEX_SERVER_IMAGE`，`docker compose up -d claudex-server`，看日志并运行 `check.sh`。
5. 用 `seed-claudex.sh --dry-run --live-reads` 确认种子请求仍与新版本的处理器字段一致。

回滚 = 用第 3 步的备份恢复，再换回旧镜像；不要在已迁移的数据库上启动旧镜像。

## 从 deploy/sub2api 迁移 / Coming from deploy/sub2api

`deploy/sub2api/` 以前运行上游官方镜像。现在它的 `docker-compose.yml` 引用本目录的 compose 文件，项目名仍是 `claudex-sub2api`，数据库、Redis 和数据卷沿用原来的卷。在那里升级到本分支：

1. 备份：`deploy/claudex-server/backup.sh -f deploy/sub2api/docker-compose.yml`。
2. 在 `deploy/sub2api/.env` 里把 `SUB2API_IMAGE` 改为 `CLAUDEX_SERVER_IMAGE=<构建好的镜像>`（`SUB2API_PORT` 改名为 `CLAUDEX_SERVER_PORT`），并加上 `JWT_ACCESS_TOKEN_EXPIRE_MINUTES=60`（不写也默认 60）。
3. `cd deploy/sub2api && docker compose up -d --remove-orphans`：服务名从 `sub2api` 改成了 `claudex-server`，`--remove-orphans` 删除旧容器。

也可以用备份与恢复把数据搬到本目录的新项目。

## 验证记录 / Verification record (2026-09-26)

在 macOS + Docker Desktop（29.5.2，8 CPU / 7.75 GiB）上：

- `build-image.sh` 冷缓存构建成功，约 7 分钟：pnpm 安装 32 秒、控制台构建 102 秒、`go mod download` 100 秒、Go 编译 106 秒；镜像 `claudex-server:0.2.8-claudex.6`，176 MB。检查了用户 `1000:1000`、OCI 标签、`/app/SOURCE.txt`（dirty 构建带“不得分发”警告）、`--version`、`pg_dump 18.6`，以及入口脚本：`*_FILE` 读取、同时给值和文件、文件不可读、`change-me` 占位符都按预期处理，以 root 启动时降为 `sub2api`。
- `docker compose -f deploy/claudex-server/docker-compose.dev.yml up -d --build` 后三个容器 healthy；`check.sh --dev`：`/health` 200、公开设置 200、`/api/v1/claudex/release` 200（`source`）、未登录 `/api/v1/claudex/capabilities` 401、管理员登录 200、合规状态 `required=true`、`/api/v1/admin/claudex/overview` **423**。`/api/v1/admin/claudex/policy` 在本次构建返回 404（策略功能由 B2 包实现，合并后应为 423），`check.sh` 把它记为提示。
- `backup.sh`：转储与归档成功，权限 600，`--keep` 按份数删除旧文件；服务端停止时改用 `docker compose run` 归档。按上面的恢复命令把备份恢复到一个新项目后，服务端 healthy，原管理员密码可以登录。
- `nginx -t`（nginx:alpine）通过；把示例配置接到开发环境：带查询串和 Referer 的请求在访问日志里只剩路径，`session_id` 请求头可以通过；一个每 1.5 秒发一条事件的 SSE 源经 nginx 后按 1.5 秒间隔逐条到达（没有被缓冲）。
- 生产 compose：用随机密钥生成的 `.env`（另一个项目名与端口）启动，三个容器 healthy，服务端以 uid 1000 运行；`check.sh` 同上全部通过；管理员登录返回 `expires_in=3600`（60 分钟）。把 `JWT_SECRET` 改回 `change-me` 占位符后容器以退出码 64 拒绝启动。
- `docker compose config`：生产文件在缺少 `.env` 时报出缺失的变量；`deploy/sub2api/docker-compose.yml` 解析为项目 `claudex-sub2api` 和原来的卷名。
- 复核（版本号改为 build 元数据之后）：从干净提交重建，`--version` 与 `SOURCE.txt` 为 `0.2.8+claudex.6`，镜像标签 `claudex-server:0.2.8-claudex.6`；开发环境的 `/api/v1/claudex/release` 返回 `0.2.8+claudex.0`，`check.sh --dev` 全部通过并显示 `access token expires_in=3600s`，令牌 `exp - iat` = 3600；`/api/v1/admin/users`、`/api/v1/admin/settings` 返回 423。
- 没有在真实域名和证书上部署。
