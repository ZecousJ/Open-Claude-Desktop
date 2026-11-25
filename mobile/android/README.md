# Claudex Android

Claudex 原生 Android 客户端（Kotlin / Jetpack Compose / Material 3），支持对话、项目、Code 会话、作品预览、远程设备控制、附件直传与实时事件流。

## 环境要求

- JDK 17 或 21
- Android SDK Platform 36（`minSdk = 26`，Android 8.0+）
- Android Studio（或命令行 Gradle）

## 构建与测试

```sh
cd mobile/android

# 运行核心模块与 App 单元测试
./gradlew :core:test :app:testProductionDebugUnitTest

# 构建 Debug APK
./gradlew :app:assembleProductionDebug
```

产物位于 `app/build/outputs/apk/production/debug/app-production-debug.apk`。

## 配置自建服务地址

默认指向演示/托管服务地址，自建部署时通过 Gradle 属性覆盖 `claudexOrigin`（仅允许 `https://` 根地址）：

```sh
./gradlew :app:assembleProductionDebug -PclaudexOrigin=https://your-claudex.example
```

## Release 签名

签名密钥与密码不包含在仓库内。打包正式版时在 `~/.gradle/gradle.properties` 或命令行传入：

```sh
./gradlew :app:assembleProductionRelease \
  -PclaudexOrigin=https://your-claudex.example \
  -PclaudexReleaseStoreFile=/path/to/release.keystore \
  -PclaudexReleaseStorePassword=... \
  -PclaudexReleaseKeyAlias=... \
  -PclaudexReleaseKeyPassword=...
```

## 共享对话渲染资源

`app/src/main/assets/conversation/` 包含与 Web/桌面端一致的预构建对话渲染资源，以及 `shared-conversation-lock.json` 校验清单，无需在构建 Android 时额外安装 Node.js。更新共享渲染资源请使用 `scripts/import-shared-conversation.py`。
