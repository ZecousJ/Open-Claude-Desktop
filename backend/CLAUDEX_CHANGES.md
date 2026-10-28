# Claudex changes to Sub2API / Claudex 对 Sub2API 的修改清单

This directory is a **modified version of Sub2API** (<https://github.com/Wei-Shaw/sub2api>, commit
`a3eb7ef302961cba716dc78b39b93b60c467db0e`), distributed under the GNU Lesser General Public
License v3.0 like the original (see `LICENSE`). This file lists every change Claudex made to it;
the git history of this repository has the full diffs and the date of each change.
Modified by the Claudex project since 2026-09-26.

本目录是修改版 Sub2API，上游提交 `a3eb7ef`，按 LGPL-3.0 发布（保留上游 `LICENSE`）。本文件列出
Claudex 对上游代码的全部修改，完整差异及每项修改的日期见本仓库 git 历史（`git log -- backend/`）。
Claudex 自 2026-09-26 起修改本目录。

## 2026-09-30：分组遍历与单一请求预算

- `internal/pkg/requestbudget/`：60 秒共享 deadline，保留调用方更短的期限；上游断连后的有限用量 drain 与独立计费 cleanup 分离；WebSocket 成功 turn 后停表，空闲后新 turn 重新计时。
- `internal/handler/group_failover_budget.go`：HTTP 读 deadline、并发安全的超时响应封装；服务层自行返回的错误也在预算到期时统一为 504，SSE 只写一次协议正确的终止帧。
- `internal/handler/failover_loop.go` 与普通网关入口：只遍历未失败的合格账号，保留分组/模型/配额/并发/利润筛选和原有不可重放保护；取消固定次数截断、同号重试和清空排除集。旧的非生成入口不改变策略。
- `internal/service/group_request_budget.go`、Anthropic / Gemini / Antigravity / OpenAI 转发适配器：有共享预算时把可重试故障交回换号循环，不在同一失败账号内重放；原有错误分类、RequestSent 与流输出保护保留。
- `internal/service/gateway_usage_billing.go`、`openai_ws_forwarder*` / `openai_ws_v2_passthrough_adapter.go`：保留预算穿过 detach 和 WebSocket turn 生命周期；计费收尾仍用原先独立窗口。
- 回归测试：超过 10 个候选、后续账号成功、候选耗尽、不重复账号、共享 60 秒、较短期限、取消、慢请求体、各 SSE 协议、RequestSent、不重复计费收尾、真实 WebSocket 空闲超过 60 秒后继续第二轮。

## 约定

- 上游文件里的每处改动都带 `CLAUDEX:` 标记（Go：`// CLAUDEX:`；TS：`// CLAUDEX`；Vue 模板：
  `<!-- CLAUDEX: ... -->`；挂钩写作 `// CLAUDEX: Hn …`，编号见下表与设计文档 1.2），改动尽量只是一行调用，
  逻辑放进 Claudex 自己的文件。
- Claudex 新增的文件放在上游目录结构里，文件头写 `CLAUDEX:`，或位于 Claudex 专属目录
  （`backend/internal/claudex/`、`frontend/src/views/admin/claudex/` 等）。
- 修改上游文件时同一提交里更新本清单。核对：`git grep -n CLAUDEX -- backend`。
- 同步上游：`git subtree pull --prefix=backend --squash https://github.com/Wei-Shaw/sub2api <ref>`，
  然后逐条核对本清单；`cmd/server/wire_gen.go` 冲突时以新上游为准再运行
  `scripts/backend/go.sh wire` 重新生成。

## 修改的上游文件

### Go（`backend/backend`）

挂钩编号 Hn 与设计文档 1.2 一致；上游文件里的标记写作 `// CLAUDEX: Hn …`。挂钩调用的目标都在 Claudex 自己的包里：
`internal/claudex/hook`（包名 `claudexhook`，只依赖标准库）与 `internal/claudex/gatewayhook`；没有安装 Claudex 模块时它们都是空操作，上游行为不变。

| 文件 | Hn | 改动 | 原因 |
|---|---|---|---|
| `cmd/server/wire.go` | H1 | `claudex.ProviderSet` | Wire 构造 Claudex 模块 |
| `cmd/server/wire_gen.go` | H1 | 生成代码：`claudex.Deps`（18 个字段）、`claudex.ProvideModule`、`ProvideHandlers(..., module)` | 由 wire v0.7.0 生成（`scripts/backend/go.sh wire`），不加标记 |
| `internal/handler/handler.go` | H2 | `Handlers.Claudex *claudex.Module` | 路由注册拿到 Claudex 模块（测试里为 nil 时不注册） |
| `internal/handler/wire.go` | H2 | `ProvideHandlers` 末尾参数 `claudexModule` | 同上 |
| `internal/server/router.go` | H3 | `registerRoutes` 中 `h.Claudex.RegisterRoutes(...)` | 公开与 JWT 用户 `/api/v1/claudex/*` |
| `internal/server/routes/admin.go` | H4 | admin 组末尾 `h.Claudex.RegisterAdminRoutes(admin, gin.HandlerFunc(stepUpAuth))` | `/api/v1/admin/claudex/*` 位于 adminAuth、面板限流、审计、`AdminComplianceGuard` 之后；组件可给高风险写操作挂 step-up |
| `internal/server/middleware/api_key_auth.go` | H5、H5b | `SetOpsFallbackAPIKey` 之后 `gatewayhook.KeyResolved(c, apiKey)`；两处 `c.Next()` 之前 `if gatewayhook.KeyAuthorized(c, apiKey) { return }`；import | H5 标记 Claudex 设备 Key（永不中断）；H5b 在上游全部检查通过后运行 Claudex 守卫（已吊销设备、最低版本 426、用量规则 429），覆盖所有使用该中间件的路由族 |
| `internal/server/middleware/api_key_auth_google.go` | H5、H5b | 同上（Gemini 原生 `/v1beta`、`/antigravity/v1beta`） | 同上 |
| `internal/server/middleware/jwt_auth.go` | H9b | TokenVersion 检查之后 `abortIfClaudexSessionRevoked(c, claims)` | “登出所有设备”与设备吊销让旧 access token 在所有 JWT 接口立即失效（401 `CLAUDEX_SESSION_REVOKED`，查不到状态 503 `CLAUDEX_SESSION_CHECK_FAILED`）；可选 JWT 中间件委托给它，一并生效 |
| `internal/server/middleware/admin_auth.go` | H9b | `validateJWTForAdmin` 中同一检查 | 管理员 JWT 走独立路径，管理接口同样遵守吊销 |
| `internal/handler/auth_linuxdo_oauth.go` | H9b | `resolveOAuthBindTargetUserID` 校验 TokenVersion 之后 `claudexAccessTokenEnded(...)` | OAuth“绑定当前用户”从 `oauth_bind_access_token` Cookie 读 access token（公开的 OAuth 起始接口，不经 JWT 中间件）；已登出的 token 不能再给账户绑定新的登录方式 |
| `internal/server/routes/gateway.go` | H6 | `/v1` 组 `endpointNorm` 之后、`apiKeyAuth` 之前 `gateway.Use(gatewayhook.EnrichRefusals(), gatewayhook.BodyLimits())`；新增 `GET /v1/audio/realtime/transcriptions`（B7 按业主决策 18/19 把原 `POST /v1/audio/transcriptions`、`POST /v1/audio/speech` 换成这一条）；import | 设备 Key 请求的结构化拒绝（`claudex` 字段）；请求体在认证前限长（已注册路径）；听写实时转写中转（B7） |
| `internal/server/routes/prompt_audit_route_coverage_test.go` | H6 | B0 曾登记 `/audio/speech`、`/audio/transcriptions`；B7 去掉朗读与 POST 转写后删除这两行，文件恢复上游原样（新路由是 GET WebSocket，不在该测试范围） | 上游测试要求每个网关 POST 路由都归类 |
| `internal/service/gateway_usage_billing.go` | H8、H8b | `applyUsageBilling` 成功扣费后（含 legacy 回退路径）`claudexhook.UsageApplied(...)`；`isForcedUsageBillingRequestID` 加 `claudex_audio:` 前缀；import | 用量规则（B5）按实际扣费累计；B7 的稳定请求 id 不被改写 |
| `internal/handler/auth_handler.go` | H9 | `RevokeAllSessions` 吊销 refresh token 之后调用 `claudexhook.SessionsRevoked(..., "revoke_all")`，出错返回 500；import | “登出所有设备”同时停用全部设备 Key（绝不碰用户自建 Key，业主决策 13）；重置密码等其他路径不调用（业主决策 4） |
| `internal/handler/auth_handler.go` | H16 | `respondWithTokenPair` 与 `RefreshToken` 成功答出 token 对之前 `claudexTokensIssued(...)`；`Logout` 吊销 refresh token 之前 `claudexTokensReturned(...)` | 手机 App 走上游 bearer 登录，没有会话列表；Claudex 按会话家族记下 UA、IP、开始与最近使用时间（`claudex_native_sessions`），桌面端（`X-Claudex-Platform`）与网页版（`X-Claudex-Client`）不记；从不改变或中断应答 |
| `internal/handler/api_key_handler.go` | H13 | `Create` 开头 `claudexRefuseAPIKeyCreate`；`Update`/`Delete` 解析 id 后 `claudexRefuseManagedKey`；`List`/`GetByID` 写响应前掩码设备 Key | 设备 Key 只读且只显示掩码（业主决策 13、14）；用户自建 Key 默认关闭，管理员可开启（业主决策 17）；管理员接口不受影响 |
| `internal/handler/usage_handler.go` | H13 | `List`/`GetByID` 写响应前掩码用量记录里嵌入的设备 Key | 用量记录 DTO 含完整 Key，否则设备 Key 明文会从 `/api/v1/usage` 泄露 |
| `internal/handler/openai_gateway_handler.go` | H14 | `ResponsesWebSocket`：首帧白名单检查之后与后续 turn 的 `BeforeRequest` 中 `claudexPrecheckWSTurn(...)` | 用量规则对 WebSocket 每一轮生效（业主决策 8） |
| `internal/service/auth_service.go` | H7 | `AuthService.signupHooks` 字段；`assignSubscriptions` 开头 `defer s.runSignupHooks(ctx, userID)` | 注册钩子：所有注册路径在用户落库后（事务外）调用 `assignSubscriptions`，钩子在默认订阅之后运行，失败不影响注册 |
| `internal/service/update_service.go` | H10 | `UpdateService.selfUpdateDisabled` 字段；`UpdateInfo.UpdateDisabled`（`update_disabled`）；`CheckUpdate`、`PerformUpdate`、`Rollback`、`ListRollbackVersions`、`RollbackToVersion` 开头的关闭分支 | 关闭指向 Wei-Shaw/sub2api 的在线更新：装上游发行版会丢掉 Claudex 的修改 |
| `internal/service/wire.go` | H10 | `ProvideUpdateService` 调用 `.DisableSelfUpdate()` | 生产装配一律关闭在线更新；直接 `NewUpdateService` 的上游测试行为不变 |
| `.golangci.yml` | H11 | depguard 规则 `claudex-no-repository-handler`：`**/internal/claudex/**` 不得 import `internal/repository`、`internal/handler` | 依赖方向（设计 1.1） |
| `internal/server/router.go` | H15 | `registerRoutes` 中 `h.Claudex.RegisterRoutes(...)` 之后 `h.Claudex.RegisterPageRoutes(r, panelRateLimiter)`（第二轮 B-S） | 根路径 `/s` 下的公开页面（R1 托管分享 `/s/<token>`）：只按 IP 面板限流，不挂 JWT、审计与 `X-Claudex-*` 头校验；页面由实现 `core.PageRouter` 的组件注册 |
| `internal/web/embed_on.go` | H15 | `shouldBypassEmbeddedFrontend` 增加 `/s/` 前缀（第二轮 B-S） | 否则内嵌控制台会把 `/s/...` 当作 SPA 路由返回 index.html；Vue 路由没有 `/s/` 开头的路径（`router/claudex.ts` 注释写明不得新增） |
| `internal/web/embed_test.go` | H15 | 新增 `TestEmbeddedFrontendBypassesClaudexSharePages`（`embed` 构建标签） | `/s/` 放行、`/s`、`/settings` 等仍归 SPA |
| `internal/server/router.go` | W-SITE | `FrontendServer` 换成 `web.NewSiteServer(SiteOptions{Settings, WebApp: h.Claudex.WebApp(), AppDir: cfg.Claudex.Web.AppDir})`；设置更新回调同时清两个 index 缓存；import `errors` | 一个 SiteServer 分发控制台（`/admin`、根部公开页、旧路径 302）与网页版（其余路径） |
| `internal/server/middleware/security_headers.go`（+ `_test.go`） | W-SITE | `isAPIRoutePath` 之后网页版区域（`sitepaths.ZoneApp`）改用 `WebAppCSPPolicy`，加 COOP `same-origin`、`Permissions-Policy`、Trusted Types Report-Only；上游测试的 `/` 请求改为 `/admin/`，新增 `TestSecurityHeadersWebAppZone` | 网页版不加载第三方脚本，严格 CSP；控制台区域仍用配置的策略（验证码、支付域名） |
| `internal/config/config.go` | W-SITE | `Config.Claudex`（`claudex.web.app_dir`，默认空） | 网页版可从磁盘目录加载（也可用 `CLAUDEX_WEB_APP_DIR`），小主机换前端不必重编 Go |
| `cmd/server/main.go` | W-SITE | `runSetupServer` 用 `web.NewSiteServer(SiteOptions{SetupMode: true})` | 安装向导期间 `/` 跳 `/admin/setup`，不提供网页版 |
| `internal/web/embed_on.go`、`embed_off.go`、`embed_test.go`、`html_cache.go`、`static_cache.go` | W-SITE | 上游 `FrontendServer` 删除，分发移到新增的 `site.go`、`render.go`、`sitepaths/`；内嵌目录改为 `dist/admin`（控制台）与 `dist/app`（网页版）；`html_cache.go`、`static_cache.go` 去掉构建标签；`HasEmbeddedFrontend` 改查 `dist/admin/index.html`，新增 `HasEmbeddedWebApp`；`ServeEmbeddedFrontend` 保留给旧调用方 | 分发、注入与缓存测试不依赖 `embed` 标签即可运行；H15 的 `/s/` 放行移入 `sitepaths/reserved_paths.json` |
| `internal/server/middleware/audit_log.go` | B8 | `auditSensitiveReads` 增加 `GET /api/v1/admin/claudex/diagnostics/:id`、`GET /api/v1/admin/claudex/feedback/:id` | 管理员打开诊断报告或回复反馈（含对话摘录）时写一条不含正文的审计记录（设计 2.9）；上游审计中间件只记录名单内的 GET，`SetAuditAction` 对其他 GET 不起作用 |
| `internal/service/auth_service.go` | ZMIG | `CheckPassword` 改为 `legacypw.Verify`；`Login` 密码校验通过后 `s.claudexUpgradeLegacyPasswordHash(...)`；import | 从其他系统导入的用户保留 passlib `bcrypt_sha256`（v1/v2）或 werkzeug `pbkdf2`/`scrypt` 哈希，用原密码登录；首次登录成功后在签发 token 之前改写为标准 bcrypt（token 版本由哈希推导）。标准 bcrypt 行为不变 |
| `internal/service/user.go` | ZMIG | `User.CheckPassword` 改为 `legacypw.Verify`；import | 改密、TOTP、passkey、备份等“确认当前密码”的路径同样接受迁入用户的旧哈希；`SetPassword`、管理员重置仍写 bcrypt |

### 前端（`backend/frontend/src`）

| 文件 | 改动 | 原因 |
|---|---|---|
| `api/admin/system.ts` | `VersionInfo.update_disabled` | 在线更新关闭状态 |
| `stores/app.ts` | `updateDisabled` 状态 | 同上 |
| `components/common/VersionBadge.vue` | 关闭时显示“Online update is disabled”说明，不显示更新和回滚控件 | 不显示用不了的控件 |
| `router/index.ts` | 展开 `claudexAdminRoutes` 与 `claudexPublicRoutes`（`/desktop-only`、`/desktop-pay`）；`beforeEach` 开头读取 web_console_admin_only（`stores/webConsole.ts`，每次页面加载读一次，读不到按开启处理）；公开页分支开头调用 `resolveAdminOnlyPublicRedirect`，受保护页在管理员判断之前调用 `resolveAdminOnlyProtectedRedirect`；`/setup` 完成后的去向带上开关；`ADMIN_ONLY_ROUTE_LISTS` 复用上游 `BACKEND_MODE_CALLBACK_PATHS`、`BACKEND_MODE_PENDING_AUTH_PATHS` | 管理员专用路由组 `/admin/claudex/*`；网页控制台仅限管理员（规则在 `router/webConsole.ts`，只收口前端路由，JSON API 不受影响） |
| `router/setupRedirect.ts` | `resolveCompletedSetupRedirectPath` 第三个参数 `adminOnly`（默认 false）：开启时已登录的非管理员去 `/desktop-only` | 同上，避免 `/dashboard` 再被拦截 |
| `views/auth/LoginView.vue` | 密码、Passkey、2FA 三处登录成功后改为调用 `continueAfterLogin()`（管理员去 `redirect` 或 `/admin/dashboard`；开关开启时非管理员先 `authStore.logout()` 再去 `/desktop-only?reason=not_admin`，不弹“登录成功”）；开关开启时隐藏注册链接；挂载时 `ensureLoaded()` | 普通用户只用桌面端；网页登出只吊销本网页会话的 refresh token，不影响桌面端 |
| `components/layout/AppSidebar.vue` | 管理菜单中的 Claudex 分组（子项来自 `router/claudex.ts` 的 `CLAUDEX_ADMIN_NAV`，放在“公告”之后，标题键 `admin.claudex.nav.root`）；普通用户菜单在开关开启时不显示 | 管理员侧栏入口；非管理员不再看到用户菜单 |
| `App.vue` | `userWebDataEnabled`：开关开启且非管理员时不预加载/轮询订阅、不拉取公告 | 兜底：这些数据只有用户页面才用 |
| `api/admin/index.ts` | `adminAPI.claudex`（`api/admin/claudex.ts` 的聚合导出） | Claudex 控制台各区域的接口 |
| `i18n/locales/{en,zh}/index.ts` | 引入 `desktopOnly`、`desktopCheckout` 文案模块 | 文案键 `desktopOnly.*`、`desktopCheckout.*` |
| `i18n/locales/{en,zh}/admin/index.ts` | 引入 `claudex` 及 10 个页面文案模块（`claudexPolicy`、`claudexModels`、`claudexDevices`、`claudexUsageRules`、`claudexRelease`、`claudexGeneral`、`claudexVoice`、`claudexFeedback`，第二轮 B-S 加 `claudexSharing`、`claudexMemory`） | 文案键 `admin.claudex.*`、`admin.claudex<Page>.*` |
| `i18n/locales/{en,zh}/admin/settings.ts` | `site.backendModeDescription` 末尾追加“开启后 Claudex 桌面端的普通用户也无法登录” | Backend 模式保留，但提醒它对桌面端的影响 |
| `i18n/__tests__/localesNoKeyCollision.spec.ts` | 把 `claudex`、10 个页面模块（第二轮 B-S 加 `claudexSharing`、`claudexMemory`）与 `desktopOnly`、`desktopCheckout` 加入顶层键冲突检查 | 防止与上游文案键冲突 |
| `router/__tests__/guards.spec.ts` | 新增 “Web console admin-only” 用例组：用真实 `beforeEach`（捕获自 `createRouter` 的桩）逐条走重定向，覆盖管理员/非管理员/未登录、全部放行页、设置缺失/损坏/开/关、无循环 | 守卫回归测试 |
| `router/__tests__/feature-access.spec.ts` | 桩 `@/stores/webConsole`（开关关闭） | 上游用例按开关关闭（上游行为）运行 |
| `views/auth/__tests__/LoginView.spec.ts`、`views/auth/__tests__/TencentCaptchaActionGate.spec.ts` | 同上 | 同上；开关开启的登录去向见 `LoginView.claudex.spec.ts` |
| `components/admin/user/UserEditModal.vue` | 密码输入框下加一行提示（文案键 `admin.claudexDevices.passwordResetHint`）：重置密码会让用户的 Claudex 桌面端退出登录，重新登录后设备 Key 继续可用（R13） | 上游改密使全部令牌失效（正确的安全行为，不改）；管理员改密前应知道对桌面端的影响（设备 Key 不停用，业主决策 4） |

## Claudex 新增的文件

- Go，Claudex 目录 `internal/claudex/`：模块（`module.go`、`routes.go`、`settings.go`、`doc.go`）、契约包 `core/`、
  挂钩注册表 `hook/`（`claudexhook`）与 `gatewayhook/`、十一个组件包 `webconsole/ release/ policy/ catalog/ devices/
  usage/ refusal/ voice/ feedback/ bootstrap/ payment/`（B0 建桩，B1–B10 实现），及各自测试。
  `internal/claudex/.gitignore` 用 `!release/` 重新纳入 `release/` 组件包（上游 `backend/.gitignore` 忽略所有名为 `release/` 的目录）。
  - B9 `bootstrap/`：`GET /api/v1/claudex/bootstrap`（用户链加上游 Heavy 限流），并行合并各组件的区块（各 2 s）、失败区块列入 `errors`、
    ETag 不含 `generated_at`；只读上游 `site_name`、`payment_enabled` 与 B4 的 `claudex_provisioning.enabled`，不写设置、不建表、不改上游文件。
    模块构造时的区块归属测试在 `internal/claudex/bootstrap_sections_test.go`。
- Go，上游目录里的 Claudex 文件（文件头 `CLAUDEX:`）：
  - `internal/service/update_service_claudex.go`、`internal/service/auth_service_claudex.go` 及其 `_claudex_test.go`（H10、H7）；
  - `internal/service/claudex_usage_event.go`(+`_test`)（H8 事件，B0 初版，之后归 B5）；
  - `internal/service/claudex_openai_audio.go`（B7 新建，听写计费，设计 1.3 例外 1）；
  - `internal/handler/claudex_openai_audio.go`（H12，B0 建桩，之后归 B7）；
  - `internal/handler/claudex_api_keys.go`(+`_test`)（H13 辅助函数）、`internal/handler/claudex_ws_turn.go`（H14 辅助函数）、
    `internal/handler/claudex_revoke_all_test.go`（H9 测试）；
  - `internal/server/middleware/claudex_session.go`(+`_test`)（H9b）、`internal/server/middleware/claudex_gateway_hooks_test.go`（H5/H5b 测试）；
  - `internal/handler/claudex_session.go`(+`_test`)（H9b：OAuth 绑定 Cookie 里的 access token）、`internal/handler/claudex_ws_turn_test.go`（H14 测试）；
  - `internal/handler/claudex_native_sessions.go`（H16：`/api/v1/auth` 答出的 token 对与登出交回的 refresh token 通知 Claudex，“活跃会话”列出手机 App 的登录）；`internal/service/auth_service_claudex.go` 的 `RefreshTokenOwner`（H16，登出前读出 refresh token 的会话家族）；
  - `internal/server/routes/claudex_routes_test.go`、`internal/server/routes/claudex_route_coverage_test.go`（路由覆盖：管理接口
    401/403/423、用户接口需 JWT、合规放行列表不变、每条网关路由都经过 Claudex 守卫、审计不含隐私正文）、
    `internal/server/routes/claudex_gateway_adversarial_test.go`（伪造的上游 `claudex`、伪造的客户端头、藏在重复键/大小写变体/
    转义键/路径参数/multipart 里的模型名）；
  - `migrations/claudex_migrations_test.go`（Claudex 迁移命名、排序、编号段、IF NOT EXISTS、不改不写上游表）。
  - `migrations/claudex_0040_feedback.sql`（B8：`claudex_diagnostics`、`claudex_feedback`；指向 `claudex_devices` 的外键只在该表已存在时添加）。
  - `migrations/claudex_0010_model_meta.sql`（B3：模型展示目录表 `claudex_model_meta`；全局行 `group_id NULL` 与分组行，
    每个作用域一个模型一行、至多一个默认；外键只指向上游 `groups`、`users`，不改、不写上游表）。
- 前端：`api/admin/claudex.ts`（聚合导出）与 `api/admin/claudex/`（各区域接口）、`api/claudexPublic.ts`、
  `router/claudex.ts`、`router/webConsole.ts`、`stores/webConsole.ts`、`views/admin/claudex/`、
  `views/public/DesktopOnlyView.vue`、`views/public/DesktopCheckoutView.vue`（`/desktop-pay`，K0 占位、B10 实现，见下条）、
  `components/admin/claudex/`、`utils/claudexDesktopPlatform.ts`、
  `i18n/locales/{en,zh}/desktopOnly.ts`、`i18n/locales/{en,zh}/desktopCheckout.ts`、`i18n/locales/{en,zh}/admin/claudex*.ts` 及各自的测试
  （`*.claudex.spec.ts`、`router/__tests__/webConsole.spec.ts` 等）；`components/common/__tests__/VersionBadge.claudex.spec.ts`。
  - K2 模型目录页：`views/admin/claudex/ClaudexModelsView.vue`（替换 K0 桩）、`components/admin/claudex/models/`
    （编辑对话框、表单校验、测试）、`api/admin/claudex/models.ts`；K0 的桩页用例（`components/admin/claudex/common/__tests__/common.spec.ts`）
    改为只检查源码里仍带 K0 桩注释的页面。
- B10 桌面结账（业主决策 2，设计 2.11）：Go 组件 `internal/claudex/payment/`（`checkout.go`：用户接口
  `POST /api/v1/claudex/payment/checkout-links` 校验 resume token、归属、待支付、Stripe/Airwallex 与
  `payment_trade_no` 后把渲染数据存进 Redis 随机令牌，TTL ≤ 30 分钟且 ≤ 订单到期；公开接口
  `POST /api/v1/claudex/payment/checkout` 凭令牌返回渲染数据，订单不再待支付时不返回密钥；只调用上游已导出的
  `PaymentService.GetPublicOrderByResumeToken`、`PaymentConfigService.GetPaymentConfig`、`PaymentOrderCurrency`，
  不改上游文件）及测试；前端 `/desktop-pay` 的真实页面 `views/public/DesktopCheckoutView.vue`（只用 `fetch`
  调公开接口，令牌取自 URL fragment 并立即清除，按 provider 挂载 Stripe Payment Element 或打开 Airwallex 收银台，
  完成后去 `/payment/result?resume_token=`；不修改上游 `StripePaymentView.vue`、`AirwallexPaymentView.vue`）、
  `api/claudexCheckout.ts`、`i18n/locales/{en,zh}/desktopCheckout.ts` 与 `views/public/__tests__/DesktopCheckoutView.spec.ts`。
  - K1 客户端策略页（`/admin/claudex/policy`）：`views/admin/claudex/ClaudexPolicyView.vue`、`components/admin/claudex/policy/`
    （`PolicyPatchEditor`、`PolicyItemRow`、`PolicyOverrideDialog`、`PolicyUserPicker`、`PolicyPreview`、`policyForm.ts`）、
    `api/admin/claudex/policy.ts`、`i18n/locales/{en,zh}/admin/claudexPolicy.ts` 及测试；未改上游文件。
- 前端（K3）：`/admin/claudex/devices`（设备 Key 供应设置 `claudex_provisioning`，含每用户设备上限默认值与用户自建 API Key 开关；
  设备列表、吊销、登出所有设备、按用户设备上限）与 `/admin/claudex/usage-rules`（用量规则、按用户计数与重置、用户用量代看），
  文件为 `views/admin/claudex/Claudex{Devices,UsageRules}View.vue`、`components/admin/claudex/{devices,usage}/`、
  `api/admin/claudex/{devices,usageRules}.ts`、`i18n/locales/{en,zh}/admin/claudex{Devices,UsageRules}.ts`；所有写操作先确认再经 step-up。
- 前端 K4（控制台“通用、桌面端发布、语音、诊断与反馈”四页，不改上游文件）：`views/admin/claudex/Claudex{General,Release,Voice,Feedback}View.vue`、
  `components/admin/claudex/{general,release,voice,feedback}/`（表单模型与校验、更新说明 Markdown 预览、估算计费列表、诊断/反馈收件箱与详情抽屉）、
  `api/admin/claudex/{general,release,voice,feedback}.ts`、`i18n/locales/{en,zh}/admin/claudex{General,Release,Voice,Feedback}.ts` 及各自测试；
  K0 的 `components/admin/claudex/common/__tests__/common.spec.ts` 桩页用例改为只检查仍是 K0 桩的页面。
  - K4 续做（业主决策 18/19）：语音页只配置听写的实时识别转发（开关、识别服务 wss 地址、只写 API 密钥（只显示掩码，
    可替换/删除）、单次会话时长、单次会话音频上限（按 32000 字节/秒以秒编辑）、空闲超时），显示只读计费说明与服务端警告，
    列出听写会话（`voice/VoiceSessionList.vue`，取代 `EstimatedUsageList.vue`）；去掉朗读（音色、默认音色、最多字符数）
    与 OpenAI 分组模型/上传大小字段。接口形状按改范围后的 B7（`GET/PUT /admin/claudex/voice`、`/voice/estimated-usage`）。
- 接口契约 fixture：`internal/claudex/contract/testdata/`（JSON 样例，取自设计第 2 节；桌面端 C1 的
  `tests/claudex-contract.test.ts` 与服务端联调 I1 共用，说明见该目录 `README.md`）。
- 文档与许可：本文件、`README.claudex.md`、`SOURCE_OFFER.md`（对应源码与分发时的提供方式）、`COPYING`（GPL-3.0 全文，
  取自 <https://www.gnu.org/licenses/gpl-3.0.txt>，LGPL-3.0 以它为基础；上游 `LICENSE` 未改）。

## 未改动但需要知道的上游行为

- 管理员合规承诺闸门（`AdminComplianceGuard`、`/admin/compliance`、423 `ADMIN_COMPLIANCE_ACK_REQUIRED`）
  原样保留；Claudex 的管理接口都在闸门之后，Claudex 代码不接受、不绕过、不写入承诺。
- 用户经上游 `/api/v1/keys` 自建 API Key 在 Claudex 中默认关闭（业主决策 17，`CLAUDEX_USER_API_KEYS_DISABLED`），
  管理员自己的 Key 不受影响；开关由 B4 的供应设置提供（`core.APIKeyCreateGate`）。上游没有“管理员替其他用户建 Key”的接口。
- 其余上游功能全部保留。

## B7 听写：实时转写中转（设计 2.8，业主决策 18/19 改写）

朗读（TTS、`/v1/audio/speech`）按决策 19 整体删除；原 OpenAI 分组 `POST /v1/audio/transcriptions` 由决策 18 的实时转写
WebSocket 中转取代。上游已有文件只改 H6 一行路由（见上表）及三个上游/B0 测试里对旧路由的引用
（`prompt_audit_route_coverage_test.go`、`claudex_gateway_adversarial_test.go` 的 multipart 用例改为 `/v1/images/edits`、
`internal/claudex/usage/gateway_integration_test.go` 把新路由加进 WebSocket 握手用例）。新增：

- `internal/claudex/voice/`：设置 `claudex_voice`（`transcription.{enabled, upstream_url, max_session_seconds, max_bytes,
  idle_timeout_seconds}`，默认关闭；上游 API Key 只写：AES-256-GCM 用服务端 `TOTP_ENCRYPTION_KEY` 加密后存为
  `api_key_ciphertext`，管理接口只返回 `api_key_configured` 与末四位掩码；没有固定加密密钥时拒绝保存 400
  `CLAUDEX_VOICE_ENCRYPTION_KEY_MISSING`）、管理接口 `GET/PUT /api/v1/admin/claudex/voice`（只读 `billing`、`warnings`）
  与 `GET /voice/estimated-usage`（会话列表，每行都按字节估算）、bootstrap 区块 `voice`（不含上游地址与密钥）、
  `relay.go`（校验并重建 start 帧、只收 16 kHz 单声道 pcm_s16le、转发二进制音频到字节上限、finish、空闲与时长上限、
  上游关闭码转给客户端）、`DialUpstream`（密钥只放 Authorization 头，错误里不含密钥与上游响应体）；测试
  `settings_test.go`、`component_test.go`、`relay_test.go`（假上游 WebSocket）。
- `migrations/claudex_0050_voice.sql`：表 `claudex_voice_sessions`（每个计费会话一行：字节、秒数、费用、是否已扣费、结束原因）。
- `internal/service/claudex_openai_audio.go`（设计 1.3 例外 1）：`RecordClaudexRealtimeTranscription`，按
  `字节 / 32000` 秒 × 分组 `audio_stt_price_per_hour`（未设用内置 $0.10/小时）× 用户/分组倍率，用统一扣费命令
  （`usage_billing_dedup` 幂等、余额或订阅、Key 配额与窗口、平台配额），成功后 `claudexhook.UsageApplied`；
  不写 `usage_logs`（该表要求上游账号）；测试 `claudex_openai_audio_test.go`。
- `internal/handler/claudex_openai_audio.go`（H12）：`ClaudexAudioRealtimeTranscriptions`，检查顺序见文件头注释
  （426 → 404/503 → 仅设备 Key 403 → 计费模型的用量规则 429 → 计费资格 → 用户并发槽 → 上游握手 502 → 中转 → 计费与会话记录）；
  测试 `claudex_openai_audio_test.go`（unit，假上游 WebSocket）。

## B4 设备与设备 Key（Claudex 新增文件，未改上游文件）

- `migrations/claudex_0020_devices.sql`：`claudex_devices`（每个用户 + 设备一行，只存设备 id 的 sha256；`api_key_id` 指向的 Key 即设备 Key）、
  `claudex_session_revocations`（每用户最近一次“登出所有设备”）、`claudex_revoked_sessions`（已登出的会话家族，过期后每小时清理）、
  `claudex_user_device_limits`（管理员设置的按用户设备上限）。只建 Claudex 表，外键只指向 `users`、`groups`、`api_keys`。
- `internal/claudex/devices/`：设置 `claudex_provisioning`（含业主决策 17 的 `user_api_keys_enabled`，默认 false）、计划分组解析、
  `POST/GET /api/v1/claudex/devices`、`DELETE /devices/current|:id`、管理接口 `/admin/claudex/provisioning|devices|users/:user_id/...`、
  H9 / H9b / H13 / 决策 17 / H7 的实现、网关 KeyMarker 与已吊销设备守卫（优先级 10）、bootstrap `plan`/`device` 区块、每 5 分钟对账。
  对上游表只经 `APIKeyService`、`AuthService`、`AdminService` 写入；revoke-all 与设备吊销只停用 `claudex_devices` 引用的 Key，
  绝不修改用户自建的 Key（业主决策 13）。
## 组件实现记录（B 包，只改 `internal/claudex/<组件>/`，不改上游文件）

- **B1** `internal/claudex/webconsole/`、`internal/claudex/release/`：设置 `claudex_web_console_admin_only`
  （公开 `GET /api/v1/claudex/web-console`，管理 `GET/PUT /api/v1/admin/claudex/web-console`，PUT 挂 step-up）与
  `claudex_client_release`（管理 `GET/PUT /api/v1/admin/claudex/release`，PUT 挂 step-up；实现 `core.ReleaseInfo`，
  由模块已注册的 `GET /api/v1/claudex/release` 合并；bootstrap `release` 区块）；网关 RequestGuard（优先级 20，经 H5b）
  只对 Claudex 设备 Key、且 `enforce_minimum_on_gateway=true`（默认关闭，业主决策 7）时对低于最低版本的客户端返回
  426 `CLAUDEX_UPGRADE_REQUIRED`。没有新增或修改上游文件，没有迁移。
## B2 客户端策略（`internal/claudex/policy/`）

- 没有改任何上游文件；只在 Claudex 自己的目录里新增/修改：`policy/{component,model,parse,validate,resolve,handler}.go`
  及测试（`*_test.go`、`testdata/design-2.3-*.json`、`integration_test.go`（`//go:build integration`））。
- 设置键 `claudex_client_policy`（经 `core.JSONSetting`；修订号用 `GetRaw` + `SwapIfUnchanged` 原子比较写入）；接口
  `GET /api/v1/claudex/policy`（ETag）、`GET/PUT /api/v1/admin/claudex/policy`（PUT 挂 step-up，审计附加 `config_version`）、
  `POST /api/v1/admin/claudex/policy/preview`；bootstrap 区块 `policy`。只读上游设置 `doc_url`、`purchase_subscription_enabled`、
  `purchase_subscription_url` 作链接回退。策略的存储、下发与预览里没有任何 Bypass 字段或取值（业主决策 3）。
- 跨包最小改动：`internal/claudex/module_test.go`（B0 的测试，带 `CLAUDEX B2` 注释）去掉“桩组件不返回 bootstrap 区块”的断言
  （组件从 B2 起开始提供区块；区块归属仍由模块的 `bind` 校验）。
- 审查补充：连接器规则增加可选 `args`（只能与 `command` 同用；客户端按程序与参数完全一致匹配，主会话决定）；
  `attachments.max_megabytes` 折算不足 1 字节时拒绝；bootstrap 在 B9 未给出计划时自行区分“无计划”和“查询失败”。
## B5 用量规则（`internal/claudex/usage`）

- 新增迁移 `migrations/claudex_0030_usage_rules.sql`：表 `claudex_usage_rules`（分组或全部分组的 5 小时会话、全部模型与按模型限额，
  美元，首次使用起算窗口）与 `claudex_usage_counters`（每个规则 × 用户的当前窗口）。不改上游表。
- 组件 `internal/claudex/usage/`（不改任何上游文件，只经已有挂钩接入）：H8 累计（每笔扣费一条 UPSERT，请求/计费/上游三个模型名
  任一命中即计入，模型名同时按上游的等价写法匹配：去掉 `models/` 等前缀、Claude 短名、OpenAI 别名与推理后缀；失败进内存重试队列，队列满写 ERROR 日志并累加 `claudex_usage_counter_dropped_total`）；H5b 守卫（优先级 30，
  对分组内全部 Key、全部网关路由族与方法，不计费白名单除外；超限 429 `CLAUDEX_USAGE_LIMIT_EXCEEDED`，带 `claudex` 详情与
  `Retry-After`）；H14 WebSocket 每轮预检；`GET /api/v1/claudex/usage-status`；bootstrap 区块 `usage`；管理接口
  `GET/POST /api/v1/admin/claudex/usage-rules`、`PUT/DELETE /usage-rules/:id`、`GET /usage-rules/:id/counters`、
  `POST /usage-rules/:id/reset`、`GET /users/:user_id/usage-status`（写操作挂 step-up）。
- `internal/service/claudex_usage_event.go`（H8 事件，B0 初版）归 B5，内容未改。
- 会话用量（2026-10-12，客户端 Code 会话的用量报告）：`GET /api/v1/claudex/session-usage?session_id=…&since=RFC3339`
  （`session.go`），只读当前用户 `usage_logs` 中 `session_id` 命中（客户端网关把 Codex 线程 id 作为 `session_id` 头发送，
  上游 `ExtractClientSessionID` 已落库）且 `created_at >= since` 的行，按请求模型汇总请求数、输入/输出/缓存读/缓存写 token、
  `actual_cost` 与 `duration_ms`。最多 20 个 id，`since` 最多回溯 400 天，走已有的 `(user_id, created_at)` 索引；不新增迁移、不改上游文件。
- 跨包改动（B0 的测试）：`internal/claudex/module_test.go` 中 “桩不返回 bootstrap 区块” 的断言改为只检查每个区块贡献者声明了区块
  （标记 `CLAUDEX(B5)`）；B5 之后 `usage` 组件返回 `usage` 区块，原断言不再成立。
## 组件实现记录（各 B 包追加）

- B6 `internal/claudex/refusal/`（结构化拒绝信息，设计 2.7）：实现 `gatewayhook.RefusalDescriber`，只新增该目录下的文件，
  不改上游文件。只读使用上游服务：`APIKeyService.GetByID`/`GetRateLimitData`、
  `SubscriptionService.GetActiveSubscription`/`GetSubscriptionProgress`/`ListUserSubscriptions`、`SettingRepository.GetMultiple`
  （`payment_enabled`、`purchase_subscription_*`、`claudex_client_policy`，决定 `action` 是否为 `get_more_usage`）；
  `API_KEY_DISABLED` 时不经缓存直查 B4 的 `claudex_devices.revoked_at`；用 `middleware.GetAPIKeyFromContext`/`GetOpsFallbackAPIKey`
  取本请求 Key 的分组。

## 第二轮（R1–R13，2026-09-26 起）

骨架由 B-S（后端冻结接缝）建立；各后端包把自己的条目写进报告，由 FINAL 汇总到下面各小节。第二轮的组件只改
`internal/claudex/<组件>/` 与分配给它的迁移，冻结文件（`core/component.go`、`module.go`、`routes.go`、`gatewayhook`、
`server/router.go`、`web/embed_on.go`、迁移分配表、路由覆盖测试）由 B-S 一次改完。

### B-S 后端冻结接缝

- 上游文件：`internal/server/router.go`、`internal/web/embed_on.go`（+ `embed_test.go`），见上表 H15。
- 契约 `core/component.go`：新接口 `core.PageRouter`（`RegisterPageRoutes(g)`，挂在根路径 `/s`）；组件名
  `NameSharing = "sharing"`、`NameMemory = "memory"`、`NameWebSearchGuard = "web-search-guard"`；bootstrap 区块
  `SectionMemory = "memory"`（归 `memory`）。
- `core/secretbox.go`（+ 测试）：`core.SecretBox`（AES-256-GCM，服务端 `TOTP_ENCRYPTION_KEY`，格式同上游 AESEncryptor），
  从 `voice/secret.go` 复制，供第二轮组件（R3 记忆）使用；`voice` 包本轮不改，仍用自己的副本，以后再合并。
- `gatewayhook.PriorityWebSearch = 40`（R45 网页搜索策略守卫，排在设备 10、版本 20、用量规则 30 之后）。
- `module.go`：安装顺序 B1…B8、`memory`、`bootstrap`、`payment`、`sharing`、`web-search-guard`；新增
  `(*Module).RegisterPageRoutes(r, panelRateLimiter)`（常量 `claudex.PagePrefix = "/s"`）。
- `routes.go`：`privateBodyRoutes` 预先登记 `POST /shares`、`PUT /shares/:id`（R1 快照）与 `PUT /memory/docs/:scope`、
  `POST /memory/edits`（R3 记忆正文），审计日志只记录不含请求体的条目；`PUT /memory/prefs` 照常审计。
- 三个组件桩（可编译、已安装，但不注册任何路由、不返回区块、不注册守卫，桌面端看不到入口）：
  `sharing/`（`component.go` 实现 `core.PageRouter` 但不注册页面，`/s/*` 一律 404；`types.go` 快照 schema 1 类型、
  `Kind`、`Status`、`PathPrefix`）、`memory/`、`websearchguard/`（只有 `Priority()`，R45a 加 `OnRequest` 后模块自动注册）。
  接手的包只能扩展导出，改名或删除要先报主会话。
- 迁移编号：R1 分享 0060–0069（`claudex_0060_sharing.sql`），R3 记忆 0070–0079（`claudex_0070_memory.sql`），0080–0099 保留；
  `migrations/claudex_migrations_test.go` 新增分配表不重叠、覆盖 1–99 的检查。
- 路由覆盖测试 `internal/server/routes/claudex_route_coverage_test.go`（只由 B-S 修改）：公开 JSON 路由加
  `POST /api/v1/claudex/shared/:token/reports`；新增“`/s` 下每个页面都免登录、不写审计、且在名单内”
  （`GET /s/:token`、`/s/:token/a/:n`、`/s/:token/raw/:n`、`POST /s/:token/report`、`GET /s/_assets/*path`）；
  隐私请求体检查加上分享快照与记忆正文（支持 PUT）。
- 控制台（前端）：`router/claudex.ts` 新增 `/admin/claudex/sharing`、`/admin/claudex/memory` 路由与侧栏项（修正 `/desktop-pay`
  的过时注释，并注明不得新增 `/s/` 开头的 Vue 路由）；`api/admin/claudex.ts` 聚合 `sharing`、`memory`；桩文件
  `api/admin/claudex/{sharing,memory}.ts`、`views/admin/claudex/ClaudexSharingView.vue`、`views/admin/claudex/memory/ClaudexMemoryView.vue`
  （页面如实显示“此版本尚未提供”，没有控件）、`i18n/locales/{en,zh}/admin/claudex{Sharing,Memory}.ts`；测试
  `components/admin/claudex/common/__tests__/common.spec.ts`（页面数 9，识别 B-S 桩）、`components/layout/__tests__/AppSidebar.claudex.spec.ts`、
  `views/admin/claudex/memory/__tests__/ClaudexMemoryView.spec.ts`。
- `cmd/server/wire_gen.go` 未变（`ProvideModule(deps)` 签名不变，新组件不需要新依赖）。

### R1 托管分享（R1-B、R1-V、R1-K 填写）

### R3 记忆（R3-S1、R3-S3 填写）

- R3-S1（服务端，均为 Claudex 新文件，未改上游文件）：迁移 `migrations/claudex_0070_memory.sql`（`claudex_memory_prefs`、
  `claudex_memory_docs`、`claudex_memory_edits`，正文与编辑用 `core.SecretBox` 加密后入库，`device_id` 外键按 0040 的
  `to_regclass` 守卫写法）；组件 `internal/claudex/memory/`：用户接口 `GET/DELETE /memory`、`PUT /memory/prefs`、
  `PUT/DELETE /memory/docs/:scope`、`POST /memory/edits`、`DELETE /memory/edits/:id`（写接口每用户每小时 120 次），
  管理接口 `GET /memory/stats`、`GET /memory/users/:id`、`DELETE /memory/users/:id`（step-up，合规闸门之后，不返回正文），
  bootstrap 区块 `memory`；策略经 policy 组件的 bootstrap 区块读取（组件之间不互相 import）。测试补充
  `internal/claudex/bootstrap_sections_test.go`（memory 区块归属）。
- R3-S3（控制台，均为 Claudex 文件，未改上游文件）：`api/admin/claudex/memory.ts`（stats、用户元数据、清除）；
  `views/admin/claudex/memory/`（`ClaudexMemoryView.vue` 取代桩，含 `MemoryStatsCard.vue`、`UserMemoryCard.vue`：使用统计、
  加密密钥缺失警告、按用户查看各 scope 元数据与开关、确认后经 step-up 清除；服务端无记忆功能时 404 显示“不可用”）；
  `i18n/locales/{en,zh}/admin/claudexMemory.ts`；`ClaudexOverviewView.vue` 在服务端带 memory 功能且缺少固定加密密钥时显示警告。
  记忆策略区块由 POL 在客户端策略页完成，本页只链接过去。

### R45 网页搜索与 Research（R45a 填写）

- `internal/claudex/websearchguard/guard.go`（+ `guard_test.go`）：B-S 桩补上 `OnRequest`，模块按接口断言自动注册为
  H5b 守卫（优先级 `PriorityWebSearch = 40`，在设备 10、版本 20、用量规则 30 之后）。只对 Claudex 设备 Key 生效
  （`gatewayhook.Device`，已停用的设备交给 B4）；用户自建 API Key 一律放行。检查设备 Key 的每个 JSON POST（不只
  `/v1/responses`，也覆盖 `/responses`、`/backend-api/codex/responses`、Chat Completions 等同样能触达上游搜索的路径，
  防止换路径绕过）：`tools[]` 或 `input[].additional_tools` 中类型为 `web_search`、`web_search_preview` 及带日期的变体、
  `x_search`，以及 Chat Completions 的 `web_search_options`、xAI 的 `search_parameters`（mode 非 off）。
  请求体按网关体积上限读取（解压），读完用 PrereadBody 放回，下游读到的字节不变。
  键名大小写不敏感、`\u` 转义解码后比较、重复键逐个检查（上游 encoding/json 与 gjson 的解析差异不能用来绕过）；
  声明为表单（multipart/urlencoded）但内容以 `{` 开头的请求体同样检查，真正的表单上传只窥视前 512 字节后原样放回。
- 策略来源：从 `env.Components` 找到 client-policy 组件，调用它的 bootstrap 区块（与桌面端拿到的同一份解析结果，读
  缓存文档，不逐请求查库），按 Key 的分组（无则用设备分组）、用户与设备平台解析。`web_search=false` → 403；
  `web_search=true` 但 `research.x_search=false` 时只拒 `x_search`。策略无法解析（组件缺失、报错、panic、字段缺失）时
  放行并记 Warn（与用量规则预检一致，客户端同样执行该策略）。
- 拒绝格式：OpenAI 错误形态 `{"error":{"type":"permission_error","code":"CLAUDEX_WEB_SEARCH_DISABLED","message":…}}`，并用
  `gatewayhook.SetDetail` 预置 `claudex` 对象（`reason` 为 `WEB_SEARCH_DISABLED` 或 `X_SEARCH_DISABLED`，`kind:"policy"`，
  `action:"none"`，英文提示），由 EnrichRefusals 附加给桌面端。
- 已知边界：Responses WebSocket 的回合在握手之后才带工具，本守卫看不到；桌面端关闭了 Responses WebSocket
  （`supports_websockets: false`），用户自建 Key 本来就不受约束。
- `internal/service/openai_gateway_grok_search_test.go`（新测试文件，不改上游代码）：grok 透传回归——`web_search`、
  `x_search` 工具与 `web_search_call.action.sources`、`x_search_call.action.sources` include 原样发到上游（只去掉 xAI 不认的
  `external_web_access`，丢弃 OpenAI 专有的 `web_search_preview`）；`additional_tools` 载体里的搜索工具被提升到顶层；
  非流式与流式响应里的 `action.sources`、`url_citation` 注解、`response.citations` 原样回给客户端，搜索次数计费不变。

### R13 细节（R13-A 填写）

### ZMIG 旧密码哈希兼容

- `internal/claudex/legacypw/`：旧哈希识别与校验（passlib `$bcrypt-sha256$v=2,…`、`$bcrypt-sha256$2b,…`，werkzeug
  `pbkdf2:<sha1|sha256|sha512>:<迭代>$salt$hex`、`scrypt:N:r:p$salt$hex`），常数时间比较，限制迭代次数与 scrypt 内存；
  测试向量由 passlib 1.7.4 / werkzeug 3 生成。只依赖标准库与 `x/crypto`。
- `internal/service/claudex_legacy_password.go`(+`_test`)：登录成功后改写为 bcrypt（上表 `auth_service.go` 的挂钩）。

## 网页版（W-*，2026-09-26 起）

整体说明见仓库根目录的 `docs/architecture.md`。网页包把变更条目写进自己的报告，由 W-FINAL 汇总到本节；本节按 origin/main
`5b0e0544` 的合并结果填写。

### 已合并

- **W-PROTO** `internal/claudex/webproto/`（Claudex 新增目录，未改上游文件，无迁移）：网页版协议的 Go 镜像，只用标准库，
  不注册组件、不挂路由。`protocol.go`（路径、头、Cookie 名、限额、关闭码、`CLAUDEX_WEB_*` 错误码、43 位 base64url 票据的
  生成与解析、子协议 `claudex.v1` / `claudex.runner.v1`、v1 的 runner 请求 op 清单 `RunnerOps`）、`frames.go`（RPC 信封、
  浏览器事件帧与 runner link 帧的解码与校验、构造器，错误都包 `ErrProtocol`；`OpenableURL` 只放行 `https://` 与同源路径；
  `IsUserOp`：`store.*`、`key.*` 请求必须带 userId）、
  `docs.go`（存储文档 schema 1：`TurnDoc`、`ConversationDoc`，用 `json.RawMessage` 保留全部字段）。与桌面端
  `shared/web-protocol.ts` 共用 `webproto/testdata/*.json`（每类帧、票据、存储文档、base64 用例、两边常量对照
  `constants.json`、两边都必须拒绝的 `invalid.json`），两边测试逐个读取。
- 其余已合并的网页包（W-SPIKE、W-HOST、W-BRIDGE、W-BUILD、W-HOME、W-TRIM1、W-BWRAP、W-RUNNER、W-GVISOR）不改 `backend/`。
  W-GVISOR 的沙箱镜像在仓库根目录 `deploy/claudex-runner/image/`，不属于本目录。

- **W-SITE**（上游文件见上表 W-SITE 行）：
  - `internal/web/sitepaths/`（新增，无依赖的叶子包）：`reserved_paths.json` 列出 Go 路由放行路径、控制台前缀 `/admin`、
    控制台根部公开页（`/desktop-pay`、`/reset-password`、`/legal/*`、OAuth 回调、支付结果等）、旧路径 302
    （`/dashboard` → `/admin/my/dashboard` 等，保留查询串；`/login?redirect=/admin…` → `/admin/login`）；`Classify` 供
    SiteServer 与安全头中间件共用。
  - `internal/web/site.go`、`render.go`（新增）：分发顺序 放行 → `/admin` → 根部公开页 → 旧路径 302 → 网页版；网页版未构建或被
    管理员关闭时 `/` 302 到 `/admin/`、其余 404；网页版 index 注入 `window.__CLAUDEX_WEB__`（带 CSP nonce），控制台仍注入
    `__APP_CONFIG__`；两个 index 各自 ETag 缓存。覆盖目录：控制台 `data/public/admin`，网页版 `data/public`。
  - `internal/claudex`：`core.WebAppConfig` 接口与 `Module.WebApp()`；`X-Claudex-Client: web`（`core.HeaderClient`，值取自
    `webproto`）在 `ReadClientHeaders` 校验、`core.ClientKind`、`BootstrapContext.Client`，并加入 ETag 的 `Vary`；组件名与
    空组件 `web`、`webstore`、`webhost`、`cloud`（安装在 `websearchguard` 之后）；`privateBodyRoutes` 预先登记网页版 RPC、
    上传、登录、2FA、注册、重置密码（路由覆盖测试同步）。
  - 迁移分配表：0080–0089 网页（0080 网页会话 W-AUTH、0081 webstore W-STORE、0082 网页用量 W-KEY），0090–0099 runners 与云端
    （0090 W-RELAY、0091 W-CLOUD），0100–0199 保留。
  - 构建脚本：`scripts/backend/go.sh build-embed` 改查 `dist/admin/index.html`。Vue 输出目录改到 `dist/admin` 由 W-CONSOLE 完成，
    合并 W-CONSOLE 之前 `build-embed` 会因缺少控制台构建而停止；复制网页版到 `dist/app` 由 W-DEPLOY 完成。

### W-PATHS（已合并 2026-09-28）

服务端输出的前端路径直接给出 `/admin` 最终地址（或仍在根部的控制台页面），不依赖旧路径 302。

| 文件 | Hn | 改动 | 原因 |
|---|---|---|---|
| backend/internal/service/claudex_web_paths.go（新增） | W-PATHS | 新增购买返回路径常量 /admin/my/purchase、默认登录后跳转 /admin/my/dashboard；ClaudexResolveLegacyPagePath / claudexResolveLegacyPageURL 通过 sitepaths.LegacyRedirect 把旧根路径控制台页面映射到最终 /admin 地址 | 控制台迁到 /admin，根路径归 Web 应用；服务端直接给出最终 URL，不依赖 Go 302 |
| backend/internal/service/payment_order.go | W-PATHS | paymentRedirectPathFromURL / normalizePaymentRedirectPath 默认值 /purchase → /admin/my/purchase；/payment?x → /admin/my/purchase?x；其他旧路径（含已存储的 /purchase?...）映射到 /admin | 支付返回页移到 /admin/my/purchase，旧存储值继续可用 |
| backend/internal/handler/auth_wechat_oauth.go | W-PATHS | wechatOAuthDefaultRedirectTo → /admin/my/dashboard，wechatPaymentOAuthDefaultTo → /admin/my/purchase；normalizeWeChatPaymentRedirectPath 同样映射旧路径 | 同上 |
| backend/internal/handler/auth_dingtalk_oauth.go、auth_oidc_oauth.go、auth_linuxdo_oauth.go、auth_email_oauth.go | W-PATHS | 默认登录后跳转常量 /dashboard → /admin/my/dashboard（gofmt 重新对齐相邻一行） | /dashboard 已是旧路径，改为最终地址 |
| backend/internal/service/notification_email_service.go | W-PATHS | runtimeVariables 中重写指向本站旧根路径控制台页面的 *_url 变量（相对路径或 frontend_url/api_base_url 主机的绝对 URL） | 提醒/通知邮件链接直接指向 /admin 最终地址 |
| backend/internal/service/claudex_web_paths_test.go（新增） | W-PATHS | 表驱动测试：服务端输出的每个前端路径经 sitepaths.Classify 必须是 ZoneConsole 或 ZoneConsoleRoot；旧值映射、邮件链接重写 | 防止路径落到 Web 应用区或依赖 302 |
| backend/internal/handler/claudex_web_paths_test.go（新增） | W-PATHS | 校验 handler 真实常量及 normalizeWeChatPaymentRedirectPath 输出 | handler 导入 service，service 测试只能镜像常量 |
| backend/internal/service/payment_order_result_test.go、backend/internal/handler/auth_wechat_oauth_test.go | W-PATHS | 期望值 /purchase → /admin/my/purchase | 上游测试断言旧路径，最小修改 |

### W-CONSOLE（已合并 2026-09-28）

控制台挂在 `/admin`，站点根目录归网页版。路径均相对 `backend/frontend/src`（`vite.config.ts`、`index.html` 在 `backend/frontend/`）。

| 文件 | 改动 | 原因 |
|---|---|---|
| `vite.config.ts`、`index.html` | `base: '/admin/'`，资源路径随 base | W-CONSOLE：控制台挂在 `/admin`，站点根目录归网页版 |
| `router/index.ts` | `createWebHistory('/')`；管理页 `/admin/*`，用户页 `/admin/my/*`，登录等 `/admin/*`，`reserved_paths.json` 的根页面留在根；无 `/` 路由；未知根路径 `window.location.replace('/')` 交给网页版，404 只在 `/admin` 下 | 与 W-SITE 的 SiteServer 路径划分一致 |
| `router/webConsole.ts`、`router/setupRedirect.ts` | 非管理员去 `/`（网页版），匿名去 `/admin/login`；待完成第三方登录时放行 `/admin/register`、`/admin/email-verify` | 控制台仅管理员，普通用户用网页版 |
| `api/client.ts`、`api/tokenRefresh.ts`、`stores/auth.ts` 及读 `auth_user` 的操作键工具 | 令牌读写改用 `api/authStorage.ts`（sessionStorage）；401 只在控制台路径下跳 `/admin/login` | 与网页版同源，缩小令牌暴露面（W-SRV 设计 4.3） |
| `views/auth/LoginView.vue` | 非管理员登录后登出控制台、提示并整页跳转 `/` | 同上 |
| `views/public/DesktopOnlyView.vue`、`i18n/{en,zh}/desktopOnly.ts` | 指向网页版和桌面端；新增 `useWebAppOrDesktop`、`openWebApp` | 同上 |
| 其余视图、组件、`App.vue`、`useRoutePrefetch.ts` | 写死的前端路径改为 `/admin`、`/admin/my` | 路由迁移 |

新增文件：

| 文件 | 说明 |
|---|---|
| `backend/frontend/src/api/authStorage.ts` | 控制台令牌存储（sessionStorage），一次性清理旧 localStorage 令牌 |
| `backend/frontend/src/router/__tests__/consolePaths.spec.ts` | 按 `sitepaths/reserved_paths.json` 校验控制台路由 |

已知问题：`pending_auth_session` 仍在 localStorage（第三方登录可能在另一个标签页完成）；令牌按标签页保存，新标签页需重新登录；推广链接 `/register?aff=` 走网页版注册，网页版需保留 `aff` 参数。

### W-AUTH（已合并 2026-09-28）

- `internal/handler/auth_handler.go`：W-AUTH 将 Register、SendVerifyCode、Login、Login2FA、ForgotPassword、ResetPassword 的核心逻辑抽取为 registerCore、sendVerifyCodeCore、loginCore、login2FAPrepare、login2FAFinish、forgotPasswordCore、resetPasswordCore，原处理器行为不变；Web 会话层通过适配器复用这些函数，保留 Turnstile、后端模式、2FA 与邮箱验证检查。
- `internal/handler/passkey_handler.go`：W-AUTH 抽取 Passkey 登录 begin/finish 的核心逻辑，供 Web 会话层调用，原接口行为不变。
- `internal/handler/wire.go`：W-AUTH 在 ProvideHandlers 中调用 core.SetWebAuthBackend 注册 Web 认证适配器。
- `internal/handler/claudex_webauth.go`（新增）：W-AUTH 适配器，实现 core.WebAuthBackend；2FA 期间的 OAuth 绑定返回 CLAUDEX_WEB_OAUTH_BIND_UNSUPPORTED。
- `migrations/claudex_0080_web_sessions.sql`（新增）：W-AUTH 新增 claudex_web_sessions 表，记录 Web 会话族（不存储令牌），支持每用户上限、列表与撤销。
- 部署说明：Web 应用建议将 jwt.access_token_expire_minutes 设为 60；本次未修改默认值。
- `internal/claudex/core/webauth.go`（新增）：W-AUTH 定义 WebAuthBackend、SetWebAuthBackend/WebAuth 与 WebAppConfig 接缝。
- `internal/claudex/web/`（新增 auth、csrf、store、tickets、settings、admin、user、component）：`/api/v1/claudex/web/auth/` 下 13 个 POST 路由；刷新 Cookie `__Secure-claudex_web_rt`（HttpOnly、Secure、SameSite=Strict）；CSRF 要求 `X-Claudex-Web: 1` 与同源 Origin；事件票据单次使用；管理设置 `claudex_web`（修改需二次验证与 revision）。
- `internal/claudex/module.go`：W-AUTH 将 SessionRevoker 改为链式（设备 + Web），错误合并返回。
- `internal/server/routes/claudex_route_coverage_test.go`：W-AUTH 登记 13 个公开路由并校验 CSRF 保护。
- 已知问题：revoke-all 与 events-ticket 只校验 JWT，未做上游会话绑定检查；无 Redis 时限流不生效、票据退回内存（仅单节点）。

### W-KEY（已合并 2026-09-28）

- 没有改上游文件。`internal/claudex/devices/`：每用户一行 `platform='web'` 受管设备（`EnsureWebKey`/`RevokeWebKey`，`web_device.go`），不计入 5 台设备上限；revoke-all 跳过网页行（网页会话由 web 组件登出，运行中的回合不中断）；用户自己的设备列表不显示网页行。
- `internal/claudex/web/usage/`（新增组件 web-usage）：只对网页 Key 读取并移除 `X-Claudex-Conversation`/`X-Claudex-Web-Session` 头，按请求写 `claudex_web_usage_links`；运行名额（每用户、全局）不足时返回 503 `CLAUDEX_WEB_CAPACITY`；runner 时长记入 `claudex_web_runner_usage`（只记录不计费）；设置 `claudex_web_usage`。
- `migrations/claudex_0082_web_usage.sql`（新增）。
- 已知问题：请求 id 对不上时按该 Key 最近的对话归属用量；运行名额在进程内存中（单实例）。

### W-STORE（已合并 2026-09-28）

- 没有改上游文件。`internal/claudex/webstore/`：网页版的项目、对话、按回合 JSONB、Artifact（保留 20 版）、设置、文件（按用户配额 1 GB、单文件 30 MB，磁盘目录 `$CLAUDEX_WEB_STORE_DIR` 或 `$DATA_DIR/claudex-web/files`）、搜索、导出、分享快照；runner 通过 `ServeRunnerOp` 读写；浏览器只读下载与导出路由；每小时清理。
- `migrations/claudex_0081_web_store.sql`（新增）。
- 已知问题：配额字段尚未进入 `claudex_web` 管理设置（W-ADMIN1）；分享暂走 runner 复用的桌面分享处理器。

### W-VOICE（已合并 2026-09-28）

- 没有改上游文件。网页听写：`POST /api/v1/claudex/web/auth/voice-ticket` 签发 30 秒一次性票据（绑定用户与网页会话，只存哈希）；`internal/claudex/gatewayhook/preauth.go`（新增）在 API Key 校验前把 `Sec-WebSocket-Protocol` 里的票据换成该用户的网页 Key，之后与桌面端走同一计量、用量规则与计费。`internal/claudex/voice/web_ticket.go`（新增）、`internal/claudex/web/gate.go`（新增）。
- 已知问题：`EnsureWebKey` 用默认分组；voice-ticket 只有通用限流；nginx 需原样透传 WebSocket 升级与 Origin。

### W-RELAY（已合并 2026-09-28）

- 没有改上游文件。`internal/claudex/webhost/`：网页 RPC `/api/v1/claudex/web/rpc/:method`（只转发 runner 在 hello 里声明的方法，单用户并发与超时、运行名额）、事件 WebSocket `/api/v1/claudex/web/events`（一次性票据走 Sec-WebSocket-Protocol，按用户编号，2000 条环形缓冲续传，否则发快照）、runner 连接 `/api/v1/claudex/web/runner/link`（令牌存哈希；本机 runner 只接受回环直连）、用户与 runner 的亲和（存库）、分块上传、带 5 分钟签名的 Artifact 预览代理（强制 sandbox CSP、frame-ancestors 'self'）、runner 管理接口（写操作需二次验证）。`internal/claudex/web/access.go`（新增 `CheckWebAccess`）。
- `migrations/claudex_0090_runners.sql`（新增）。
- 已知问题：单个网页会话登出不会立刻断开它的事件连接（1 小时上限、每分钟复查）；事件环与运行跟踪在单实例内存中；每次 RPC 写一条审计记录。
### LOGIN 公开页外观（2026-09-28）

终端用户能打开的公开页改用登录页的样式（左上星芒 + 衬线字标、居中衬线标题、圆角卡片；暂定，无参考截图）。路径相对 `backend/frontend/src`。

| 文件 | 改动 | 原因 |
|---|---|---|
| `views/public/DesktopOnlyView.vue`、`views/public/DesktopCheckoutView.vue` | 由 `AuthLayout` 改为 `ClaudexPublicLayout`，行为与 data-testid 不变 | 与登录页一致 |
| `views/auth/ResetPasswordView.vue` | 改用 `ClaudexPublicLayout`；重置成功后的 Sign in 与页脚登录链接指向 `/`（网页版），另留管理员控制台登录链接 `/admin/login`；失败信息也显示在卡片内 | 邮件链接落地页给终端用户 |
| `views/user/PaymentResultView.vue` | 控制台仅限管理员且访问者不是已登录管理员时用公开外框（去掉控制台充值/订单按钮，改为打开网页版与返回 Claudex 提示）；明细行抽成 `detailRows`，控制台外框不变 | 公开结果页 |
| `views/public/LegalDocumentView.vue` | 外框改为 `ClaudexPublicLayout`（document 变体），去掉站点 Logo 与控制台登录按钮；Markdown 正文样式不变 | 同上 |
| `i18n/locales/{en,zh}/index.ts` | 展开 `claudexPublic` | 新文案 |

新增：`components/layout/ClaudexPublicLayout.vue`、`components/layout/claudexPublic.css`（令牌只作用于 `.cx-public`）、`i18n/locales/{en,zh}/claudexPublic.ts`、`views/auth/__tests__/ResetPasswordView.spec.ts`。Go：`internal/claudex/sharing/render.go` 内置渲染器的页头（星芒 + 衬线字标）与提示页（404/410/503 等）外观，`viewer/templates/page.{tmpl,css}` 的页头与状态页外观；CSP 与快照内容渲染不变。

### LOGIN 邮箱验证码登录与登录页选项（2026-09-28）

| 文件 | 改动 | 原因 |
|---|---|---|
| `internal/handler/auth_handler.go` | `loginCore` 在密码校验之后的检查（Backend 模式、TOTP 挑战、记录登录）原样抽成 `loginAfterFirstFactor`（`CLAUDEX: LOGIN` 标记），行为不变 | 邮箱验证码登录复用同一组检查 |
| `internal/handler/claudex_webauth.go` | 适配器加 `CodeLogin`（活跃检查 + `loginAfterFirstFactor`）与 `RespondLogin`（上游 `respondWithTokenPair`） | 桥接给 `internal/claudex/signin` |
| `cmd/server/wire_gen.go` | `claudex.Deps` 加 `Email: emailService` | 发信（Wire 重新生成） |

新增：组件 `internal/claudex/signin/`（设置 `claudex_sign_in`；`GET /api/v1/claudex/sign-in/options`、
`POST /api/v1/claudex/auth/email-code/{send,login}`、`GET|PUT /api/v1/admin/claudex/sign-in`），`core.Deps.Email`、
`core.EmailCodeSignIn`/`FindEmailCodeSignIn`、`core.WebAuthBackend.CodeLogin`/`RespondLogin`、`core.NameSignIn`；
`internal/claudex/web/auth.go` 网页包装路由 `web/auth/email-code/{send,login}`；`webproto.AuthEmailCode{Send,Login}`、
`AuthPasskey{Begin,Finish}`（`testdata/constants.json`、`shared/web-protocol.ts` 同步）。前端（相对 `backend/frontend/src`）：
`api/admin/claudex/signIn.ts`、`components/admin/claudex/general/SignInSettingsCard.vue`（General 页新卡片）、
`i18n/locales/{en,zh}/admin/claudexGeneral.ts` 的 `signIn` 文案。没有新迁移。

### W-ADMIN1：控制台“Web app”页

新增：迁移 `claudex_0092_runner_disable.sql`（`claudex_web_runners.disabled_at`）；`internal/claudex/webhost`：
`PATCH /api/v1/admin/claudex/web/runners/:id`（改名、停用/启用，step-up），`RunnerDirectory.Update`，停用的令牌不能接入，
runner 列表多 `disabled`、`disabled_at`。前端（相对 `backend/frontend/src`）：`api/admin/claudex/web.ts`、
`views/admin/claudex/ClaudexWebView.vue`、`components/admin/claudex/web/*`、`i18n/locales/{en,zh}/admin/claudexWeb.ts`；
`router/claudex.ts` 加 `/admin/claudex/web` 与侧栏项，`api/admin/claudex.ts`、`i18n/locales/{en,zh}/admin/index.ts`、
`i18n/__tests__/localesNoKeyCollision.spec.ts`、`AppSidebar.claudex.spec.ts`、`common/__tests__/common.spec.ts`（页面数 10）同步。
页面用的其余接口（`web/settings`、`web/usage/settings`、`web/runners` 的 GET/POST/DELETE/drain）在此之前已存在。
### W-GITHUB 网页版 Code 的 GitHub 连接（2026-09-29）

不改上游文件（只加 Claudex 文件）。新增：组件 `internal/claudex/ghconn/`（名称 `github`，`core.NameGitHub`；设置 `claudex_github`，
客户端密钥用 `core.SecretBox` 加密、只写；`GET|PUT /api/v1/admin/claudex/github`；用户路由 `GET|DELETE /api/v1/claudex/web/github`、
`POST .../connect`、`GET .../repos`、`GET .../branches`；公开路由 `GET .../web/github/callback`，靠一次性 state（只存 SHA-256）与 PKCE 绑定用户），
迁移 `claudex_0093_gh_connections.sql`（`claudex_github_connections`、`claudex_github_oauth_states`，令牌密文存储）。runner 链路新增
`github.clone` 请求（`webproto.OpGitHubClone`，`IsUserOp` 覆盖 `github.` 前缀，`webhost.Backends.GitHub`），返回单次克隆用的短期凭据，不落库、不进日志。
`internal/server/routes/claudex_route_coverage_test.go` 的公开路由名单加入回调；`module_test.go` 组件数 +1。前端（相对 `backend/frontend/src`）：
`api/admin/claudex/github.ts`、`views/admin/claudex/ClaudexGitHubView.vue`、`components/admin/claudex/github/githubForm.ts`、
`i18n/locales/{en,zh}/admin/claudexGitHub.ts`，路由与侧栏项 `/admin/claudex/github`。

### 尚未合并（计划，以合并后的代码为准）

- W-VOICE（`internal/claudex/voice/web_ticket.go`）、W-CLOUD、W-GITHUB、W-ADMIN1/W-ADMIN2（控制台页面）、W-DEPLOY
  （`backend/Dockerfile`）。这些包合并后在本节补上各自的上游文件、`CLAUDEX:` 标记与迁移。

### SMTP-ENV 邮件发信读取 CLAUDEX_SMTP_* 环境变量（Resend）

`internal/service/email_env.go`（新）与 `email_service.go`（`GetSMTPConfig` 在控制台没有 SMTP 主机时回退到环境变量）：读取 `CLAUDEX_SMTP_TYPE`（qq 默认 / 163 / 126 / gmail / outlook / aliyun / custom）、`CLAUDEX_SMTP_FROM`、`CLAUDEX_SMTP_USERNAME`、`CLAUDEX_SMTP_PASSWORD`、`CLAUDEX_SMTP_HOST`、`CLAUDEX_SMTP_PORT`、`CLAUDEX_SMTP_USE_SSL`、`CLAUDEX_SMTP_USE_STARTTLS`、`CLAUDEX_SMTP_FROM_NAME`。生产环境通过 Resend 的 SMTP 发信（smtp.resend.com:465，用户名 resend，密码为 Resend API Key）；管理员在控制台保存的 SMTP 设置优先。邮件验证码、找回密码、订阅到期提醒、分享邀请都走这一路。

`internal/pkg/wscompat`（新）：面向客户端的 WebSocket 握手（`webhost/events.go` 的事件流、`handler/claudex_openai_audio.go` 与 `handler/grok_audio.go` 的语音）不再协商 permessage-deflate。coder/websocket v1.8.14 输出的压缩帧，苹果的 URLSessionWebSocketTask 和 WebKit（Safari）收到较大消息时会报 Protocol error 并断开（#54）。连上游的连接仍按原设置协商压缩。

### WEB-ACCOUNTS 一个浏览器登录多个账号（2026-10-12）

`internal/claudex/web/accounts.go`（新）、`auth.go`、`csrf.go`、`webproto/protocol.go`：每个账号有自己的刷新 Cookie `__Secure-claudex_web_rt_<用户 id>`（属性同原 Cookie）；refresh 与 logout 的请求体可带 `{"account":"<id>"}` 只动该账号的 Cookie；旧的 `__Secure-claudex_web_rt` 仍可读取，下次刷新时迁到账号 Cookie；新增 `POST /api/v1/claudex/web/auth/accounts`（CSRF 保护，只返回浏览器自己带来的账号 id 与上限 5）；同一浏览器超过 5 个账号时登录返回 409 `CLAUDEX_WEB_ACCOUNT_LIMIT`；没有访问令牌的 logout（“从此设备移除”）通过最后一次轮换找到会话族后整族撤销。未改动上游文件，无新表。

### LOGIN-GOOGLE 使用 Google 登录（2026-10-15）

`internal/claudex/signin/google.go`（新）：公开路由 `POST /api/v1/claudex/auth/google/login`，网页版的 Cookie 会话路由 `POST /api/v1/claudex/web/auth/google/login`（`webproto.AuthGoogleLogin`，`internal/claudex/web/auth.go`）。网页用自己的按钮调起 Google Identity Services 的授权码弹窗，传 `{code, redirect_uri: "postmessage"}`，服务端用网页客户端密钥换取 ID token（也仍接受 `{id_token}`）；桌面传 PKCE 授权码 `{code, code_verifier, redirect_uri}`（只接受回环地址），由服务端用桌面客户端密钥换取 ID token。ID token 交给 Google tokeninfo 校验，再核对 aud（本服务的客户端）、iss、exp 与 `email_verified`；账号按上游“已验证邮箱的 OAuth 身份”规则查找或创建（注册开关、邮箱策略、`auth_identities` 绑定，provider `google`），最后走 `core.WebAuth().CodeLogin`，TOTP、后台模式与登录记录照常生效。登录选项 `GET /api/v1/claudex/sign-in/options` 增加 `google_client_id`（配置了网页密钥才返回）、`google_desktop_client_id`（后台模式下都不返回）。配置来自环境变量 `CLAUDEX_GOOGLE_WEB_CLIENT_ID`、`CLAUDEX_GOOGLE_WEB_CLIENT_SECRET`、`CLAUDEX_GOOGLE_DESKTOP_CLIENT_ID`、`CLAUDEX_GOOGLE_DESKTOP_CLIENT_SECRET`（密钥只在服务器）。

上游文件：`internal/service/auth_email_oauth_auto.go`（拆出 `ResolveVerifiedEmailOAuthUser`，原 `LoginOrRegisterVerifiedEmailOAuth` 行为不变）、`internal/handler/claudex_webauth.go`（`OAuthUser`）、`internal/claudex/core/webauth.go` 与 `emailcode.go`（接口 `OAuthUser`、`GoogleSignIn`）、`internal/server/middleware/security_headers.go`（网页区 CSP 只放行 `https://accounts.google.com/gsi/` 的脚本、样式、连接与框架；COOP 改为 `same-origin-allow-popups`，Google 登录弹窗需要），测试同步。

### 流在首个 token 前断开时换账号

- `internal/service/openai_gateway_chat_completions.go`：上游流在任何内容到达客户端之前断开（没有终止事件），返回 `UpstreamFailoverError`（502），请求换到分组里的其他账号，和连接被拒一样处理；已经开始输出时仍报 “missing terminal event”。
- `internal/service/openai_gateway_chat_completions_test.go`：`TestForwardAsChatCompletions_DoneSentinelWithoutTerminalReturnsError` 改为期望换账号（`CLAUDEX:` 标记）。

### 不内置 Google OAuth 客户端

- `internal/pkg/geminicli/constants.go`、`oauth.go`：内置 Gemini CLI 客户端的 client_id 与 client_secret 都不写在仓库里，分别来自 `GEMINI_CLI_OAUTH_CLIENT_ID`、`GEMINI_CLI_OAUTH_CLIENT_SECRET`；缺任何一个都报 `GEMINI_CLI_OAUTH_CLIENT_SECRET_MISSING`。
- `internal/pkg/antigravity/oauth.go`：`ClientID` 来自 `ANTIGRAVITY_OAUTH_CLIENT_ID`，默认 secret 为空（`ANTIGRAVITY_OAUTH_CLIENT_SECRET`）；新增 `CheckClientConfigured`。`internal/service/antigravity_oauth_service.go` 的 `GenerateAuthURL` 先检查客户端是否配置。
- 部署文件（`deploy/docker-compose*.yml`、`.env.example`、`config.example.yaml`、`README.md`）加上两个 `*_CLIENT_ID` 变量。
- 测试：`claudex_test_client_test.go`（两个包）与 `internal/service/claudex_google_test_clients_test.go` 用替身 client id；`antigravity/oauth_test.go` 的常量用例、`geminicli/oauth_test.go` 的内置回退用例改为环境变量行为（`CLAUDEX:` 标记）。

### 跟上 Claudex 行为的上游测试

- `internal/service/email_html_escape_test.go`：Claudex 改版的邮件把站点名放在页头单元格，改为检查 `>站点名</td>`。
- `internal/service/openai_gateway_messages_failed_response_test.go`：首个 token 前的 `server_error` 现在会换账号（`openAIStreamTransportErrorMarkers`），“通用错误不被换账号掩盖”的用例改用 `api_error`。
