# ZecousAI → Claudex 桥接程序（ZecousAI 1.0.31）

ZecousAI 桌面端的下一次更新。它不是 ZecousAI 本身，而是一个很小的 Electron 程序（productName `ZecousAI`、exe `ZecousAI.exe`、版本 1.0.31）：启动后显示 “Updating to Claudex…”，下载（或使用内嵌的）Claudex Windows 安装包、校验构建时写入的 SHA-256、静默安装（`/S /currentuser`）、写入 Claudex 的 `backend/sub2api.json`（服务地址见 `shared/claudex-service.ts`）和登录邮箱提示（只从 ZecousAI 令牌载荷里的 email 声明取，绝不复制令牌），启动 Claudex，最后移除 ZecousAI：

- Squirrel 安装：进程退出后 detached 运行 `..\Update.exe --uninstall`（触发 `--squirrel-uninstall` 钩子，删除快捷方式）。
- 老 NSIS 安装：ZecousAI 的更新脚本以 `/S /NORESTART /currentuser /D=<目录>` 运行本程序；`/D` 不用于安装，只用来确定要删除的旧目录（必须含 ZecousAI.exe，且不是盘符根目录、用户目录、系统目录或 Claudex 目录），连同桌面与开始菜单快捷方式，在退出后由 cmd 延时删除。

纯逻辑在 `src/logic.ts`，由仓库的 `tests/zecous-bridge.test.ts` 测试。

## 构建（Windows x64，Node 24）

```bat
cd tools\zecous-bridge
set CLAUDEX_VERSION=0.0.2
set CLAUDEX_INSTALLER_URL=https://all.zecous.cn/zecous/downloads/Claudex-Setup-0.0.2.exe
set CLAUDEX_INSTALLER_SHA256=<scripts/release 输出的 sha256>
node build.mjs
```

或者内嵌安装包：`node build.mjs --embed <Claudex-Setup-x.y.z.exe> --claudex-version x.y.z`。`build.mjs` 会带重试地 `npm install`（网络不稳时最多 5 次），`--skip-install` 跳过；`--dry-run` 只打印并写出 `dist/bridge-config.json`（任何平台可用）。

产物在 `out/`：`squirrel/RELEASES` + `squirrel/ZecousAI-1.0.31-full.nupkg`（Squirrel 更新源），`ZecousAI-Setup-1.0.31.exe`（老 NSIS 用户）。随后用 `scripts/release/publish.mjs --bridge out` 上传并生成 ZecousAI 的 `desktop_update_releases` 记录，完整顺序见 `docs/ota.md`。

未在 Windows 实机验证：electron-builder portable 目标对命令行参数与退出码的透传、Squirrel `--uninstall` 在桥接进程退出后的行为。发布前必须按 `docs/ota.md` 的测试机步骤验证。
