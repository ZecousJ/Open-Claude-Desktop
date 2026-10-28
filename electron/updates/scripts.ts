/**
 * The helpers that install a staged update after Claudex has quit (package
 * OTA). Each is a fixed script that takes its values as arguments, so no
 * path is ever spliced into shell or PowerShell code. No Electron imports.
 *
 * macOS (with a backup and
 * rollback): wait for the app to exit, unpack the zip with ditto next to
 * the bundle, check that it is Claudex at the expected version, move the
 * current bundle aside and the new one into place (renames on one volume),
 * put the old one back when that fails, remove the quarantine attribute and
 * open the app only when asked to.
 *
 * Windows: wait for the app to exit, run the NSIS installer silently for the
 * current user into the same folder, open the app only when asked to.
 */
import path from "node:path";

/** The bundle identifier every Claudex build has (package.json build.appId). */
export const claudexBundleId = "dev.claudex.desktop";

export const macApplyScript = `#!/bin/bash
# Installs a staged Claudex update after Claudex quits (written by Claudex).
set -u
PID="$1"; ZIP="$2"; APP="$3"; RELAUNCH="$4"; RESULT="$5"; VERSION="$6"; BUNDLE_ID="$7"; STAGED="$8"; BACKGROUND="$9"
exec 2>>"$RESULT.stderr.log"
result() {
  printf '{"ok":%s,"version":"%s","error":"%s"}\\n' "$1" "$VERSION" "$2" > "$RESULT.tmp" && mv -f "$RESULT.tmp" "$RESULT"
}
reopen() { if [ "$RELAUNCH" = 1 ]; then if [ "$BACKGROUND" = 1 ]; then /usr/bin/open -g "$APP"; else /usr/bin/open "$APP"; fi; fi; }
for _ in $(seq 1 600); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$PID" 2>/dev/null; then result false "Claudex did not quit."; exit 1; fi
PARENT="$(dirname "$APP")"
WORK="$(mktemp -d "$PARENT/.claudex-update.XXXXXX" 2>/dev/null)" || { result false "The folder Claudex is in can't be changed."; reopen; exit 1; }
fail() { rm -rf "$WORK"; result false "$1"; reopen; exit 1; }
/usr/bin/ditto -x -k "$ZIP" "$WORK/unpacked" || fail "The update couldn't be unpacked."
NEW="$WORK/unpacked/Claudex.app"
if [ ! -d "$NEW" ]; then NEW="$(find "$WORK/unpacked" -maxdepth 2 -name '*.app' -type d -print -quit)"; fi
if [ -z "$NEW" ] || [ ! -d "$NEW" ]; then fail "The update has no app in it."; fi
PLIST="$NEW/Contents/Info.plist"
ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST" 2>/dev/null)"
if [ "$ID" != "$BUNDLE_ID" ]; then fail "The update isn't Claudex."; fi
V="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST" 2>/dev/null)"
if [ "$V" != "$VERSION" ]; then fail "The update isn't the expected version."; fi
# Only a developer-signed install (a Team ID) holds the update to its
# signature. An ad-hoc, linker-signed build seals no resources, so a strict
# check fails it every time (every Mac on 0.0.27 and 0.0.28 could not update,
# 2026-10-16); the zip's sha256 from the release record vouches for it.
TEAM="$(/usr/bin/codesign -dv "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
if [ -n "$TEAM" ] && [ "$TEAM" != "not set" ]; then
  /usr/bin/codesign --verify --deep --strict "$NEW" || fail "The update's code signature is invalid."
  /usr/bin/codesign --verify -R "anchor apple generic and identifier \\"$BUNDLE_ID\\" and certificate leaf[subject.OU] = \\"$TEAM\\"" "$NEW" || fail "The update's signing identity doesn't match Claudex."
fi
/usr/bin/xattr -dr com.apple.quarantine "$NEW" 2>/dev/null
if ! mv "$APP" "$WORK/previous.app"; then fail "The installed app couldn't be moved."; fi
if ! mv "$NEW" "$APP"; then
  mv "$WORK/previous.app" "$APP"
  fail "The new app couldn't be put in place."
fi
touch "$APP"
rm -rf "$WORK"
rm -f "$ZIP" "$STAGED"
result true ""
reopen
exit 0
`;

export const windowsApplyScript = `param(
  [int]$ProcessId,
  [string]$Installer,
  [string]$InstallDir,
  [string]$Relaunch,
  [string]$Result,
  [string]$Version,
  [string]$Staged,
  [string]$ExeName,
  [string]$TaskName
)
# Installs a staged Claudex update after Claudex quits (written by Claudex).
$ErrorActionPreference = 'Stop'
function Write-Result([bool]$ok, [string]$err) {
  $json = @{ ok = $ok; version = $Version; error = $err } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($Result, $json)
}
$exe = Join-Path $InstallDir $ExeName
try { Wait-Process -Id $ProcessId -Timeout 120 -ErrorAction SilentlyContinue } catch {}
if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
  Write-Result $false 'Claudex did not quit.'
  if ($TaskName) { schtasks.exe /Delete /TN $TaskName /F 2>&1 | Out-Null }
  exit 1
}
try {
  $p = Start-Process -FilePath $Installer -ArgumentList "/S /currentuser /D=$InstallDir" -RedirectStandardError "$Result.stderr.log" -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "The installer stopped with code $($p.ExitCode)." }
  Write-Result $true ''
  Remove-Item -LiteralPath $Installer, $Staged -Force -ErrorAction SilentlyContinue
} catch {
  Write-Result $false "$($_.Exception.Message)"
}
if ($Relaunch -eq '1' -and (Test-Path -LiteralPath $exe)) { Start-Process -FilePath $exe }
if ($TaskName) { schtasks.exe /Delete /TN $TaskName /F 2>&1 | Out-Null }
`;

/**
 * Windows app pack (app-pack.ts): after Claudex quits, the zip's files
 * become resources/, the Codex folder moving over from the old one; the old
 * folder comes back if anything fails. No new program runs, so Smart App
 * Control has nothing to block. Same parameters as windowsApplyScript, the
 * zip as -Installer.
 */
export const windowsAppPackScript = `param(
  [int]$ProcessId,
  [string]$Installer,
  [string]$InstallDir,
  [string]$Relaunch,
  [string]$Result,
  [string]$Version,
  [string]$Staged,
  [string]$ExeName,
  [string]$TaskName
)
# Applies a staged Claudex app pack after Claudex quits (written by Claudex).
$ErrorActionPreference = 'Stop'
function Write-Result([bool]$ok, [string]$err) {
  $json = @{ ok = $ok; version = $Version; error = $err } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($Result, $json)
}
# A program Claudex started may hold a file a moment longer.
function Retry([scriptblock]$step) {
  for ($i = 0; ; $i++) {
    try { & $step; return } catch { if ($i -ge 30) { throw }; Start-Sleep -Seconds 2 }
  }
}
$exe = Join-Path $InstallDir $ExeName
try { Wait-Process -Id $ProcessId -Timeout 120 -ErrorAction SilentlyContinue } catch {}
if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
  Write-Result $false 'Claudex did not quit.'
  if ($TaskName) { schtasks.exe /Delete /TN $TaskName /F 2>&1 | Out-Null }
  exit 1
}
$res = Join-Path $InstallDir 'resources'
$new = Join-Path $InstallDir 'resources.update'
$old = Join-Path $InstallDir 'resources.previous'
$kept = 'codex'
try {
  Remove-Item -LiteralPath $new, $old -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $Installer -DestinationPath $new -Force
  if (-not (Test-Path -LiteralPath (Join-Path $new 'app.asar'))) { throw 'The app pack has no app.asar.' }
  if (Test-Path -LiteralPath (Join-Path $res $kept)) {
    Retry { Move-Item -LiteralPath (Join-Path $res $kept) -Destination (Join-Path $new $kept) }
  }
  Retry { Rename-Item -LiteralPath $res -NewName 'resources.previous' }
  Rename-Item -LiteralPath $new -NewName 'resources'
  Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
  # Apps & features shows the version now installed.
  # (The NSIS entry names the folder only in its UninstallString.)
  $dirKey = $InstallDir.TrimEnd('\\') + '\\'
  Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object {
    $entry = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
    if ("$($entry.UninstallString)".IndexOf($dirKey, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      Set-ItemProperty -LiteralPath $_.PSPath -Name DisplayVersion -Value $Version
      if ("$($entry.DisplayName)" -match '^Claudex \\d') { Set-ItemProperty -LiteralPath $_.PSPath -Name DisplayName -Value "Claudex $Version" }
    }
  }
  Write-Result $true ''
  Remove-Item -LiteralPath $Installer, $Staged -Force -ErrorAction SilentlyContinue
} catch {
  $err = "$($_.Exception.Message)"
  try {
    if (-not (Test-Path -LiteralPath $res) -and (Test-Path -LiteralPath $old)) { Rename-Item -LiteralPath $old -NewName 'resources' }
    if (-not (Test-Path -LiteralPath (Join-Path $res $kept)) -and (Test-Path -LiteralPath (Join-Path $new $kept))) {
      Move-Item -LiteralPath (Join-Path $new $kept) -Destination (Join-Path $res $kept)
    }
    Remove-Item -LiteralPath $new -Recurse -Force -ErrorAction SilentlyContinue
  } catch {}
  Write-Result $false $err
}
if ($Relaunch -eq '1' -and (Test-Path -LiteralPath $exe)) { Start-Process -FilePath $exe }
if ($TaskName) { schtasks.exe /Delete /TN $TaskName /F 2>&1 | Out-Null }
`;

export interface ApplyArguments {
  pid: number;
  /** The staged zip or installer. */
  file: string;
  /** macOS: the .app bundle to replace. Windows: the install folder. */
  target: string;
  relaunch: boolean;
  background?: boolean;
  resultFile: string;
  version: string;
  stagedRecord: string;
  /** Windows: the app's executable name in the install folder. */
  exeName?: string;
}

/** The program and arguments that run the macOS helper script. */
export function macApplyCommand(script: string, args: ApplyArguments) {
  return {
    command: "/bin/bash",
    args: [
      script,
      String(args.pid),
      args.file,
      args.target,
      args.relaunch ? "1" : "0",
      args.resultFile,
      args.version,
      claudexBundleId,
      args.stagedRecord,
      args.background ? "1" : "0",
    ],
  };
}

/** The program and arguments that run the Windows helper script, hidden. */
export function windowsApplyCommand(
  script: string,
  args: ApplyArguments,
  systemRoot = "C:\\Windows",
) {
  return {
    command: path.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      script,
      "-ProcessId",
      String(args.pid),
      "-Installer",
      args.file,
      "-InstallDir",
      args.target,
      "-Relaunch",
      args.relaunch ? "1" : "0",
      "-Result",
      args.resultFile,
      "-Version",
      args.version,
      "-Staged",
      args.stagedRecord,
      "-ExeName",
      args.exeName ?? "Claudex.exe",
    ],
  };
}

/** A Windows command line's argument, quoted when it has to be. */
function windowsArgument(value: string) {
  if (value && !/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * Windows starts the helper through the Task Scheduler (owner, 2026-10-22:
 * Relaunch to update closed Claudex and nothing came back). Claudex opened
 * from Explorer runs inside a job, and a helper it starts itself is in that
 * job too: it was ended with Claudex before it could install (its PowerShell
 * got as far as "console starting"). A task runs outside the job, in the
 * person's own session, so it outlives Claudex, installs and reopens it;
 * the helper removes its task when done. Returns a short-lived PowerShell
 * that registers and starts the task, exiting 0 once it has.
 */
export function windowsTaskLaunchCommand(
  helper: { command: string; args: string[] },
  taskName: string,
  systemRoot = "C:\\Windows",
) {
  const argument = [...helper.args, "-TaskName", taskName]
    .map(windowsArgument)
    .join(" ");
  const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // Tasks an earlier update left behind go first.
    "Get-ScheduledTask -TaskName 'Claudex Update *' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue",
    `$action = New-ScheduledTaskAction -Execute ${quoted(helper.command)} -Argument ${quoted(argument)}`,
    "$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)",
    `Register-ScheduledTask -TaskName ${quoted(taskName)} -Action $action -Principal $principal -Settings $settings -Force | Out-Null`,
    `Start-ScheduledTask -TaskName ${quoted(taskName)}`,
  ].join("\n");
  return {
    command: path.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
  };
}

/**
 * Linux (owner, 2026-10-15: the update installs behind the system's
 * authorization prompt): wait for Claudex to exit, then reinstall the
 * package it came from with pkexec — dpkg for a deb, rpm for an rpm, or
 * for the install script's /opt/claudex tarball an unpack beside the folder
 * and a swap (the old folder is kept until the new one is in place). The
 * sandbox helper keeps its setuid bit. Claudex reopens when asked to; a
 * refused prompt leaves the current version and says so.
 */
export const linuxApplyScript = `#!/bin/sh
# Installs a staged Claudex update after Claudex quits (written by Claudex).
PID="$1"; FILE="$2"; KIND="$3"; RELAUNCH="$4"; RESULT="$5"; VERSION="$6"; DIR="$7"; EXE="$8"; STAGED="$9"
result() {
  printf '{"ok":%s,"version":"%s","error":"%s"}\n' "$1" "$VERSION" "$2" > "$RESULT.tmp" && mv -f "$RESULT.tmp" "$RESULT"
}
reopen() { if [ "$RELAUNCH" = 1 ]; then nohup "$EXE" >/dev/null 2>&1 & fi; }
i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 600 ]; do sleep 0.2; i=$((i+1)); done
if kill -0 "$PID" 2>/dev/null; then result false "Claudex did not quit."; exit 1; fi
if ! command -v pkexec >/dev/null 2>&1; then result false "pkexec is missing: install the update from a terminal."; reopen; exit 1; fi
case "$KIND" in
  linux-deb) pkexec dpkg -i "$FILE" ;;
  linux-rpm) pkexec rpm -U --replacepkgs --replacefiles "$FILE" ;;
  linux-tar) pkexec /bin/sh -c 'set -e; new="$(mktemp -d "$2.new.XXXXXX")"; tar -xzf "$1" -C "$new" --strip-components=1; chmod 4755 "$new/chrome-sandbox"; rm -rf "$2.old"; mv "$2" "$2.old"; mv "$new" "$2"; rm -rf "$2.old"' sh "$FILE" "$DIR" ;;
  *) result false "Unknown package."; reopen; exit 1 ;;
esac
code=$?
if [ $code -ne 0 ]; then result false "The update wasn't installed (code $code)."; reopen; exit 1; fi
rm -f "$STAGED" "$FILE"
result true ""
reopen
`;

export function linuxApplyCommand(
  script: string,
  args: ApplyArguments & { kind: string; exePath: string },
) {
  return {
    command: "/bin/sh",
    args: [
      script,
      String(args.pid),
      args.file,
      args.kind,
      args.relaunch ? "1" : "0",
      args.resultFile,
      args.version,
      args.target,
      args.exePath,
      args.stagedRecord,
    ],
  };
}

/**
 * The macOS helper that finishes moving a misnamed bundle (see
 * shared/app-update.ts relocationPlan): after Claudex exits it removes the
 * copy that is no longer used (if any) and opens Claudex.app.
 */
export const macRelaunchScript = `#!/bin/bash
# Opens Claudex.app after this copy of Claudex quits (written by Claudex).
set -u
PID="$1"; OPEN="$2"; REMOVE="$3"
for _ in $(seq 1 600); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
if [ -n "$REMOVE" ] && [ -d "$REMOVE" ]; then rm -rf "$REMOVE"; fi
/usr/bin/xattr -dr com.apple.quarantine "$OPEN" 2>/dev/null
touch "$OPEN"
/usr/bin/open "$OPEN"
`;
