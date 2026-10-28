# Claudex for Android

A native Kotlin / Jetpack Compose client for a Claudex service. Sign-in, the
composer, transport, approvals and navigation are native; conversations and
documents render with the same React components the desktop and web apps use,
bundled under `app/src/main/assets/conversation`.

## Requirements

- JDK 17 or 21, Android SDK platform 36, build tools 35
- A device or emulator on Android 8.0 (API 26) or later
- A Claudex service to connect to

## Build

```sh
./gradlew :app:assembleProductionDebug -PclaudexOrigin=https://claudex.example.com
```

`claudexOrigin` is the service's HTTPS origin; the default is a placeholder.
The APK lands in `app/build/outputs/apk/production/debug/`.

A signed release build reads the keystore from Gradle properties kept outside
the repository (for example in `~/.gradle/gradle.properties`):

```properties
claudexReleaseStoreFile=/path/to/release.jks
claudexReleaseStorePassword=…
claudexReleaseKeyAlias=…
claudexReleaseKeyPassword=…
```

```sh
./gradlew :app:assembleProductionRelease -PclaudexOrigin=https://claudex.example.com
```

The `demo` flavor runs on local sample data without a service.

## Tests

```sh
./gradlew :core:test :app:testProductionDebugUnitTest
./gradlew :app:lintProductionDebug
python3 scripts/check-design-contract.py
```

Instrumented tests (`app/src/androidTest`) need a device or emulator:

```sh
./gradlew :app:connectedProductionDebugAndroidTest
```

## Shared conversation bundle

The conversation view is built from the repository's front-end and checked in
with a lock file, so the app builds without Node:

```sh
npm run build:mobile-conversation          # from the repository root
python3 scripts/import-shared-conversation.py \
  --source-revision "$(git rev-parse HEAD)" \
  --manifest-sha256 "$(shasum -a 256 ../../dist-mobile-conversation/reuse-manifest.json | cut -d' ' -f1)" \
  ../../dist-mobile-conversation
```

Gradle verifies the bundle against `shared-conversation-lock.json` before
packaging. Don't edit the generated files by hand.
