# 完整版自托管

完整版由桌面客户端、Claudex 服务端和 Linux Runner 组成。服务端是本仓库 `backend/` 中的 Sub2API 分支，负责账户、策略、设备密钥、模型目录和 Runner 调度。Runner 连接服务端执行云端任务。用户桌面端向自托管域名登录。

```text
桌面客户端 / 可选 Web 界面
        │ HTTPS
   Claudex 服务端（Sub2API 分支） ─── 模型上游 API
        │ Runner 链路
   Linux Runner ─── Codex 执行引擎
```

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

按 [Nginx 示例](../deploy/claudex-server/nginx.conf.example) 公开 HTTPS 服务，保留 SSE 和 WebSocket 转发。PostgreSQL 和 Redis 使用内部网络。首次启动后，用管理员账户进入服务端控制台，由部署所有者查阅并接受 Sub2API 的运营承诺。

## 2. 在 Sub2API 控制台配置模型

1. 创建 OpenAI 平台分组，使用差价、计费、并发和限额满足你的部署需要。
2. 新增上游账户，类型选 **API Key**。填写授权使用的请求地址和密钥，关联该分组。已有的独立 Sub2API 也可作为 OpenAI 兼容上游，使用它发放的普通调用密钥，不填写管理员密钥。
3. 配置模型白名单、映射和渠道定价。目录中的模型 ID、默认推理强度和可选档位应与实际网关和上游一致。
4. 在 Claudex 配置中开启设备密钥供应，为新设备指定可用分组。给使用者创建或邀请账户，并分配对应套餐或额度。
5. 在控制台测试上游连通性。再用普通用户登录，确认能领取设备密钥、看到正确模型并产生一条调用记录。

需要以脚本初始化时可参考 [Sub2API 配置脚本](../deploy/sub2api/README.md) 与 [参数示例](../deploy/sub2api/seed.env.example)。接入标准 Sub2API 时，账户管理和 Runner 连接使用本仓库的 Claudex 服务端接口；独立 Sub2API 仅承担上游模型网关角色。

## 3. 注册并运行 Linux Runner

在服务端管理台的 **Claudex → Web → Runners** 注册 Runner，复制注册令牌并保存为权限为 `0600` 的文件。Runner 主机需有 Node.js 24、Git 和 Linux 隔离运行时。生产多用户部署推荐使用 gVisor，可参考 [Runner 沙箱镜像](../deploy/claudex-runner/image/README.md)；单机也支持 bubblewrap。

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

确保运行 Runner 的系统用户能读取令牌文件、写入状态目录并启动配置的沙箱。常驻部署使用 systemd，把环境变量写进受限的 `EnvironmentFile`，设置 `WorkingDirectory` 为仓库所在路径，`ExecStart` 使用上述 Node 命令的绝对路径。管理台的 Runner 详情应显示已连接和启用的模式。

## 4. 自行构建客户端

从仓库根目录指定自己的服务端地址。客户端登录后由服务端发现和分配 Runner。Runner 的令牌只留在 Runner，用户客户端不需要它。

```bash
npm ci
export CLAUDEX_SUB2API_URL=https://claudex.example.com
export CLAUDEX_MAC_SIGNING_IDENTITY="your signing identity"
npm run package:full -- darwin arm64
```

在 Windows 上额外安装 Go。Windows PowerShell 用 `$env:CLAUDEX_SUB2API_URL = "https://claudex.example.com"` 设置服务地址，再运行 `npm run package:full -- win32 x64`。Linux 使用 `npm run package:full -- linux x64`。构建产物位于 `release/full/`。

有 Web 客户端需求时，运行 `npm run build:web`。把 `dist-web/` 作为单页应用发布，并将同一站点的 API、SSE 和 WebSocket 路径转发给 Claudex 服务端。保持 Web 登录 Cookie 的来源与用户访问域名一致，反向代理继续按服务端示例传递原始主机名和协议。管理控制台可通过单独的管理员域名访问服务端。

## 5. 验收和运维

- 从普通用户桌面客户端登录，核对设备、模型目录和默认模型。
- 各发一条本地和云端消息。查看 Runner 状态、服务端用量记录，以及退出重开后会话能否恢复。
- 对云端 Code 用自己的测试 Git 仓库验证工作目录、Shell 和文件保存。上线前为需要使用的云端环境和仓库按部署策略配置最小访问权限。
- 使用 [备份与恢复步骤](../deploy/claudex-server/README.md#备份与恢复--backup-and-restore) 持久化服务端数据库和数据卷，单独保留 Runner 状态目录。轮换 Runner 令牌时，在更换令牌文件后重启 Runner。
