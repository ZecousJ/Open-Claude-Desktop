# Releasing the desktop app

The desktop app updates itself in two ways: whole **installers** when the
main process, native code or Electron changes, and signed **interface packs**
when only the window's front end changed. Both are announced by the server's
release settings (`claudex_client_release`, edited on the admin console's
release page or through `PUT /api/v1/admin/claudex/release`).

## Installers

1. Set the version in `package.json` and build signed installers on each
   platform (see [building.md](building.md)):

   ```sh
   npm run package:mac
   npm run package:win
   npm run package:linux
   ```

2. Upload them and print the release entry. The tooling uploads to
   S3-compatible storage (written for Cloudflare R2); it is a dry run without
   `--upload`:

   ```sh
   export CLAUDEX_DOWNLOADS_PREFIX=downloads          # key prefix in the bucket
   export CLAUDEX_DOWNLOAD_BASE=https://claudex.example.com/downloads
   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=… \
     npx tsx scripts/release/publish.ts --claudex release --notes notes.md --upload
   ```

   For Windows, `scripts/release/app-pack.ts` also builds the app pack: the
   app's own files without Codex, so most Windows updates replace only those
   instead of running a new installer.

3. Paste the printed `claudexRelease` JSON into the console's release page.
   Clients see it at their next check.

4. Once the new version is live, remove the old files:
   `npx tsx scripts/release/prune.ts --version <old> --delete`.

### What the app does with a release

- It checks about 90 seconds after start and then every few hours
  (`desktop_updater_config` in the release tunes this), and from **Check for
  Updates…** in the menu.
- It installs only a newer version, only over HTTPS, and only with a SHA-256
  in the release (`shared/app-update.ts`). The download resumes after a
  dropped connection and is checked against the hash.
- A finished download shows **Relaunch to update**. Quitting installs it too;
  with no work running and every window in the background it can also restart
  by itself after a while (`CLAUDEX_DISABLE_STEALTH_UPDATES=1` turns that off).
- Before installing, macOS checks the new app's Developer ID and Team ID and
  Gatekeeper; Windows checks the Authenticode publisher. An update signed by
  someone else is refused.
- A version that fails to install twice is skipped until the next manual
  check.

### Channels and test releases

The release settings hold channels: `stable`, plus any channel named by a
UUID. A machine follows a UUID channel when
`<user data>/update-policy.json` says so:

```json
{ "channelUuid": "6f1c…" }
```

To test a release, publish it to a new UUID channel, point a test machine
at it, let it update, then move the release to `stable` and delete the test
channel. The same file can also set `maxVersion`, `updatesHost` (another
Claudex server to check), `enforcementHours` and `disableAutoUpdates`; see
`electron/updates/`.

## Interface packs

The window loads its front end from `claudex-app://ui/<version>/`: either a
downloaded, verified pack in `<user data>/ui-packs/` or the copy the
installer shipped. A pack is the `dist/` build, a `manifest.json` with every
file's SHA-256 and the bridge level it needs, and an ed25519 signature of the
manifest. The app loads only packs signed by the key it was built with.

### Signing key

```sh
openssl genpkey -algorithm ed25519 -out ui-signing.key          # keep this offline
openssl pkey -in ui-signing.key -pubout -outform DER | base64     # the public half
```

Build the desktop app with `CLAUDEX_UI_PACK_PUBLIC_KEY=<public half>`. An app
built without it never loads a pack. Anyone holding the private key can run
code on every installation through the window's bridge, so keep it off
servers. If it leaks, ship a new installer with a new key.

### Publishing a pack

```sh
CLAUDEX_UI_SIGNING_KEY=/path/to/ui-signing.key \
  npx tsx scripts/release/ui-pack.ts --n 3 --upload
```

This builds the window, signs it as interface version
`<major>.<minor>.<n>` derived from the app version (0.0.38 ships 0.38.0; packs
for it are 0.38.1, 0.38.2…), uploads it, and prints the `ui` section to put
under the channel in the release settings. Apps pick it up at their next check
and switch on the next page load, or after ten idle minutes.

- **Bridge level.** `shared/ui-pack.ts` has `bridgeLevel`. Raise it whenever
  the window starts calling a main-process method or event that older apps
  don't have; a pack needing a higher level than an app offers is ignored by
  that app, which keeps its own interface until it installs a newer build.
- **Rollback.** A pack that doesn't report ready within 20 seconds, or
  crashes the window while starting, counts as a failure; two failures mark
  it bad and the app goes back to the previous pack or its own copy. Taking a
  pack out of the release settings makes apps switch back at their next check.

### A hosted interface

For development or a managed fleet, `CLAUDEX_UI_URL=https://…/index.html`
loads a hosted desktop build (`npm run build`'s `dist/`, with `quick.html`
and `find.html` beside it) instead of packs. The hosted site gets the full
desktop bridge, so use only an HTTPS site you control.
