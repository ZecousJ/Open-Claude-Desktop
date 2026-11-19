import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** The helper holds a machine-wide mutex and flushes the current-user hive
 * before reporting success. Only hashes and opaque operation IDs cross stdin. */
const script = String.raw`
$ErrorActionPreference = 'Stop'
$inputText = [Console]::In.ReadToEnd()
$arg = ConvertFrom-Json $inputText
if ($arg.scope -notmatch '^[a-f0-9]{64}$' -or $arg.payload -notmatch '^[a-f0-9]{64}$' -or $arg.candidate -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid receipt request' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ClaudexReceiptRegistry {
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern int RegFlushKey(SafeRegistryHandle key);
}
'@
$mutex = New-Object System.Threading.Mutex($false, ('Global\ClaudexRestReceipt-' + $arg.scope))
$locked = $false
$key = $null
try {
  try { $locked = $mutex.WaitOne(15000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
  if (!$locked) { throw 'Receipt lock timed out' }
  $prefix = if ($arg.testNamespace) { [string]$arg.testNamespace } else { 'Software\Claudex\OfficialRestReceipts' }
  if ($arg.testNamespace -and $prefix -notmatch '^Software\\ClaudexReceiptTest\\[a-f0-9]{32}$') { throw 'Invalid test namespace' }
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(($prefix + '\' + $arg.scope), $true)
  if (!$key) { throw 'Receipt registry unavailable' }
  $names = $key.GetValueNames()
  if (@($names | Where-Object { $_ -notmatch '^[a-f0-9]{64}$' }).Count -gt 0) { throw 'Invalid receipt registry' }
  function ReadEntry([string]$name) {
    if ($name -notmatch '^[a-f0-9]{64}$') { throw 'Invalid receipt key' }
    $value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -eq $value) { return $null }
    if ($key.GetValueKind($name) -ne [Microsoft.Win32.RegistryValueKind]::String -or $value -isnot [string] -or $value -notmatch '^([a-f0-9]{64}):([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$') { throw 'Invalid stored receipt' }
    return @{ payload=$matches[1]; operation=$matches[2] }
  }
  $chosen = $null
  if ($arg.legacyTurn) { $chosen = [string]$arg.legacyTurn }
  foreach ($turn in $arg.turnKeys) {
    $entry = ReadEntry ([string]$turn)
    if ($entry) {
      if ($entry.payload -cne $arg.payload -or ($chosen -and $entry.operation -cne $chosen)) { [Console]::Out.Write('{"status":"conflict"}'); return }
      $chosen = $entry.operation
    }
  }
  $fresh = !$chosen
  if (!$chosen) { $chosen = [string]$arg.candidate }
  if ($arg.legacyRequest -and $arg.legacyRequest -cne $chosen) { [Console]::Out.Write('{"status":"conflict"}'); return }
  $requestEntry = if ($arg.requestKey) { ReadEntry ([string]$arg.requestKey) } else { $null }
  if ($requestEntry -and ($requestEntry.payload -cne $arg.payload -or $requestEntry.operation -cne $chosen)) { [Console]::Out.Write('{"status":"conflict"}'); return }
  $canonical = ReadEntry ([string]$arg.turnKeys[0])
  $missing = @()
  if (!$canonical) { $missing += [string]$arg.turnKeys[0] }
  if ($arg.requestKey -and !$requestEntry) { $missing += [string]$arg.requestKey }
  if ($names.Count + [int]$arg.legacySlots + $missing.Count -gt [int]$arg.capacity) { [Console]::Out.Write('{"status":"capacity"}'); return }
  foreach ($name in $missing) { $key.SetValue($name, ($arg.payload + ':' + $chosen), [Microsoft.Win32.RegistryValueKind]::String) }
  if ($missing.Count -gt 0) {
    $status = [ClaudexReceiptRegistry]::RegFlushKey($key.Handle)
    if ($status -ne 0) { throw 'Receipt flush failed' }
  }
  [Console]::Out.Write((@{status=$(if($fresh){'fresh'}else{'existing'});operationId=$chosen} | ConvertTo-Json -Compress))
} finally {
  if ($key) { $key.Dispose() }
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
`;
export interface WindowsReceiptInput {
  scope: string;
  payload: string;
  candidate: string;
  turnKeys: string[];
  requestKey?: string;
  legacyTurn?: string;
  legacyRequest?: string;
  legacySlots: number;
  capacity: number;
}
export function reserveWindowsReceipt(
  input: WindowsReceiptInput,
  testNamespace?: string,
): {
  status: "fresh" | "existing" | "conflict" | "capacity";
  operationId?: string;
} {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot))
    throw Error("Windows system directory is unavailable.");
  const executable = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (!fs.existsSync(executable))
    throw Error("Windows receipt helper is unavailable.");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const child = spawnSync(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      input: JSON.stringify({
        ...input,
        ...(testNamespace ? { testNamespace } : {}),
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 8192,
    },
  );
  if (
    child.error ||
    child.status !== 0 ||
    child.signal ||
    !child.stdout ||
    child.stdout.length > 1024
  )
    throw Error("Windows receipt storage failed.");
  const answer = JSON.parse(child.stdout);
  if (
    !answer ||
    !["fresh", "existing", "conflict", "capacity"].includes(answer.status) ||
    (["fresh", "existing"].includes(answer.status) &&
      (typeof answer.operationId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          answer.operationId,
        )))
  )
    throw Error("Windows receipt result is invalid.");
  return answer;
}
