/**
 * The helpers that install a staged update after Claudex has quit (package
 * OTA). Each is a fixed script that takes its values as arguments, so no
 * path is ever spliced into shell or PowerShell code. No Electron imports.
 *
 * macOS (after ZecousAI's install-update-macos.sh, with a backup and
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
$ProgressPreference = 'SilentlyContinue'
function Write-Result([bool]$ok, [string]$err) {
  $json = @{ ok = $ok; version = $Version; error = $err } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($Result, $json)
}
$exe = Join-Path $InstallDir $ExeName
try { Wait-Process -Id $ProcessId -Timeout 120 -ErrorAction SilentlyContinue } catch {}
if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
  Write-Result $false 'Claudex did not quit.'
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
  if ($TaskName) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue }
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
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
if ($TaskName) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue }
`;

export const windowsAsarVersionReader = `function Read-PackVersion([string]$folder) {
  $asar = Join-Path $folder 'app.asar'
  $reader = [System.IO.BinaryReader]::new([System.IO.File]::OpenRead($asar))
  try {
    # The ASAR header is two Pickles, with the file offsets relative to their end.
    $null = $reader.ReadUInt32()
    $headerSize = $reader.ReadUInt32()
    $null = $reader.ReadUInt32()
    $headerLength = $reader.ReadInt32()
    $header = [System.Text.Encoding]::UTF8.GetString($reader.ReadBytes($headerLength)) | ConvertFrom-Json
    $metadata = $header.files.'package.json'
    $reader.BaseStream.Position = 8 + $headerSize + [long]$metadata.offset
    ([System.Text.Encoding]::UTF8.GetString($reader.ReadBytes($metadata.size)) | ConvertFrom-Json).version
  } finally { $reader.Dispose() }
}`;

/** Swaps in an app pack prepared next to the installed resources. */
export const windowsAppPackScript = `param(
  [int]$ProcessId,
  [string]$InstallDir,
  [string]$Relaunch,
  [string]$Result,
  [string]$Version,
  [string]$Staged,
  [string]$ExeName,
  [string]$TaskName,
  [string]$Prepared,
  [string]$CurrentVersion,
  [string]$Ready
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Retry([scriptblock]$step) {
  for ($i = 0; ; $i++) {
    try { & $step; return } catch { if ($i -ge 30) { throw }; Start-Sleep -Seconds 2 }
  }
}
function Read-Record([string]$file) {
  try { Get-Content -LiteralPath $file -Encoding UTF8 -Raw | ConvertFrom-Json } catch {}
}
${windowsAsarVersionReader}
function Write-Result([bool]$ok, [string]$err) {
  $json = @{ ok = $ok; version = $Version; prepared = $Prepared; attempts = $attempts; error = $err } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($Result, $json)
}
$exe = Join-Path $InstallDir $ExeName
function Reopen {
  if ($Relaunch -eq '1' -and (Test-Path -LiteralPath $exe)) { Start-Process -FilePath $exe }
}
$res = Join-Path $InstallDir 'resources'
$new = "$Prepared.installing"
$old = "$Prepared.previous"
$kept = 'codex'
$oldKept = Join-Path $old $kept
$newKept = Join-Path $new $kept
$lockFile = Join-Path $InstallDir '.claudex-update.lock'
$lock = $null
$installed = $false
$err = ''
try {
  if ($Ready) { [System.IO.File]::WriteAllText($Ready, 'ready') }
  # Explorer may start this helper with less privilege than the app. Enumerating
  # its PID works without opening a synchronization handle to the other process.
  $wait = [Diagnostics.Stopwatch]::StartNew()
  while ($wait.Elapsed.TotalSeconds -lt 120 -and (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
    Start-Sleep -Milliseconds 100
  }
  $lock = Retry { [System.IO.File]::Open($lockFile, 'OpenOrCreate', 'ReadWrite', 'None') }
  $record = Read-Record $Staged
  if ($record.kind -ne 'win-app' -or $record.version -ne $Version -or $record.prepared -ne $Prepared -or $record.sourceVersion -ne $CurrentVersion -or
      (-not (Test-Path -LiteralPath $Prepared) -and -not (Test-Path -LiteralPath $new))) {
    Reopen
    return
  }
  $receipt = Read-Record $Result
  $attempts = [int]$record.attempts + 1
  if ($receipt.version -eq $Version -and $receipt.prepared -eq $Prepared) { $attempts = [int]$receipt.attempts + 1 }
  try {
    if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
      Write-Result $false 'Claudex did not quit.'
      return
    }
    $current = if (Test-Path -LiteralPath $old) { $old } else { $res }
    if ((Read-PackVersion $current) -ne $CurrentVersion) {
      try { Reopen } catch {}
      return
    }
    if (-not (Test-Path -LiteralPath $new)) { [System.IO.Directory]::Move($Prepared, $new) }
    if ((Read-PackVersion $new) -ne $Version) { throw "The prepared app pack isn't the expected version." }
    if (-not (Test-Path -LiteralPath $old)) { Retry { [System.IO.Directory]::Move($res, $old) } }
    if (Test-Path -LiteralPath $oldKept) { [System.IO.Directory]::Move($oldKept, $newKept) }
    if (-not (Test-Path -LiteralPath $newKept -PathType Container)) { throw 'The installed Codex folder is missing.' }
    [System.IO.Directory]::Move($new, $res)
    $installed = $true
  } catch {
    $err = $_.Exception.Message
    try {
      if (Test-Path -LiteralPath $old) {
        if ((Test-Path -LiteralPath $newKept) -and -not (Test-Path -LiteralPath $oldKept)) { [System.IO.Directory]::Move($newKept, $oldKept) }
        if (-not (Test-Path -LiteralPath $res)) { [System.IO.Directory]::Move($old, $res) }
      }
      if (Test-Path -LiteralPath $new) { [System.IO.Directory]::Move($new, $Prepared) }
    } catch { $err += " Rollback: $($_.Exception.Message)" }
  }
  try { Write-Result $installed $err } catch {}
  Reopen
  if ($installed) {
    $dirKey = $InstallDir.TrimEnd('\\') + '\\'
    Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object {
      $entry = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
      if ("$($entry.UninstallString)".IndexOf($dirKey, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Set-ItemProperty -LiteralPath $_.PSPath -Name DisplayVersion -Value $Version -ErrorAction SilentlyContinue
        if ("$($entry.DisplayName)" -match '^Claudex \\d') { Set-ItemProperty -LiteralPath $_.PSPath -Name DisplayName -Value "Claudex $Version" -ErrorAction SilentlyContinue }
      }
    }
  }
} finally {
  if ($lock) { $lock.Dispose() }
  if ($installed) { Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
  if ($TaskName) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue }
}
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
  prepared?: string;
  currentVersion?: string;
  readyFile?: string;
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

export function windowsPowerShellCommand(
  args: string[],
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
      ...args,
    ],
  };
}

export function windowsApplyCommand(
  script: string,
  args: ApplyArguments,
  systemRoot?: string,
) {
  return windowsPowerShellCommand(
    [
      "-File",
      script,
      "-ProcessId",
      String(args.pid),
      ...(args.prepared
        ? [
            "-Prepared",
            args.prepared,
            "-CurrentVersion",
            args.currentVersion ?? "",
          ]
        : ["-Installer", args.file]),
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
      ...(args.readyFile ? ["-Ready", args.readyFile] : []),
    ],
    systemRoot,
  );
}

export function windowsHiddenCommand(
  helper: { command: string; args: string[] },
  systemRoot = "C:\\Windows",
) {
  return {
    command: path.win32.join(systemRoot, "System32", "conhost.exe"),
    args: ["--headless", helper.command, ...helper.args],
  };
}

/** A Windows command line's argument, quoted when it has to be. */
function windowsArgument(value: string) {
  if (value && !/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export function windowsExplorerLaunchCommand(
  helper: { command: string; args: string[] },
  readyFile: string,
  systemRoot?: string,
) {
  const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$shell = New-Object -ComObject Shell.Application",
    "$hwnd = 0",
    "$desktop = $shell.Windows().FindWindowSW(0, 0, 8, [ref]$hwnd, 1)",
    'if (!$desktop) { throw "The Windows desktop is unavailable." }',
    `$desktop.Document.Application.ShellExecute(${quoted(helper.command)}, ${quoted(helper.args.map(windowsArgument).join(" "))}, '', 'open', 0)`,
    `$ready = ${quoted(readyFile)}`,
    "$deadline = [DateTime]::UtcNow.AddSeconds(8)",
    "while (!(Test-Path -LiteralPath $ready) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }",
    'if (!(Test-Path -LiteralPath $ready)) { throw "The Windows update helper did not start." }',
  ].join("\n");
  return windowsPowerShellCommand(
    ["-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    systemRoot,
  );
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
  const hidden = windowsHiddenCommand(helper, systemRoot);
  const argument = [...hidden.args, "-TaskName", taskName]
    .map(windowsArgument)
    .join(" ");
  const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute ${quoted(hidden.command)} -Argument ${quoted(argument)}`,
    "$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)",
    `Register-ScheduledTask -TaskName ${quoted(taskName)} -Action $action -Principal $principal -Settings $settings -Force | Out-Null`,
    `try { Start-ScheduledTask -TaskName ${quoted(taskName)} } catch { Unregister-ScheduledTask -TaskName ${quoted(taskName)} -Confirm:$false -ErrorAction SilentlyContinue; throw }`,
  ].join("\n");
  return windowsPowerShellCommand(
    ["-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    systemRoot,
  );
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
