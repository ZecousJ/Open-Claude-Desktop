import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const powershell = path.win32.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const encoded = (script: string) =>
  Buffer.from(script, "utf16le").toString("base64");
const config = (value: unknown) => {
  const json = Buffer.from(JSON.stringify(value)).toString("base64");
  return `$config = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${json}')))\n`;
};

/** A Windows console can leave the command's descendants alive after ConPTY closes. */
export class WindowsTerminalTree {
  private directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-terminal-"),
  );
  private file = path.join(this.directory, "owner");
  private marker = "";

  constructor(private readonly appServer: number) {}

  command(command: string[]) {
    this.marker = encoded(
      config({ file: this.file, command }) +
        String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$start = (Get-Process -Id $PID).StartTime.ToFileTimeUtc()
[IO.File]::WriteAllLines($config.file, [string[]]@([string]$PID, [string]$start))
$program = $config.command[0]
$arguments = @($config.command | Select-Object -Skip 1)
& $program @arguments
exit $LASTEXITCODE
`,
    );
    return [
      powershell,
      "-NoLogo",
      "-NoProfile",
      "-EncodedCommand",
      this.marker,
    ];
  }

  stopJobs() {
    if (!fs.existsSync(this.file)) return false;
    const script =
      config({ file: this.file, parent: this.appServer, marker: this.marker }) +
      String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$owner = @(Get-Content -LiteralPath $config.file)
if ($owner.Count -ne 2 -or $owner[0] -notmatch '^[1-9][0-9]{0,9}$' -or $owner[1] -notmatch '^[0-9]{1,20}$') { exit }
$terminalPid = [int]$owner[0]
$root = Get-CimInstance Win32_Process -Filter "ProcessId = $terminalPid"
if (!$root -or $root.ParentProcessId -ne $config.parent -or !$root.CommandLine.Contains($config.marker)) { exit }
$process = Get-Process -Id $terminalPid -ErrorAction SilentlyContinue
if (!$process -or [string]$process.StartTime.ToFileTimeUtc() -ne $owner[1]) { exit }
& (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $terminalPid /T /F
exit $LASTEXITCODE
`;
    try {
      const result = execFileSync(
        powershell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          encoded(script),
        ],
        {
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
        },
      );
      return result.trim().length > 0;
    } catch (cause) {
      throw new Error(
        "The Windows terminal process tree could not be closed.",
        { cause },
      );
    }
  }

  dispose() {
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* The wrapper may not have started. */
    }
    try {
      fs.rmdirSync(this.directory);
    } catch {
      /* The terminal is already retiring. */
    }
  }
}
