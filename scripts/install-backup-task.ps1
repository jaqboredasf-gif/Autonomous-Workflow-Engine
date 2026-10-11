<#
-----------------------------------------------------------------------------
install-backup-task.ps1 — when the backup happens, on Windows Server.

THE BACKUP ITSELF IS NOT HERE. scripts/pcc-backup.mjs takes the backup, verifies
it, and prunes old ones; it is portable Node and runs unchanged on Windows. This
script only schedules it. A second backup implementation would be a second thing
to be wrong, and the one that gets tested is the one that already exists.

This is the Windows equivalent of deploy/pcc-backup.timer +
deploy/pcc-backup.service, and it keeps their decisions:

  · 01:30 LOCAL TIME every night. Purchasing is a working-hours system: nobody
    is raising a request at half past one, and a backup taken then is a clean
    cut between one working day and the next. Local rather than UTC on purpose —
    the thing being protected is a day's work, and the day is the one the
    office had.
  · Up to five minutes of jitter. One machine does not need it; a Hyper-V host
    with several VMs waking at exactly 01:30 does.
  · IF THE MACHINE WAS OFF AT 01:30, BACK UP WHEN IT COMES BACK. A server
    rebooted for patching on the night the disk fails is exactly the case a
    backup exists for, and a schedule that silently skipped that night is not
    a backup schedule. (Task Scheduler: -StartWhenAvailable, which is
    Persistent=true.)
  · --keep 30. The script never deletes the backup it just wrote and verified.
  · FAIL LOUDLY, and no retry loop. A failed backup leaves a non-zero LastTaskResult
    that Get-ScheduledTaskInfo reports; tomorrow's run is the retry.

  .\scripts\install-backup-task.ps1 -DataDir C:\ProgramData\pcc\data -Repo "C:\Program Files\pcc"
  .\scripts\install-backup-task.ps1 -DataDir ... -Repo ... -RunNow
  .\scripts\install-backup-task.ps1 -Verify

  -DataDir   the persistent data directory. Backups are written to .\backups inside it.
  -Repo      where pcc-backup.mjs lives — normally the install path.
  -TaskName  default 'PCC Nightly Backup'. Use a distinct name for staging.
  -EnvFile   the environment file, read for PCC_DATABASE_PATH. Optional if -Db is given.
  -Db        the live database, if you would rather state it than derive it.
  -RunNow    start the task once immediately after creating it, to prove it works.
  -Verify    report whether the task exists, is enabled, and what it last did. Changes nothing.
-----------------------------------------------------------------------------
#>

[CmdletBinding()]
param(
  [string] $DataDir  = '',
  [string] $Repo     = '',
  [string] $TaskName = 'PCC Nightly Backup',
  [string] $EnvFile  = '',
  [string] $Db       = '',
  [switch] $RunNow,
  [switch] $Verify
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Ok    ($m) { Write-Host "  ok  $m" }
function Warn  ($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }
function Fatal ($m) { Write-Host ""; Write-Host "FATAL: $m" -ForegroundColor Red; exit 1 }

# --- -Verify: report, change nothing ---------------------------------------
# Kept first and side-effect free so it is safe to run at any time, including
# from pcc-verify-deployment.mjs and from an operator wondering if the backup
# is still on.
if ($Verify) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "ABSENT: no scheduled task named '$TaskName'."
    Write-Host "  Nothing is backing PCC up on a schedule. Create it:"
    Write-Host "    .\scripts\install-backup-task.ps1 -DataDir <data> -Repo <install path>"
    exit 1
  }
  Ok "the task '$TaskName' exists"
  if ($task.State -eq 'Disabled') {
    Warn "but it is DISABLED — it will not run."
    exit 1
  }
  Ok "state: $($task.State)"
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host "      last run    : $($info.LastRunTime)"
  Write-Host "      last result : $($info.LastTaskResult)  (0 = success)"
  Write-Host "      next run    : $($info.NextRunTime)"
  if ($info.LastTaskResult -ne 0 -and $null -ne $info.LastRunTime) {
    Warn "the last run FAILED. A backup that quietly stopped working is worse than none."
    Warn "Read the log: $(Join-Path (Split-Path -Parent $DataDir) 'logs\pcc-backup.log')"
    exit 1
  }
  exit 0
}

# --- creating it ------------------------------------------------------------
if (-not $DataDir) { Fatal "-DataDir is required (or use -Verify)." }
if (-not $Repo)    { Fatal "-Repo is required — where pcc-backup.mjs lives (or use -Verify)." }

$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fatal "this must run in an elevated PowerShell (Run as Administrator)."
}

if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) {
  Fatal "the data directory does not exist: $DataDir"
}
$DataAbs = (Resolve-Path -LiteralPath $DataDir).Path

$script = Join-Path $Repo 'scripts\pcc-backup.mjs'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
  Fatal @"
pcc-backup.mjs is not at: $script
  -Repo must point at the installed application (or the checkout) that contains
  scripts\pcc-backup.mjs. This script schedules that one; it does not replace it.
"@
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fatal "node is not installed or not on PATH." }

# The database: stated, or read from the env file. Never guessed — a backup of
# the wrong file is the failure this whole schedule exists to prevent.
if (-not $Db) {
  if (-not $EnvFile) {
    Fatal "pass -Db, or -EnvFile so PCC_DATABASE_PATH can be read from it."
  }
  if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    Fatal "the environment file does not exist: $EnvFile"
  }
  foreach ($line in Get-Content -LiteralPath $EnvFile) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { continue }
    if ($t.Substring(0, $i).Trim() -eq 'PCC_DATABASE_PATH') { $Db = $t.Substring($i + 1).Trim() }
  }
  if (-not $Db) { Fatal "PCC_DATABASE_PATH is not set in $EnvFile" }
}
if (-not (Test-Path -LiteralPath $Db -PathType Leaf)) {
  Fatal @"
there is no database at: $Db
  Scheduling a backup of a file that does not exist produces a task that fails
  every night. Install PCC first.
"@
}

$outDir = Join-Path $DataAbs 'backups'
$logDir = Join-Path (Split-Path -Parent $DataAbs) 'logs'
$logFile = Join-Path $logDir 'pcc-backup.log'
New-Item -ItemType Directory -Force -Path $outDir, $logDir | Out-Null

# Windows has no journal, so the task's output goes to a file or nowhere.
# cmd's redirection is used rather than a wrapper script: one less file to
# install, and the exit code still reaches Task Scheduler.
$nodeExe = $node.Source
$inner   = "`"$nodeExe`" `"$script`" --db `"$Db`" --out `"$outDir`" --keep 30 >> `"$logFile`" 2>&1"
$action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $inner" -WorkingDirectory $Repo

$trigger = New-ScheduledTaskTrigger -Daily -At '01:30'
$trigger.RandomDelay = 'PT5M'

# SYSTEM rather than the pcc virtual account: the task must read the database
# and write to the backups directory, and a scheduled task running as a service
# virtual account cannot be registered outside that service.
$principalObj = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew `
  -Compatibility Win8

# IDEMPOTENT. Register-ScheduledTask -Force replaces a task of the same name
# rather than creating a second one, so re-running converges instead of
# scheduling two backups an unknown distance apart.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Register-ScheduledTask `
  -TaskName    $TaskName `
  -Description 'Nightly verified backup of the Purchasing Control Center database. Runs scripts/pcc-backup.mjs.' `
  -Action      $action `
  -Trigger     $trigger `
  -Principal   $principalObj `
  -Settings    $settings `
  -Force | Out-Null

if ($existing) { Ok "replaced the existing task '$TaskName' (no duplicate created)" }
else           { Ok "created the task '$TaskName'" }
Ok "01:30 local, up to 5 minutes of jitter, catches up if the machine was off"
Ok "backups to $outDir, keeping 30, log at $logFile"

if ($RunNow) {
  Write-Host ""
  Write-Host "== running it once now, to prove it works"
  Start-ScheduledTask -TaskName $TaskName
  foreach ($attempt in 1..60) {
    Start-Sleep -Seconds 2
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    if ((Get-ScheduledTask -TaskName $TaskName).State -ne 'Running') {
      if ($info.LastTaskResult -eq 0) {
        Ok "the backup ran and exited 0"
        Get-ChildItem -LiteralPath $outDir | Sort-Object LastWriteTime -Descending |
          Select-Object -First 1 | ForEach-Object { Write-Host "      newest backup: $($_.Name)" }
      } else {
        Fatal "the backup exited $($info.LastTaskResult). Read: Get-Content `"$logFile`" -Tail 40"
      }
      break
    }
  }
}

@"

Verify it at any time — this changes nothing:
    .\scripts\install-backup-task.ps1 -Verify

NOT DONE BY THIS SCRIPT: offsite copies, long-term retention and encryption of
the files it produces. Those belong to Lippolis IT's existing backup platform;
this makes the file it collects.
"@ | Write-Host
