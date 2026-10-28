# Claudex for iOS

A native SwiftUI client for a Claudex service. Sign-in, the composer, transport,
approvals and navigation are native; conversations and documents render with
the same React components the desktop and web apps use, bundled under
`Claudex/Resources/SharedConversation`.

## Requirements

- Xcode 26 or newer (iOS 17.0 deployment target)
- A Claudex service to connect to

## Build and run

1. Set the service address: `CLAUDEX_SERVICE_URL` in the target's build
   settings (an HTTPS origin, no path). The default,
   `https://claudex.example.com`, is a placeholder.
2. Open `Claudex.xcodeproj`, pick the `Claudex` scheme and an iPhone simulator,
   and run. The simulator needs no signing team.
3. For a device, choose your own team under Signing & Capabilities and change
   the bundle identifier (`com.example.claudex`).

The project file is generated; after adding or removing source files run:

```sh
python3 scripts/generate_project.py
```

## Shared conversation bundle

The conversation view is built from the repository's front-end:

```sh
npm run build:mobile-conversation          # from the repository root
python3 scripts/sync_shared_conversation.py
python3 scripts/generate_project.py
```

`shared-conversation-lock.json` records the bundle's checksums; the build
verifies them.

## Tests

Portable core tests (macOS or Linux, Swift 6):

```sh
swift test
```

All tests on a simulator:

```sh
xcodebuild -project Claudex.xcodeproj -scheme Claudex \
  -destination 'platform=iOS Simulator,name=iPhone 17e' \
  test CODE_SIGNING_ALLOWED=NO
```

## Service requirements

The app uses the service's existing auth, RPC, upload and WebSocket endpoints,
plus `POST /api/v1/claudex/mobile/events-ticket` for live events. Without that
route sign-in and reading work, and the app says live updates are unavailable.
