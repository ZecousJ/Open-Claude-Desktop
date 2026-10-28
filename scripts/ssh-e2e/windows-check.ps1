<#
.SYNOPSIS
  Checks a Windows computer's OpenSSH for Claudex's SSH connections (R9).

.DESCRIPTION
  Claudex on Windows uses the system's OpenSSH client (no connection
  sharing there): every command is its own ssh.exe, the remote engine's
  ssh.exe carries the remote forward (-R) and Claudex reads the port from
  its "Allocated port N for remote forward" line, and passwords, key
  passphrases and new host keys are asked through SSH_ASKPASS (a .cmd
  wrapper). This script checks each of those on this computer:

    1. which ssh.exe Claudex would use, and its version (SSH_ASKPASS_REQUIRE
       needs OpenSSH 8.4 or later);
    2. the "OpenSSH Authentication Agent" service;
    3. with -Destination: that ssh.exe runs an SSH_ASKPASS .cmd wrapper
       (checked with an empty, temporary known_hosts file, so the question
       is the new-host-key one; the wrapper answers "no" and nothing is
       saved);
    4. with -Destination: a remote forward to 127.0.0.1:0 and the
       "Allocated port" line (BatchMode: it needs a key or ssh-agent, it
       never asks).

  It changes nothing: no known_hosts, no config, no service. Temporary
  files are removed at the end.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\ssh-e2e\windows-check.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\ssh-e2e\windows-check.ps1 -Destination me@devbox
#>
param(
  [string]$Destination = "",
  [int]$Port = 0,
  [string]$Ssh = ""
)

$ErrorActionPreference = "Stop"
$results = New-Object System.Collections.Generic.List[object]
function Report([string]$Name, [bool]$Ok, [string]$Detail) {
  $results.Add([pscustomobject]@{ Check = $Name; Result = $(if ($Ok) { "PASS" } else { "FAIL" }); Detail = $Detail })
}

# Quotes one argument for a Windows command line (CommandLineToArgvW rules).
function Quote-Arg([string]$Value) {
  if ($Value -notmatch '[\s"]' -and $Value -ne "") { return $Value }
  return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

# Runs ssh.exe with arguments; returns exit code, stdout and stderr.
function Run-Ssh([string[]]$Arguments, [hashtable]$Environment = @{}, [int]$TimeoutSeconds = 60) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $script:SshPath
  $psi.Arguments = ($Arguments | ForEach-Object { Quote-Arg $_ }) -join " "
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  foreach ($key in $Environment.Keys) { $psi.EnvironmentVariables[$key] = $Environment[$key] }
  $process = [System.Diagnostics.Process]::Start($psi)
  $process.StandardInput.Close()
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    try { $process.Kill() } catch {}
    return [pscustomobject]@{ Code = $null; Out = ""; Err = "timed out" }
  }
  $process.WaitForExit()
  return [pscustomobject]@{ Code = $process.ExitCode; Out = $stdout.Result; Err = $stderr.Result }
}

# 1. ssh.exe and its version (the order Claudex uses: System32, then PATH).
$script:SshPath = $Ssh
if (-not $script:SshPath) {
  $system = Join-Path $env:SystemRoot "System32\OpenSSH\ssh.exe"
  if (Test-Path $system) { $script:SshPath = $system }
  else {
    $found = Get-Command ssh.exe -ErrorAction SilentlyContinue
    if ($found) { $script:SshPath = $found.Source }
  }
}
if (-not $script:SshPath -or -not (Test-Path $script:SshPath)) {
  Report "ssh.exe" $false "OpenSSH isn't installed. Settings > System > Optional features > OpenSSH Client."
  $results | Format-Table -AutoSize -Wrap
  exit 1
}
$version = (Run-Ssh @("-V")).Err.Trim()
Report "ssh.exe" $true "$script:SshPath ($version)"
if ($version -match 'OpenSSH[_\w-]*?(\d+)\.(\d+)') {
  $major = [int]$Matches[1]; $minor = [int]$Matches[2]
  $askpassRequire = ($major -gt 8) -or ($major -eq 8 -and $minor -ge 4)
  Report "SSH_ASKPASS_REQUIRE (8.4+)" $askpassRequire $(if ($askpassRequire) { "supported" } else { "too old: prompts can't reach Claudex; use ssh-agent or a key without a passphrase" })
} else {
  Report "SSH_ASKPASS_REQUIRE (8.4+)" $false "unknown version: $version"
}

# 2. The agent service (recommended: without connection sharing, a password would be asked per command).
$agent = Get-Service ssh-agent -ErrorAction SilentlyContinue
if ($agent) {
  Report "ssh-agent service" ($agent.Status -eq "Running") "$($agent.Status), start type $($agent.StartType)"
} else {
  Report "ssh-agent service" $false "not installed"
}

if ($Destination) {
  if ($Destination.StartsWith("-")) { throw "The destination can't start with '-'." }
  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("claudex-ssh-check-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $temp | Out-Null
  try {
    $portArgs = @()
    if ($Port -gt 0) { $portArgs = @("-p", "$Port") }

    # 3. SSH_ASKPASS through a .cmd wrapper, as Claudex writes it.
    $knownHosts = Join-Path $temp "known_hosts"
    New-Item -ItemType File -Path $knownHosts | Out-Null
    $log = Join-Path $temp "askpass.log"
    $wrapper = Join-Path $temp "askpass.cmd"
    Set-Content -Path $wrapper -Encoding ASCII -Value @(
      "@echo off",
      ">>`"$log`" echo %*",
      "echo no",
      "exit /b 1"
    )
    $askpass = Run-Ssh (@("-T", "-o", "BatchMode=no", "-o", "StrictHostKeyChecking=ask",
        "-o", "UserKnownHostsFile=$knownHosts", "-o", "GlobalKnownHostsFile=NUL",
        "-o", "ControlPath=none", "-o", "ConnectTimeout=15") + $portArgs + @("--", $Destination, "exit")) `
      @{ SSH_ASKPASS = $wrapper; SSH_ASKPASS_REQUIRE = "force"; DISPLAY = "claudex:0" }
    # cmd's %* stops at the prompt's first line break, so the log may hold
    # only "The authenticity of host ..." (the fingerprint is on a later line).
    $asked = (Test-Path $log) -and ((Get-Content $log -Raw) -match "authenticity of host|continue connecting|fingerprint")
    Report "askpass .cmd wrapper" $asked $(if ($asked) { "ssh asked the host-key question through the wrapper" } else { "not called (exit $($askpass.Code)): $($askpass.Err.Trim())" })
    $saved = (Get-Item $knownHosts).Length -eq 0
    Report "refused host key not saved" $saved $(if ($saved) { "known_hosts unchanged" } else { "known_hosts was written" })

    # 4. The remote forward and the "Allocated port" line.
    $forward = Run-Ssh (@("-T", "-o", "BatchMode=yes", "-o", "ControlPath=none", "-o", "LogLevel=INFO",
        "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=15", "-R", "127.0.0.1:0:127.0.0.1:9") + $portArgs + @("--", $Destination, "sleep 2"))
    if ($forward.Err -match 'Allocated port (\d+) for remote forward to 127\.0\.0\.1:9') {
      Report "remote forward (-R 127.0.0.1:0)" $true "Allocated port $($Matches[1])"
    } else {
      $reason = ($forward.Err -split "`n" | Select-Object -First 3) -join " "
      Report "remote forward (-R 127.0.0.1:0)" $false "exit $($forward.Code): $reason (needs a key or ssh-agent; BatchMode never asks)"
    }
  } finally {
    Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
  }
}

$results | Format-Table -AutoSize -Wrap
if ($results | Where-Object { $_.Result -eq "FAIL" }) { exit 1 }
