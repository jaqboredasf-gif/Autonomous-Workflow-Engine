<#
-----------------------------------------------------------------------------
Deploy-PCCProduction.ps1 — the one command for the supervised installation.

THIS ORCHESTRATES; IT DOES NOT REIMPLEMENT. Every step below is an existing
script that can still be run on its own, and this exists so that nobody has to
remember the order or the arguments on the day. If this file and the scripts it
calls ever disagree, the scripts are right.

    1. preflight-windows.ps1     is this SERVER ready?          (read-only)
    2. install-production.ps1    directories, artifact, permissions,
                                 service, start, health          (refuses hard)
    3. install-backup-task.ps1   the nightly verified backup
    4. pcc-verify-deployment.mjs is this INSTALLATION operational?

  IIS is deliberately NOT in that list. Configure-PCCIIS.ps1 is run separately,
  after PCC is proven on the loopback interface, because a proxy in front of a
  broken application is two problems being debugged as one.

  .\scripts\Deploy-PCCProduction.ps1 -FirstInstall
  .\scripts\Deploy-PCCProduction.ps1                    # an upgrade
  .\scripts\Deploy-PCCProduction.ps1 -PreflightOnly     # changes nothing
  .\scripts\Deploy-PCCProduction.ps1 -SkipPreflight     # only if it already passed

WHAT IT WILL NOT DO. It stops at the first failure rather than continuing to
the next step, because every step after a failure reports on a system that is
not in the state it thinks it is. It creates no directory the installer refuses
to create, invents no secret, and reboots nothing.
-----------------------------------------------------------------------------
#>

[CmdletBinding()]
param(
  [string] $EnvFile     = 'C:\ProgramData\pcc\pcc.env',
  [string] $DataDir     = 'C:\ProgramData\pcc\data',
  [string] $Artifact    = '.\dist\pcc',
  [string] $ServiceName = 'pcc',
  [int]    $Port        = 3000,
  [switch] $FirstInstall,
  [switch] $PreflightOnly,
  [switch] $SkipPreflight
)

$ErrorActionPreference = 'Stop'
$started = Get-Date

function Phase ($n, $title) {
  Write-Host ''
  Write-Host '======================================================================' -ForegroundColor Cyan
  Write-Host "  STEP $n — $title" -ForegroundColor Cyan
  Write-Host '======================================================================' -ForegroundColor Cyan
}
function Stop-Here ($m) {
  Write-Host ''
  Write-Host '----------------------------------------------------------------------' -ForegroundColor Red
  Write-Host "  STOPPED: $m" -ForegroundColor Red
  Write-Host '  Nothing after this step has run. Fix the above and run this again —' -ForegroundColor Red
  Write-Host '  every step is idempotent, so re-running is safe.' -ForegroundColor Red
  Write-Host '----------------------------------------------------------------------' -ForegroundColor Red
  exit 1
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Stop-Here 'this must run in an elevated PowerShell (Run as Administrator).'
}

Write-Host ''
Write-Host 'PCC PRODUCTION DEPLOYMENT' -ForegroundColor Green
Write-Host "  server      : $env:COMPUTERNAME"
Write-Host "  service     : $ServiceName"
Write-Host "  data        : $DataDir"
Write-Host "  config      : $EnvFile"
Write-Host "  artifact    : $Artifact"
$relFile = Join-Path $Artifact 'apps\purchasing\RELEASE'
if (Test-Path -LiteralPath $relFile) { Write-Host "  release     : $((Get-Content -LiteralPath $relFile -Raw).Trim())" }
Write-Host "  first install: $(if ($FirstInstall) { 'YES — this may CREATE the purchasing database' } else { 'no — upgrading an existing installation' })"

# --- 1 ----------------------------------------------------------------------
if (-not $SkipPreflight) {
  Phase 1 'PREFLIGHT — is this server ready? (changes nothing)'
  & "$PSScriptRoot\preflight-windows.ps1" -EnvFile $EnvFile -DataDir $DataDir -Artifact $Artifact -ServiceName $ServiceName -Port $Port
  if ($LASTEXITCODE -ne 0) { Stop-Here 'the preflight found blockers. Nothing has been installed.' }
} else {
  Write-Host ''
  Write-Host '  (preflight skipped by request)' -ForegroundColor Yellow
}

if ($PreflightOnly) {
  Write-Host ''
  Write-Host 'PREFLIGHT ONLY — nothing was installed.' -ForegroundColor Green
  exit 0
}

# --- 2 ----------------------------------------------------------------------
Phase 2 'INSTALL — artifact, permissions, service, start, health'
$installArgs = @{ EnvFile = $EnvFile; DataDir = $DataDir; Artifact = $Artifact; ServiceName = $ServiceName }
if ($FirstInstall) { $installArgs.FirstInstall = $true }
& "$PSScriptRoot\install-production.ps1" @installArgs
if ($LASTEXITCODE -ne 0) { Stop-Here 'the installation refused or failed. Read its message above — it names what to fix.' }

# --- 3 ----------------------------------------------------------------------
Phase 3 'BACKUP — the nightly verified backup, proven once now'
& "$PSScriptRoot\install-backup-task.ps1" -DataDir $DataDir -Repo "C:\Program Files\$ServiceName" -EnvFile $EnvFile -RunNow
if ($LASTEXITCODE -ne 0) { Stop-Here 'the backup schedule could not be installed or its first run failed. PCC is running, but nothing is protecting the data yet.' }

# --- 4 ----------------------------------------------------------------------
Phase 4 'VERIFY — is this installation operational?'
& node "$PSScriptRoot\pcc-verify-deployment.mjs" --service $ServiceName
$verifyCode = $LASTEXITCODE

# --- what is left, which is the part no script can do -----------------------
$elapsed = [int]((Get-Date) - $started).TotalMinutes
Write-Host ''
Write-Host '======================================================================' -ForegroundColor Green
Write-Host "  INSTALLED in ${elapsed} minute(s)" -ForegroundColor Green
Write-Host '======================================================================' -ForegroundColor Green

if ($verifyCode -ne 0) {
  Write-Host ''
  Write-Host '  Verification reported blockers above. PCC may be running, but it is' -ForegroundColor Yellow
  Write-Host '  NOT ready for acceptance testing until they are cleared.' -ForegroundColor Yellow
}

@"

STILL TO DO, IN THIS ORDER — none of it is automatable:

  1. IIS. Only now that PCC is proven on the loopback interface:
       .\scripts\Configure-PCCIIS.ps1 -Phase Http
     and later, when the certificate exists:
       .\scripts\Configure-PCCIIS.ps1 -Phase Https -CertThumbprint <thumbprint>

  2. Sign in as the bootstrap administrator and CHANGE THE TEMPORARY PASSWORD.

  3. Remove PCC_DATABASE_ALLOW_CREATE and PCC_BOOTSTRAP_ADMIN_PASSWORD from
     $EnvFile, then: nssm restart $ServiceName
     The log must then say "opening the existing purchasing database".

  4. REBOOT THIS SERVER and confirm PCC comes back with nobody logging in.
     Auto-start is a setting; only a reboot is evidence.
       Restart-Computer
       (Get-Service $ServiceName).Status        # expect: Running

  5. THE PO SEQUENCES. PCC numbers per job+vendor PAIR, counting from 1 within
     each pair — there is no single starting number. For every pair that
     ALREADY has paper purchase orders, an administrator enters the last issued
     number in Admin > PO numbering. Pairs with no paper history need nothing.
     DO NOT GUESS A NUMBER. A purchase order number cannot be withdrawn once a
     supplier has it. See docs\deployment\PCC_RDS02_EXECUTION_PACKAGE.md §6.

  6. Mike and Rick acceptance, and the last of it performed with nobody
     driving the screen for them.

  7. Fill in the evidence record:
       docs\deployment\PCC_PRODUCTION_EVIDENCE.md
     Nothing is marked proven until it was observed on this server.
"@ | Write-Host

exit $verifyCode
