# Claudex backend (Sub2API fork) / Claudex 服务端（Sub2API 分支）

`backend/` holds the Claudex server: a fork of [Sub2API](https://github.com/Wei-Shaw/sub2api) at
commit `a3eb7ef302961cba716dc78b39b93b60c467db0e`, imported with `git subtree --squash` and kept
in the upstream layout. It is licensed under **LGPL-3.0** (`LICENSE`, unchanged from upstream);
the rest of the Claudex repository is Apache-2.0. Every change to the upstream code is listed in
[`CLAUDEX_CHANGES.md`](CLAUDEX_CHANGES.md).

`backend/` 是 Claudex 的服务端：Sub2API 在 `a3eb7ef` 的分支，用 `git subtree --squash` 导入并保持
上游目录结构（`backend/backend` Go、`backend/frontend` Vue、`backend/docs/legal` 等）。本目录按
LGPL-3.0 发布，仓库其余部分仍为 Apache-2.0。对上游的全部修改见 `CLAUDEX_CHANGES.md`。

## 角色

- Sub2API 的全部原有功能保留；网页控制台给管理员用，终端用户使用 Claudex 桌面端。
- 管理员合规承诺闸门原样保留，Claudex 的管理接口都在闸门之后。
- 上游在线更新（指向 Wei-Shaw/sub2api 的自我替换）已关闭：通过部署新的 Claudex 服务端版本更新。

## 分组故障转移与总超时

普通网关生成请求在可安全重试的失败后，继续选择同一分组内健康、满足模型、权限、额度、并发和利润约束的账号。
同一次请求里失败的账号不再尝试；不再受旧的固定换号次数、账号池同号重试次数或 503 清空排除集逻辑限制。
直到成功、当前合格候选耗尽、不可重试错误或客户端取消为止。

整条请求共用 **60 秒**，包括读取请求体、资格检查、选号、排队与上游转发，换号不会重新计时；客户端较短的期限优先。
到期返回普通 `request_timeout` / `timeout_error`（未提交响应时 HTTP 504）；已经开始的 SSE 使用原协议的终止错误帧。
Responses WebSocket 按每个生成 turn 计时，成功 turn 后停止计时，连接空闲不消耗下一轮预算。
已发送且不能确认安全重放的请求、已输出语义内容的流、不可重试的输入错误和客户端取消不会被自动换号重放；已发生的用量仍由独立计费收尾。

范围包括 Responses（HTTP / WebSocket）、Messages、Chat Completions、Gemini 原生生成、图片、Embeddings、Alpha Search、Grok 媒体与 HTTP 语音。
持续实时音频会话、模型目录与异步任务的服务端生命周期保持原有语义；60 秒不会作为持续连接的总存活时间。

## 构建、测试与本地运行

本机不需要 Go、Node 或 pnpm：全部在 Docker 里（`golang:1.27.0-alpine`；`node:24-alpine` + pnpm 9）。
脚本在仓库根目录的 `scripts/backend/`，输出和日志在 `work/backend/`（已被 gitignore）。

```bash
scripts/backend/go.sh download build              # 下载模块（唯一需要网络的 Go 步骤）并编译
scripts/backend/go.sh vet ./internal/claudex/... test ./internal/claudex/...
scripts/backend/go.sh test                        # go test -tags=unit ./...（全部）
scripts/backend/go.sh wire                        # 改了 Wire 依赖后重新生成 cmd/server/wire_gen.go
scripts/backend/go.sh wire-check lint             # wire_gen.go 最新且 go.mod/go.sum 未变；golangci-lint v2.13
scripts/backend/go.sh test-integration            # testcontainers（PostgreSQL、Redis）集成测试
scripts/backend/fe.sh install typecheck i18n test # 前端依赖、类型检查、中英文案键检查、vitest
scripts/backend/build.sh                          # 前端构建 + 内嵌前端的服务端二进制 work/backend/out/sub2api
scripts/backend/dev-stack.sh up                   # postgres:18 + redis:8 + 模拟 OpenAI 上游 + 本分支（容器名按检出区分）
scripts/backend/dev-stack.sh smoke                # 只读冒烟检查
scripts/backend/dev-stack.sh down [-v]
```

网络不稳定时：Go 模块和 pnpm 下载有重试，缓存放在 Docker 卷里可续传；镜像拉取失败时
`scripts/backend/fetch-image.sh` 用可续传的 curl 下载镜像层再 `docker load`。

多个工作树可以同时跑：构建容器名带每个检出自己的后缀，前端 `node_modules` 卷也按检出区分（pnpm 仓库卷共用）；
dev stack 的容器、数据卷与网络名也按检出区分（`DEV_NAME` 可覆盖），同时跑两套时给第二套换端口：
`DEV_PORT=18081 DEV_MOCK_PORT=18091 scripts/backend/dev-stack.sh up`。
本机 Docker 内存有限，service 包与全量测试加 `GO_PARALLEL=1`。

## Claudex 扩展点

### Go：`backend/backend/internal/claudex`

- `core/`：冻结的契约（`Deps`、`Env`、`Peers`、组件接口、`JSONSetting`、HTTP/版本/限流工具、共享错误）。
- `hook/`（`claudexhook`）与 `gatewayhook/`：上游挂钩的注册表（H5–H14，见 `CLAUDEX_CHANGES.md`）。
- 组件：每个 B 包一个目录（`webconsole release policy catalog devices usage refusal voice feedback bootstrap payment`，
  第二轮加 `memory sharing websearchguard`，B-S 建桩），
  导出 `func New(env *core.Env) *Component`；`module.go` 的 `ProvideModule` 按固定顺序全部安装，**组件包不改模块**。
- 组件实现 `core.Feature`（`Name()`），再按需实现可选接口，模块用类型断言自动接上：
  - `PageRouter`（第二轮）：根路径 `/s` 下的公开 HTML 页面（R1 托管分享 `/s/<token>`），只按 IP 限流，不挂 JWT、审计与
    `X-Claudex-*` 头校验，内嵌控制台不接管 `/s/`；处理器自己设置 CSP、`X-Frame-Options` 等安全头；
  - `PublicRouter` / `UserRouter` / `AdminRouter(g, stepUp)`：`/api/v1/claudex/*`（公开：按 IP 限流；用户：JWT 含会话吊销检查、
    后端模式守卫、面板限流、`X-Claudex-*` 头校验、审计）与 `/api/v1/admin/claudex/*`（adminAuth、限流、审计、合规闸门，
    高风险写操作挂 `stepUp`）；
  - `SignupHooker`、`SettingsOwner`、`Starter`、`BootstrapContributor`（区块归属见 `core.SectionOwners`）；
  - 同伴接口 `core.PlanResolver`、`DeviceDirectory`、`SessionGuard`（B4）与 `ReleaseInfo`（B1），各恰好一个实现；
  - 上游挂钩：`core.UsageObserver`（H8）、`SessionRevoker`（H9）、`ManagedKeyOwner`（H13）、`TurnPrechecker`（H14）、
    `APIKeyCreateGate`（决策 17）；网关：`gatewayhook.KeyMarker`（H5）、`RequestGuard`（H5b，优先级：设备 10、版本 20、
    用量规则 30、网页搜索 40）、`RefusalDescriber`（H6）。
- 加密：需要落库的密文（上游 API Key、记忆正文）用 `core.SecretBox`（AES-256-GCM，服务端固定的 `TOTP_ENCRYPTION_KEY`）；
  没有固定密钥时 `Seal` 返回 `core.ErrSecretKeyMissing`，组件映射成自己的错误码，绝不改存明文。
- 请求体不进审计日志的用户接口列在 `routes.go` 的 `privateBodyRoutes`（诊断、反馈、结账链接、分享快照、记忆正文）。
- 需要新的上游服务或契约变更时交给 B0 负责人串行修改 `core`、`module.go`、`routes.go`、`hook`、`gatewayhook` 与 Wire。
- 设置：每个组件一个 JSON 键（前缀 `claudex_`），用 `core.NewJSONSetting`，读缓存 60 秒，写入后本节点立即生效，
  其他节点最迟 60 秒；需要乐观并发时用 `GetRaw` + `SwapIfUnchanged`。默认值里不要预填 map（或元素为结构体/map 的切片）：
  JSON 会解码进已有的 map，存储值删不掉默认键；这类默认值留 nil，在 `WithNormalize` 里仍为 nil 时再填。
- 内置接口：`GET /api/v1/claudex/release`（公开；服务端信息 + B1 的客户端发布信息）、`GET /api/v1/claudex/capabilities`
  （用户）、`GET /api/v1/admin/claudex/overview`（管理员）。
- 组件的最小写法：`internal/claudex/<name>/component.go`（B0 建的桩），测试写法参考 `internal/claudex/module_test.go`。
- 上游 `backend/.gitignore` 会忽略任何名为 `release/`、`build/`、`dist/` 的目录、名为 `scripts` 的文件或目录和 `docs/*`：`internal/claudex/.gitignore`
  已重新纳入 `release/`；在其他被忽略的位置新增文件要先确认 `git status` 能看到它（或 `git check-ignore -v <file>`）。

### 数据库迁移

放在 `backend/backend/migrations/`，命名 `claudex_NNNN_description.sql`（四位编号，可带 `_notx`）。
运行器按文件名排序执行，上游迁移都以数字开头，所以同一版本里 Claudex 迁移总在上游迁移之后；
`migrations/claudex_migrations_test.go` 检查命名、编号唯一、排序、编号落在分配给各包的段内（B3 0010–0019、
B4 0020–0029、B5 0030–0039、B8 0040–0049、B7 0050–0059、R1 分享 0060–0069、R3 记忆 0070–0079；0080–0099 保留）、`CREATE … IF NOT EXISTS`、不改也不写上游表。
迁移须幂等、只向前、已发布后不改。

### 前端：`backend/frontend/src`

- 路由组 `/admin/claudex/*` 在 `router/claudex.ts`（`claudexAdminRoutes`），侧栏 Claudex 分组的子项来自
  同文件的 `CLAUDEX_ADMIN_NAV`；页面放在 `views/admin/claudex/`（概览 + 8 个页面：policy、models、devices、
  usage-rules、release、voice、feedback、general，均已实现；服务端没有对应组件（接口 404）时页面显示“此版本尚未提供”）。
  第二轮加 sharing（R1）与 memory（R3，`views/admin/claudex/memory/`），B-S 建的桩页如实显示“此版本尚未提供”，由功能包替换。
  公开分享页 `/s/<token>` 由 Go 渲染，不是 Vue 路由；不得新增 `/s/` 开头的前端路由。
  部署与各页的用途见仓库根目录的 `docs/self-hosting.md`。
- 接口：每个区域一个文件 `api/admin/claudex/<area>.ts`，由 `api/admin/claudex.ts` 聚合为 `adminAPI.claudex.<area>`。
- 公共件在 `components/admin/claudex/common/`：`ClaudexPageShell`（页面框架）、`SaveBar` + `useClaudexSave`
  （保存状态，`CLAUDEX_*` 错误映射到 `admin.<page>.errors.<REASON>`）、`UrlInput`（只收 https）、`TagInput`、
  `ClaudexUnavailable`。
- 文案：`admin.claudex.*`（导航与公共文案）与每页一个模块 `admin.claudex<Page>.*`
  （`i18n/locales/{en,zh}/admin/claudex*.ts`），`pnpm run check:i18n` 校验中英文键一致。
- 网页控制台仅限管理员（公开设置 web_console_admin_only，`GET /api/v1/claudex/web-console`，默认开启、读不到按开启）：
  规则在 `router/webConsole.ts`，状态在 `stores/webConsole.ts`；非管理员只能打开登录、初始化、法律条款、
  找回/重置密码、第三方登录回调、支付结果（`/payment/result`）与桌面结账页 `/desktop-pay`（B10），
  其余去 `/desktop-only`（已登录）或 `/login`。上游 `/payment/stripe`、`/payment/airwallex`、`/payment/stripe-popup`
  需要网页登录态（且 `client_secret` 在 URL 中），不对非管理员开放。只收口前端路由，JSON API 不受影响。

### 网页版（W-*）

网页版（类 claude.ai，挂在主域名根路径，控制台只挂 `/admin`）的整体说明见仓库根目录的 `docs/architecture.md`。按 origin/main
`5b0e0544`，服务端只合并了协议契约：

- `internal/claudex/webproto/`（W-PROTO）：浏览器 ⇄ Go 的 RPC 信封、事件帧、一次性票据，Go ⇄ runner 的 runner link 帧，
  webstore 的存储文档 schema 1。只用标准库，不是组件（不在 `module.go` 里安装）。它与桌面端 `shared/web-protocol.ts`
  共用 `webproto/testdata/*.json`：改协议时两边的实现与 `constants.json` 要在同一提交里一起改，两边测试都读这些样例。
  按设计，Go 转发（W-RELAY，尚未合并）只放行 runner 在 hello 帧里声明的方法，所以网页方法表（`shared/web-bridge-methods.ts`）
  不需要在 Go 里再维护一份。
- 计划中的组件（尚未合并，以合并后的代码为准）：`claudex/web`（网页会话、`__Secure-claudex_web_rt` Cookie、票据、
  `claudex_web` 设置，W-AUTH）、`claudex/webstore`（W-STORE）、`claudex/webhost`（RPC 与事件转发、runner link，W-RELAY）、
  `claudex/cloud`（W-CLOUD）、`claudex/github`（W-GITHUB）；站点分发在上游 `internal/web/`（W-SITE）。
  网页 JSON 接口放在 `/api/v1/claudex/web/*`；网页用户的模型请求用每用户一把 `platform='web'` 的受管 Key，
  照常经过网关守卫与计费，不计入 5 台桌面设备上限。
- 迁移编号：W-SITE 合并时把分配表扩到 0080 网页会话、0081 webstore、0082 网页用量、0090 runners、0091 云端，0100–0199 保留；
  在此之前 0080–0099 仍为保留段。

### 登录页选项与邮箱验证码登录（LOGIN，组件 `sign-in`，`internal/claudex/signin`）

Sub2API 没有“用邮箱验证码登录”；这里只用验证码代替密码，其余检查全部走上游（`core.WebAuthBackend.CodeLogin`，
实现于 `internal/handler/claudex_webauth.go`，与密码登录共用 `loginAfterFirstFactor`：用户状态、Backend 模式只放行管理员、
TOTP 挑战、记录登录）。响应信封均为上游 `{code, message, reason?, metadata?, data}`。

- 设置 `claudex_sign_in`：`{"email_code_login_enabled": false, "privacy_policy_url": ""}`；`privacy_policy_url` 为空、
  `https://` 地址或以 `/` 开头的本站路径（不接受 `//`、反斜杠、空白；≤ 2000 字符）。
- `GET|PUT /api/v1/admin/claudex/sign-in`（合规闸门之后；PUT 需 step-up，未给出的字段保持原值，未知字段/类型错误/链接无效
  → 400 `CLAUDEX_SIGN_IN_INVALID`，metadata `field`、`rule`）。回答：设置 + `smtp_configured`、`backend_mode_enabled`、
  `email_code_login_available`。
- `GET /api/v1/claudex/sign-in/options`（公开，`Cache-Control: public, max-age=5`，本节点缓存 5 秒）→
  `{"email_code_login": bool, "privacy_policy_url": string|null}`；`email_code_login` 仅当开关开启、SMTP 已配置（有 host）
  且 Backend 模式关闭时为 true。
- `POST /api/v1/claudex/auth/email-code/send` `{email}` → `{"countdown": 60}`。每 IP 5 次/分钟（Redis，失败即拒绝，429），
  同一地址 60 秒冷却、每小时最多 10 次（地址是否有账户都计数，429 `CLAUDEX_EMAIL_CODE_TOO_FREQUENT` + `Retry-After` +
  metadata `retry_after_seconds`）。有无账户回答相同，只给存在且启用的账户异步发信（英文，标题“Your <站点名> sign-in code”，
  正文含验证码与“It expires in 10 minutes.”）。6 位验证码来自 crypto/rand，Redis 中只存 HMAC-SHA256（密钥由 JWT secret 派生，
  键名也是地址的 HMAC），有效 10 分钟，新发送覆盖旧码。功能不可用 → 403 `CLAUDEX_EMAIL_CODE_DISABLED`；地址格式不对 → 400
  `CLAUDEX_EMAIL_CODE_BAD_REQUEST`；Redis 不可用 → 503 `CLAUDEX_EMAIL_CODE_UNAVAILABLE`。
- `POST /api/v1/claudex/auth/email-code/login` `{email, code}` → 与上游 `POST /api/v1/auth/login` 完全相同的 data
  （`access_token`、`refresh_token`、`expires_in`、`token_type`、`user`），或 TOTP 挑战 `{requires_2fa, temp_token, user_email_masked}`
  （随后走上游 `/api/v1/auth/login/2fa`）。每 IP 20 次/分钟（失败即拒绝）；一次性（成功即删除）；每个码最多 5 次错误尝试，
  第 5 次错误后作废；常量时间比较。错码/过期 → 400 `CLAUDEX_EMAIL_CODE_INVALID`（“That code is incorrect or has expired.”）；
  开关关闭 → 403 `CLAUDEX_EMAIL_CODE_DISABLED`（已发出的码在 SMTP 或 Backend 模式变化后仍可用，Backend 模式由上游检查只放行管理员，
  403 `BACKEND_MODE_ADMIN_ONLY`）；停用账户 → 上游 403 `USER_NOT_ACTIVE`。
- 网页版（Cookie 会话）：`POST /api/v1/claudex/web/auth/email-code/send`、`.../email-code/login`（`webproto.AuthEmailCodeSend`、
  `AuthEmailCodeLogin`；与 login 相同的 CSRF/开关/每 IP 限流 5 与 20；send 在 Backend 模式下与 send-code 一样被拦截；login
  成功时像 web login 一样开网页会话，2FA 挑战原样返回，由 `web/auth/2fa` 完成）。网页组件通过 `core.FindEmailCodeSignIn`
  找到 signin 组件，不互相导入。
- 控制台：Claudex → General 页的 Sign-in 卡片（`components/admin/claudex/general/SignInSettingsCard.vue`，
  `api/admin/claudex/signIn.ts`）。
