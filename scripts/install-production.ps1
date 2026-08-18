<#
-----------------------------------------------------------------------------
install-production.ps1 — the deterministic half of a PCC installation, on
Windows Server.

SCOPE, STATED FIRST, BECAUSE THE SCOPE IS THE POINT.

This is the Windows sibling of install-production.sh, and it automates the same
things: checking prerequisites, validating configuration, placing the artifact,
registering the service, and verifying health. Where the bash script drives
Docker, this drives Node directly — PCC's store is `node:sqlite`, part of the
runtime, so there is no native module to build and no container to isolate.
The mechanics it applies come from deployment/adapters/windows-service.mjs;
if the two ever disagree, the adapter is the source of truth.

IT DELIBERATELY DOES NOT:

  · configure the firewall, DNS, HTTPS, IIS or the reverse proxy — infrastructure,
    and Lippolis IT's to own
  · generate or store any secret — a secret a script invented is a secret
    nobody put in a secret store
  · create the data directory — creating it is how a typo becomes a new empty
    database beside the real one. It must already exist, deliberately.
  · initialize the purchase order sequence — that number comes from the paper
    book and inventing one is the single most expensive mistake available
  · touch, reset or migrate an existing database beyond the idempotent
    migrations the application runs on every start
  · delete a backup
  · reboot anything

REBOOT SURVIVAL IS NOT CLAIMED BY THIS SCRIPT. It sets the service to start
automatically, which is a configuration, not a proof. Only an actual reboot
proves reboot survival, and the runbook asks for one.

  .\scripts\install-production.ps1 -EnvFile C:\ProgramData\pcc\pcc.env -DataDir C:\ProgramData\pcc\data
  .\scripts\install-production.ps1 -EnvFile ... -DataDir ... -FirstInstall
  .\scripts\install-production.ps1 -EnvFile ... -DataDir ... -DryRun

  -EnvFile       the environment file. REQUIRED. Never in the repository.
  -DataDir       the persistent data directory. REQUIRED, and must exist.
  -FirstInstall  acknowledge that this start may CREATE the database.
  -DryRun        print what would happen and change nothing.
  -ServiceName   default 'pcc'. Use 'pcc-staging' for a non-production instance.
  -Artifact      the staged build to install. Default: .\dist\pcc
-----------------------------------------------------------------------------
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $EnvFile,
  [Parameter(Mandatory = $true)][string] $DataDir,
  [switch] $FirstInstall,
  [switch] $DryRun,
  [string] $ServiceName = 'pcc',
  [string] $Artifact    = '.\dist\pcc',
  [string] $InstallPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $InstallPath) { $InstallPath = "C:\Program Files\$ServiceName" }

$Root       = (Get-Location).Path
$LogDir     = Join-Path (Split-Path -Parent $DataDir) 'logs'
$ServiceAcct = "NT SERVICE\$ServiceName"

function Step  ($m) { Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }
function Ok    ($m) { Write-Host "  ok  $m" }
function Warn  ($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }
function Fatal ($m) { Write-Host ""; Write-Host "FATAL: $m" -ForegroundColor Red; exit 1 }
function Run   ($block, $what) {
  if ($DryRun) { Write-Host "  dry-run: $what"; return }
  & $block
}

# --- 0. this needs Administrator -------------------------------------------
# Service registration and icacls both fail halfway through without it, which
# leaves a partially installed service that is worse than none.
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fatal "this must run in an elevated PowerShell (Run as Administrator)."
}

# --- 1. the data directory must ALREADY exist ------------------------------
# Creating it here is exactly the failure that must not happen: a typo in the
# path becomes a new, empty, healthy-looking purchasing system while the real
# records sit somewhere else. An operator creating it deliberately is the check.
Step "checking the data directory"
if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) {
  Fatal @"
the data directory does not exist: $DataDir
  This script will NOT create it. Create it deliberately, then re-run:
    New-Item -ItemType Directory -Force -Path "$DataDir"
"@
}
$DataAbs = (Resolve-Path -LiteralPath $DataDir).Path
Ok "$DataAbs exists"

# --- 2. and it must NOT be inside this checkout ----------------------------
# A re-clone, a `git clean`, or a release that replaces the application
# directory would delete the records and the backups beside them.
$RootAbs = (Resolve-Path -LiteralPath $Root).Path
if ($DataAbs.ToLower().StartsWith($RootAbs.ToLower() + [IO.Path]::DirectorySeparatorChar) -or
    $DataAbs -eq $RootAbs) {
  Fatal @"
the data directory is inside the source checkout: $DataAbs
  Replacing or cleaning the application directory would delete the company's
  purchasing records. Put it under C:\ProgramData\$ServiceName\data instead.
"@
}
Ok "it is outside the source checkout"

# --- 3. prerequisites -------------------------------------------------------
Step "checking prerequisites"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fatal @"
node is not installed or not on PATH.
  PCC needs Node.js 24 LTS (x64). The purchasing store is `node:sqlite`, which is
  part of the runtime rather than a dependency — on Node 20 the import fails at
  startup with an error that names nothing anybody can act on.
"@
}
$nodeVersion = (& node --version).TrimStart('v')
$nodeMajor   = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 24) {
  Fatal "node $nodeVersion is too old. PCC requires Node 24 or newer (node:sqlite is not present before it)."
}
Ok "node $nodeVersion"

# NSSM supervises the process. Its absence is a hard stop rather than a fallback
# to Task Scheduler: the adapter documents why (a Scheduled Task cannot tell a
# crash from a deliberate refusal, so a misconfigured PCC would restart forever).
$nssm = Get-Command nssm -ErrorAction SilentlyContinue
if (-not $nssm) {
  Fatal @"
nssm is not installed or not on PATH.
  It is the service supervisor — one signed executable, no installer. Ask IT to
  place nssm.exe in C:\Program Files\nssm and add it to PATH.
  See deployment/adapters/windows-service.mjs for why NSSM and not Task Scheduler.
"@
}
Ok "nssm present"

if (-not (Test-Path -LiteralPath $Artifact -PathType Container)) {
  Fatal @"
no build artifact at: $Artifact
  Build it first (on this machine or another with the same Node major):
    npm ci
    npm run build --workspace purchasing
    node scripts/check-deployable.mjs
    node scripts/stage-standalone.mjs
"@
}
Ok "artifact present at $Artifact"

# --- 4. configuration -------------------------------------------------------
# Read the env file WITHOUT echoing values: this output gets pasted into tickets
# and installation records.
Step "validating configuration (values are never printed)"

if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
  Fatal "the environment file does not exist: $EnvFile"
}

$cfg = @{}
foreach ($line in Get-Content -LiteralPath $EnvFile) {
  $t = $line.Trim()
  if ($t -eq '' -or $t.StartsWith('#')) { continue }
  $i = $t.IndexOf('=')
  if ($i -lt 1) { continue }
  $cfg[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
}
function Cfg ($name) { if ($cfg.ContainsKey($name)) { return $cfg[$name] } return '' }

if ((Cfg 'NODE_ENV') -ne 'production') {
  Fatal "NODE_ENV must be 'production' in $EnvFile (found '$(if (Cfg 'NODE_ENV') { Cfg 'NODE_ENV' } else { 'unset' })')"
}
if (-not (Cfg 'SESSION_SECRET')) {
  Fatal @"
SESSION_SECRET is not set. Generate one with:
    [Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Max 256 }))
  This script will NOT generate it for you — a secret invented by a script is a
  secret nobody stored.
"@
}
if ((Cfg 'SESSION_SECRET').Length -lt 32) { Fatal "SESSION_SECRET is shorter than 32 characters" }
if (-not (Cfg 'PCC_DATABASE_PATH'))       { Fatal "PCC_DATABASE_PATH is not set" }
if (-not (Cfg 'APP_BASE_URL'))            { Fatal "APP_BASE_URL is not set — password-reset links need it" }
# HOW THIS COMPANY NUMBERS PURCHASE ORDERS IS NOT A DEFAULT. A purchase order
# number cannot be withdrawn once a supplier has it.
if (-not (Cfg 'PCC_PO_NUMBERING')) {
  Fatal @"
PCC_PO_NUMBERING is not set. Lippolis: job-vendor-sequence
  PCC will refuse to start without it rather than inherit another company's rule.
"@
}
Ok "the five required variables are set"

# A secret must never be in the repository. The build guards the artifact; this
# guards the operator who put the env file in the checkout by mistake.
$envAbs = (Resolve-Path -LiteralPath $EnvFile).Path
if ($envAbs.ToLower().StartsWith($RootAbs.ToLower() + [IO.Path]::DirectorySeparatorChar)) {
  Fatal @"
the environment file is inside the source checkout: $envAbs
  It holds SESSION_SECRET. Move it to C:\ProgramData\$ServiceName\$ServiceName.env
"@
}
Ok "the environment file is outside the checkout"

# THE ONE THAT LOCKS EVERYBODY OUT QUIETLY. `Secure` on the session cookie
# follows the scheme of APP_BASE_URL: over plain HTTP the browser accepts the
# cookie and never sends it back, so every sign-in returns to the sign-in page
# while health stays green.
$baseUrl = Cfg 'APP_BASE_URL'
if ($baseUrl -like 'https://*') {
  Ok "APP_BASE_URL is https"
} elseif ($baseUrl -like 'http://*') {
  if ((Cfg 'PCC_ALLOW_INSECURE_HTTP') -ne '1') {
    Fatal @"
APP_BASE_URL is plain HTTP ($baseUrl).
  Session cookies would cross the network unencrypted, and PCC refuses to start
  until that is a stated decision. Either:
    * put PCC behind IIS terminating HTTPS and set APP_BASE_URL to the https:// address, or
    * set PCC_ALLOW_INSECURE_HTTP=1 in $EnvFile to record that you accept plain
      HTTP on a trusted internal network.
"@
  }
  Warn "serving over plain HTTP by explicit configuration — session cookies are not"
  Warn "encrypted in transit. Correct only on a trusted internal network."
} else {
  Fatal "APP_BASE_URL must be an absolute http(s) URL — got: $baseUrl"
}

if ((Cfg 'PCC_BOOTSTRAP_ADMIN_PASSWORD') -and (-not $FirstInstall)) {
  Warn "PCC_BOOTSTRAP_ADMIN_PASSWORD is set but this is not -FirstInstall."
  Warn "Remove it from $EnvFile once the first administrator exists."
}

# The database must live in the data directory, not somewhere the installer is
# about to overwrite.
$dbPath = Cfg 'PCC_DATABASE_PATH'
$dbDir  = Split-Path -Parent $dbPath
if ($dbDir -and ((Resolve-Path -LiteralPath $dbDir -ErrorAction SilentlyContinue).Path -ne $DataAbs)) {
  Warn "PCC_DATABASE_PATH is not inside -DataDir."
  Warn "  database: $dbPath"
  Warn "  data dir: $DataAbs"
  Warn "That is legal but rarely intended. Backups and permissions follow -DataDir."
}

# --- 5. would this start CREATE a database? --------------------------------
Step "checking what this start would do to the database"
$dbFile = Join-Path $DataAbs (Split-Path -Leaf $dbPath)
if (Test-Path -LiteralPath $dbFile -PathType Leaf) {
  $size = '{0:N0} bytes' -f (Get-Item -LiteralPath $dbFile).Length
  Ok "an existing database is present — this start will OPEN it"
  Write-Host "      $size at $dbFile"
  if ((Cfg 'PCC_DATABASE_ALLOW_CREATE') -eq '1') {
    Warn "PCC_DATABASE_ALLOW_CREATE=1 is set with a database already present."
    Warn "It is tested as non-destructive, but remove it — it is for the first start only."
  }
} elseif ($FirstInstall) {
  Warn "NO DATABASE FOUND, and -FirstInstall was given."
  Warn "This start will CREATE the company's purchasing database. That should happen once, ever."
  if ((Cfg 'PCC_DATABASE_ALLOW_CREATE') -ne '1') {
    Fatal "PCC_DATABASE_ALLOW_CREATE=1 must also be set in $EnvFile for a first install"
  }
} else {
  Fatal @"
no database at $dbFile, and -FirstInstall was not given.
  If this really is the first installation, re-run with -FirstInstall (and set
  PCC_DATABASE_ALLOW_CREATE=1 in the environment file).
  If it is NOT, then the data directory is wrong — and starting would serve an
  empty purchasing system beside the real one.
"@
}

# --- 6. the read-only preflight --------------------------------------------
Step "running the preflight (read-only)"
if ($DryRun) {
  Write-Host "  dry-run: node scripts\pcc-preflight.mjs --data `"$DataAbs`" --port $(if (Cfg 'PORT') { Cfg 'PORT' } else { '3000' })"
} else {
  $port = if (Cfg 'PORT') { Cfg 'PORT' } else { '3000' }
  & node scripts\pcc-preflight.mjs --data "$DataAbs" --port $port
  if ($LASTEXITCODE -ne 0) { Fatal "the preflight found problems — fix them and run this again" }
}

# --- 7. place the artifact --------------------------------------------------
# Idempotent: the install path is replaced wholesale, so a rerun converges
# rather than layering a new release over an old one. The data directory is
# never touched by this.
Step "placing the application"
Run { New-Item -ItemType Directory -Force -Path $InstallPath, $LogDir | Out-Null } "create $InstallPath and $LogDir"
Run {
  Get-ChildItem -LiteralPath $InstallPath -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
  Copy-Item -Path (Join-Path $Artifact '*') -Destination $InstallPath -Recurse -Force
} "replace the contents of $InstallPath from $Artifact"
Ok "application at $InstallPath"

# --- 8. permissions ---------------------------------------------------------
# Least privilege, and the Windows equivalent of the Linux adapter's
# `install -d -o pcc -g pcc -m 750`. The service account may WRITE its data and
# logs, READ its configuration, and EXECUTE but never rewrite its own code.
Step "applying least-privilege permissions"
Run { & icacls $DataAbs      /grant "${ServiceAcct}:(OI)(CI)M"  /inheritance:r /grant "Administrators:(OI)(CI)F" | Out-Null } "grant modify on $DataAbs to $ServiceAcct"
Run { & icacls $LogDir       /grant "${ServiceAcct}:(OI)(CI)M"  /inheritance:r /grant "Administrators:(OI)(CI)F" | Out-Null } "grant modify on $LogDir to $ServiceAcct"
Run { & icacls $envAbs       /grant "${ServiceAcct}:R"          /inheritance:r /grant "Administrators:F"         | Out-Null } "grant read on $envAbs to $ServiceAcct"
Run { & icacls $InstallPath  /grant "${ServiceAcct}:(OI)(CI)RX"                                                   | Out-Null } "grant read+execute on $InstallPath to $ServiceAcct"
Ok "the service account can write data and logs, read configuration, and not rewrite its code"

# --- 9. the service ---------------------------------------------------------
# Every setting is ASSIGNED, never appended, so a rerun converges on the same
# service rather than accumulating configuration.
Step "registering the service"
$nodePath  = $node.Source
$serverJs  = 'apps\purchasing\server.js'
$existing  = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

if ($existing) {
  Ok "the service already exists — reconfiguring it in place"
  Run { & nssm stop $ServiceName | Out-Null } "stop $ServiceName"
} else {
  Run { & nssm install $ServiceName $nodePath $serverJs | Out-Null } "install $ServiceName"
}

Run {
  & nssm set $ServiceName Application         $nodePath      | Out-Null
  & nssm set $ServiceName AppParameters       $serverJs      | Out-Null
  & nssm set $ServiceName AppDirectory        $InstallPath   | Out-Null
  & nssm set $ServiceName DisplayName         "Purchasing Control Center ($ServiceName)" | Out-Null
  & nssm set $ServiceName Description         "PCC — purchasing requests, approvals and purchase orders." | Out-Null
  & nssm set $ServiceName Start               SERVICE_AUTO_START | Out-Null
  & nssm set $ServiceName ObjectName          $ServiceAcct   | Out-Null
  & nssm set $ServiceName AppEnvironmentExtra "PCC_ENV_FILE=$envAbs" | Out-Null
  # Crashes restart; deliberate refusals do not. A configuration refusal exits 1,
  # and restarting it would bury the one line that says what is wrong.
  & nssm set $ServiceName AppExit Default     Restart        | Out-Null
  & nssm set $ServiceName AppExit 1           Exit           | Out-Null
  & nssm set $ServiceName AppRestartDelay     5000           | Out-Null
  & nssm set $ServiceName AppThrottle         300000         | Out-Null
  # Windows has no journal. Without this, stdout goes nowhere and a failed start
  # is silent. Rotation is set here because nothing else will do it.
  & nssm set $ServiceName AppStdout           (Join-Path $LogDir "$ServiceName.out.log") | Out-Null
  & nssm set $ServiceName AppStderr           (Join-Path $LogDir "$ServiceName.err.log") | Out-Null
  & nssm set $ServiceName AppRotateFiles      1              | Out-Null
  & nssm set $ServiceName AppRotateOnline     1              | Out-Null
  & nssm set $ServiceName AppRotateBytes      10485760       | Out-Null
} "configure $ServiceName"
Ok "configured to start automatically; a refusal (exit 1) stops rather than loops"

Step "starting PCC"
Run { & nssm start $ServiceName | Out-Null } "start $ServiceName"

if ($DryRun) {
  Write-Host ""
  Write-Host "-DryRun: nothing was placed, configured, started or changed."
  exit 0
}

# --- 10. verify -------------------------------------------------------------
Step "verifying health"
$port      = if (Cfg 'PORT') { Cfg 'PORT' } else { '3000' }
$healthUrl = "http://127.0.0.1:$port"
$ready = $null
foreach ($attempt in 1..60) {
  try {
    $ready = Invoke-RestMethod -Uri "$healthUrl/api/health" -TimeoutSec 5 -ErrorAction Stop
    break
  } catch { Start-Sleep -Seconds 2 }
}

if (-not $ready) {
  Fatal @"
readiness did not answer at $healthUrl/api/health
  The service is registered but PCC is not serving. Read the refusal:
    Get-Content "$LogDir\$ServiceName.err.log" -Tail 50
  A configuration refusal exits 1 and STAYS stopped by design — the log says why.
"@
}
if ($ready.status -ne 'ok') { Fatal "readiness reports a problem: $($ready | ConvertTo-Json -Compress)" }
Ok "readiness: healthy"

try {
  $live = Invoke-RestMethod -Uri "$healthUrl/api/health/live" -TimeoutSec 5 -ErrorAction Stop
  Ok "liveness: alive"
} catch { Fatal "liveness did not answer" }

$svc = Get-Service -Name $ServiceName
Ok "service '$ServiceName' is $($svc.Status), start type $($svc.StartType)"

# --- 11. what this script will not do for you ------------------------------
@"

=== INSTALLED. The rest is not automatable — do these by hand ===

  1. Sign in as the bootstrap administrator through the HTTPS address,
     and CHANGE THE TEMPORARY PASSWORD.

  2. Remove PCC_DATABASE_ALLOW_CREATE and PCC_BOOTSTRAP_ADMIN_PASSWORD from
     $EnvFile, then: nssm restart $ServiceName
     The log must then say "opening the existing purchasing database".

  3. Turn on the nightly verified backup:
        .\scripts\install-backup-task.ps1 -DataDir "$DataAbs" -Repo "$RootAbs"

  4. REBOOT RDS02 and confirm PCC comes back with nobody logging in.
     Nothing before this proves reboot survival — auto-start is a setting,
     not a proof.

  5. Run the production verification, and keep the output:
        node scripts\pcc-verify-deployment.mjs --service $ServiceName
     It must end with: READY FOR ACCEPTANCE TESTING

  6. Work through docs\deployment\PCC_PRODUCTION_ACCEPTANCE.md.

  NOT DONE BY THIS SCRIPT, and not by any script:
     · the purchase order sequence — it comes from the office's paper book,
       and PCC refuses to issue a PO until an administrator sets it
     · HTTPS, DNS, IIS, the reverse proxy, the firewall — Lippolis IT
     · offsite copies, retention and encryption of the backups this schedule
       produces — Lippolis IT's existing platform
"@ | Write-Host
