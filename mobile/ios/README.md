# Claudex iOS

Claudex 原生 iOS 客户端（Swift / SwiftUI），包含主应用、Share Extension 与 Widget Extension，支持对话、项目、Code 会话、作品预览、远程设备控制、附件直传与实时事件流。

## 环境要求

- Apple Silicon Mac + Xcode（最低部署目标 `iOS 17.0`）
- Swift 6.0+（运行纯 Swift 核心测试）

## 打开与运行

1. 使用 Xcode 打开 `mobile/ios/Claudex.xcodeproj`，选择 `Claudex` scheme。
2. 选择 iPhone Simulator 即可直接运行（模拟器运行无需配置签名团队）。
3. 真机运行请在 `Signing & Capabilities` 中选择你自己的 Apple Developer Team，并按需修改 `PRODUCT_BUNDLE_IDENTIFIER`（仓库不包含任何证书、私钥或描述文件）。

## 配置自建服务地址

在 Xcode 的 Target `Build Settings` 中修改 `CLAUDEX_SERVICE_URL`（仅允许 `https://` 根地址，不含路径与查询参数），例如：

```text
https://your-claudex.example
```

## 运行测试

运行跨平台核心单测（不依赖模拟器）：

```sh
cd mobile/ios
swift test
```

在 macOS 上通过 `xcodebuild` 运行完整测试：

```sh
xcodebuild -project Claudex.xcodeproj -scheme Claudex \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -derivedDataPath DerivedData test CODE_SIGNING_ALLOWED=NO
```

## 重建 Xcode 工程

增删 Swift 源文件后，可使用内置脚本重建 `Claudex.xcodeproj`（无需额外安装 XcodeGen/Tuist）：

```sh
python3 scripts/generate_project.py
```
