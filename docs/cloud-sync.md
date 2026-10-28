# 桌面端与网页同步：云端对话、协作与 GitHub 代码

设计要点：

- 对话（Chat）和协作（Cowork）在桌面端也改为**在云端运行并同步**，桌面端与网页看到同一份列表、同一份对话；协作模式只保留云端，桌面端不再直接操作本机文件夹（文件以附件方式进入云端工作区）。
- 代码（Code）模式：选 **GitHub 仓库**作工作目录时在云端运行并同步；选本机文件夹时照旧在本机运行、不同步。
- **每个对话（Chat）、每个协作任务、每个 GitHub 仓库工作区各自隔离**（互相看不到对方的文件）。
- 桌面端本机已有的对话与协作记录**迁移到云端**。

## 1. 总体做法

网页版是“runner 运行、webstore 存储、runner 是唯一写入方”（见 `docs/architecture.md`）。同步不另造一套：**桌面端对云端会话也做 runner 的客户端**，和浏览器走同一套协议（RPC `/api/v1/claudex/web/rpc/:method`、事件 WS `/api/v1/claudex/web/events`），数据仍只有 runner 一个写入方，不存在两边各写一份再合并的冲突。

```
桌面端 Electron 主进程
  ├─ 本机：Engine（本机文件夹的 Code 会话）+ Store（profiles/<账号>/）
  └─ CloudClient（新）：网页会话 → RPC / 事件 WS → Go → runner link → 该用户的 WebAppContext
        对话、协作、GitHub 代码会话，以及它们的项目、Artifact、文件
渲染进程：仍只调用 window.desktop；主进程按会话所在位置分流，并把云端列表并入 Snapshot
```

选主进程分流而不是在渲染进程里再装一个网页桥，是因为渲染进程目前只认一个 `window.desktop` 和一份 Snapshot，改在主进程合并时界面代码基本不用动。

## 2. 分阶段

| 阶段 | 内容 | 主要位置 |
| --- | --- | --- |
| P1 隔离 | runner 上每个对话、每个协作任务、每个 GitHub 仓库工作区是一个独立“空间”：各自一个沙箱进程（codex app-server），只挂载自己的目录和自己的 codex-home（见第 3 节）。复用 `EngineRegistry` 的多环境与空闲回收（原用于 SSH 环境）。 | `runner/src/web-app-context.ts`、`code-workspace.ts`、`sandbox/driver.ts`、`electron/engine-registry.ts` |
| P2 凭据（不需要新接口） | 网页的 RPC、上传和事件票据走用户 JWT 路由，接受任何有效的账号访问令牌，网页模型密钥按用户发放（会话只用于吊销检查）。所以桌面端直接用自己已登录的账号令牌（`RemoteSession`，自带刷新）连云端；“登出所有设备”和吊销桌面会话同样让它失效。曾实现过“桌面令牌换网页会话”的接口（a8a7a98d），因多出一个签发长期凭据的接口而撤回。 | `electron/sub2api/session.ts` |
| P3 CloudClient（已实现） | 主进程里的云端客户端：直接运行网页桥的传输层、编码与事件流（`src-web/bridge` 的 `WebTransport`、`encodeCall`、`EventStream`：RPC、401 刷新、事件 WS 的 seq 去重与断档 resync、分块上传），凭据换成桌面端账号会话（`RemoteSession.currentToken`/`renewed`）。 | `electron/cloud/cloud-client.ts` |
| P4 分流与合并（已实现） | `electron/cloud/cloud-router.ts` 挡在每个 IPC 处理函数前（main.ts `handle`）：带会话 id 的调用按会话所在位置分流；新会话中 Chat（不在本机项目里、非无痕）、Cowork、选了仓库的 Code 去云端，附件先上传到云端；Snapshot 合并本机与云端的会话、项目和待批准（云端批准 id 加 `cloud:` 前缀）；云端的会话与批准事件只发给窗口。云端不通时显示本机部分加上次的云端列表，稍后重读。设置 → 通用 → 同步 → “与网页同步”（默认开）。Code 首页 Local ▾ › Cloud › Default 切到仓库选择；同步开着时协作不再提供本机文件夹。 | `electron/cloud/**`、`src/composer/code-cloud.ts`、`CloudWorkspaceBar.tsx`、`CoworkOptions.tsx`、`settings/tabs/General.tsx` |
| P5 迁移（已实现） | 同步开着、云端第一次答出 Snapshot 后，本机的对话与协作会话（非无痕、有内容、没在运行、云端没有的）从旧到新逐个经 runner 的 `importConversation`（`cloud-sync` 域，只有 runner 能执行）连同项目和 Codex 线程记录（rollout，≤30 MB）写入 webstore；runner 给它一个自己的空间 `c-<会话 id>`，rollout 放进该空间的 codex-home，下一条消息在云端接着这个线程（实测：只复制 rollout 文件即可 thread/resume）。本机不删除任何记录：云端副本同 id，合并列表只显示云端那份；已迁移的记在 `cloud-moved.json`，网页上删掉的不会被本机再传上去；失败的下次启动重试。 | `electron/cloud/migrate.ts`、`electron/ipc/cloud-sync.ts`、`shared/cloud-sync-api.ts` |
| P6 发版 | 测试、0.0.6 构建与发布。 | |

每个阶段单独提交、可单独上线：P1 只影响网页版云端会话；P3–P5 在桌面端打开一个开关后才生效，开关默认关，P5 验证完再默认开。

## 3. 隔离（P1）细节（已实现，2026-10-03）

- 空间：新会话的 `send` 由 runner 的调度器（`runner/src/dispatcher.ts` 的 `newSession`）分配环境 `{kind: "space", spaceId}`：Chat、Cowork 每个会话一个（`c-<uuid>`），Code 选了 GitHub 仓库时按仓库地址一个（`r-<地址哈希>`，同一仓库的会话共用，各自有会话目录），Code 没选仓库时每个会话一个（`s-<uuid>`）。窗口自己传的环境只能是 `local`（`method-guard.ts`），空间只由 runner 设置。
- 目录：`<用户数据>/profile/spaces/<空间 id>/{workspace,codex-home}`；附件与项目知识库只读挂入。Code 会话目录在空间的 `workspace/code/<会话>` 下。
- 进程：每个空间一个沙箱（`space-<用户>-<空间 id>`，gVisor）和它自己的 codex app-server；`EngineRegistry` 按需启动，空闲 15 分钟停止；同一用户同时最多 3 个，满了时最久未用的空闲空间让位，全都在忙则提示稍后再发。
- 旧会话（没有 `environment` 的）照旧在用户共用的沙箱里运行，不迁移，以免丢失 Codex 线程。
- 云端对话和协作都依赖 runner 在线；空间上限和空闲回收用来控制 runner 主机的负载。

## 4. 不做 / 暂不做

- 本机文件夹的代码会话不上云、不同步。
- 两边同时编辑同一条消息不做合并：写入方只有 runner，后到的操作基于 runner 的最新状态（与网页多标签同一规则）。
- 离线：云端会话在断网时只读显示缓存，发送按钮提示网络不可用；不做离线排队发送。
