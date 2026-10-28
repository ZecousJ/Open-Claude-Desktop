# Claudex seed and earlier deployment folder / Claudex 初始化与旧部署目录

Claudex 服务端是本仓库 `backend/` 中的 Sub2API 分支（保留 Sub2API 全部原有功能，加上 Claudex 扩展，修改清单见 [`backend/CLAUDEX_CHANGES.md`](../../backend/CLAUDEX_CHANGES.md)）。**构建、部署、TLS、备份和升级见 [`deploy/claudex-server/`](../claudex-server/README.md)。** 本目录保留：

| 文件 | 用途 |
|---|---|
| `seed-claudex.sh`、`seed.env.example` | 创建 Claudex 的分组、上游账号、定价、公开设置和测试用户；`--claudex-provisioning` 另把订阅分组设为桌面设备供应的默认分组 |
| `docker-compose.yml`、`.env.example` | 兼容旧部署：引用 `../claudex-server/docker-compose.yml`，沿用本目录的项目名 `claudex-sub2api` 与原有数据卷（见 [迁移说明](../claudex-server/README.md#从-deploysub2api-迁移--coming-from-deploysub2api)）；`.env.example` 与新目录的同名文件相同 |
| `build-from-source.sh`、`run-from-source.sh` | 不用 Docker 时：用本机工具链从 `backend/` 构建并运行服务端 |
| `check.sh` | 调用 `../claudex-server/check.sh` 的只读检查（保留旧路径） |

`nginx.conf.example` 已移到 `deploy/claudex-server/`。

## Compliance commitment / 合规承诺（必须由所有者本人完成）

分支原样保留 Sub2API 的管理员合规闸门：在管理员接受《Sub2API 部署与运营合规承诺》（v2026.06.10，`backend/docs/legal/admin-compliance.en.md` / `.zh.md`）之前，控制台和所有 `/api/v1/admin/*` 请求（包括管理员 API Key 发出的，以及 Claudex 的 `/api/v1/admin/claudex/*`）都返回 **423 `ADMIN_COMPLIANCE_ACK_REQUIRED`**。接受承诺是一项电子协议，记录管理员账号、时间、IP 和 User-Agent；它约定运营者遵守上游服务条款、不绕过上游限制、未取得相应授权和备案时不向公众转售或转发模型服务，等等。

**只有项目所有者本人能在控制台里接受这项承诺。** 本仓库的任何脚本都不会接受它、输入确认短语、把承诺写入数据库或修改服务端绕过它。`seed-claudex.sh` 第一步读取 `GET /api/v1/admin/compliance`，承诺未接受时以退出码 3 停止，不写入任何数据。只接入你有权通过 API Key 使用的上游，不要接入消费级订阅或 Claude 账号。

Sub2API 的 README 还声明其开发者未授权任何商业化运营；对外提供服务前请先阅读（`backend/README.md`）。

## Seed Claudex / 初始化 Claudex 配置

所有者接受承诺并生成管理员 API Key（控制台 → 系统设置 → Admin API Key）之后：

```bash
cp deploy/sub2api/seed.env.example deploy/sub2api/seed.env && chmod 600 deploy/sub2api/seed.env
# 填写 SUB2API_URL（Claudex 服务端地址）、SUB2API_ADMIN_API_KEY、上游地址与 Key、模型、价格、限额
npm ci                                                        # 在 Claudex 仓库里执行一次
deploy/sub2api/seed-claudex.sh --env deploy/sub2api/seed.env --dry-run   # 只打印请求，不发送
deploy/sub2api/seed-claudex.sh --env deploy/sub2api/seed.env --dry-run --live-reads
deploy/sub2api/seed-claudex.sh --env deploy/sub2api/seed.env --claudex-provisioning
```

它创建（已存在时只更新有差异的字段）：`standard`（余额计费）分组和带日/周/月美元限额的 `subscription` 订阅分组，两者都带模型白名单；绑定到这两个分组的 `apikey` 上游账号；按 token 定价的渠道；公开设置 `site_name`、注册策略和可选的邮箱验证；可选的测试用户及其订阅。再次运行不做任何修改，密钥从不打印。`--live-reads` 只能与 `--dry-run` 一起用。

`--claudex-provisioning`：在任何写入之前读取 `GET /api/v1/admin/claudex/provisioning`（服务端没有这个接口时直接停止、不做修改），最后把订阅分组设为 `default_group_id`（`allowed_group_ids` 非空且不含它时追加），整份设置原样写回，其他字段保持不变。开启了 step-up 双因素验证时，管理员 API Key 不能修改这项设置，脚本会提示改在控制台设置默认分组。

以后的运行只改输入描述的内容：控制台里给账号设置的其他非密钥凭证字段原样回写；渠道里其他模型的定价保留（一个分组只能属于一个渠道）；从 `seed.env` 删掉的套餐限额或缓存价格会被清成“不限”/“未设置”。每次写入带本次运行唯一的 `Idempotency-Key`，服务端 24 小时的重放缓存不会返回之后已删除的实体。

管理员 API Key 以**首个**管理员（`ADMIN_EMAIL` 创建的账号）的身份执行，而承诺按管理员账号记录，所以请用这个账号登录控制台接受承诺。请求体按 `scripts/sub2api-admin.ts` 中引用的分支处理器结构体（`backend/backend/internal/...`）校验，测试会检查这些引用的文件和符号仍然存在。

## From source / 源码构建（不用 Docker 时）

```bash
deploy/sub2api/build-from-source.sh                  # 从本仓库 backend/ 构建，输出到 work/claudex-server
cp deploy/sub2api/.env.example deploy/sub2api/.env    # 与 Compose 用同一个文件
# 数据库和 Redis 不在 127.0.0.1:5432 / :6379 时加 DATABASE_HOST/DATABASE_PORT、REDIS_HOST/REDIS_PORT
deploy/sub2api/run-from-source.sh                    # 前台运行
```

`build-from-source.sh` 与 `deploy/claudex-server/Dockerfile` 步骤相同：在 `backend/frontend` 执行 `pnpm install --frozen-lockfile && pnpm run build`（产物内嵌），再以 `-tags embed` 编译 `backend/backend/cmd/server`，版本号 `<VERSION>+claudex.<N>`（与镜像相同）。输出目录里有二进制、`resources/`（定价回退数据）、`LICENSE`、`CLAUDEX_CHANGES.md` 和 `SOURCE.txt`（仓库、提交号与源码获取方式；有未提交改动时写明不得分发）。需要本机 Node.js 24 + pnpm 9 与 Go；没有时用镜像或 `scripts/backend/build.sh`（在 Docker 中构建）。PostgreSQL 15+ 和 Redis 7+ 由主机提供。`run-from-source.sh` 与镜像一样把登录令牌有效期设为 60 分钟，密钥可以用 `<名称>_FILE` 从文件读取。作为服务运行时可参考 `backend/deploy/sub2api.service`：

```ini
[Service]
User=sub2api
ExecStart=/opt/claudex/deploy/sub2api/run-from-source.sh --env /etc/claudex/claudex-server.env --bin /opt/claudex-server
Restart=always
RestartSec=5
```

## Verification record / 验证记录

- 2026-09-26：`tests/sub2api-seed.test.ts`（14 项）通过，覆盖承诺未接受时零写入（含 `--claudex-provisioning`）、无供应接口时写入前停止、step-up 提示、整份设置回写与二次运行不写入，以及引用的分支源码文件与符号存在。`docker compose config` 把本目录的 compose 解析为项目 `claudex-sub2api`、原有卷名 `claudex-sub2api_{sub2api_data,postgres_data,redis_data}`；缺少 `.env` 时报出缺失的变量。`check.sh` 转调新脚本正常。`build-from-source.sh`、`run-from-source.sh` 通过 `bash -n` 与 shellcheck，未在装有 Go/pnpm 的主机上实际运行（本机没有这两个工具链；同样的构建步骤已由镜像构建验证）。镜像、开发与生产 compose、备份恢复和 nginx 的验证见 `deploy/claudex-server/README.md`。
- 2026-09-25 的记录针对当时的上游官方镜像 `weishaw/sub2api:0.2.8`：`seed-claudex.sh` 在承诺未接受时以退出码 3 停止；研究实例的 `/api/v1/admin/groups/all` 返回 423。
