<#
-----------------------------------------------------------------------------
preflight-windows.ps1 — is THIS SERVER ready to have PCC installed on it?

Run this on LIPELE-RDS02 BEFORE the installer, ideally before the deployment
session, so infrastructure problems are found while Jose is still at his desk
rather than while four people are watching a screen.

IT CHANGES NOTHING. Every check reads. The one exception is a write-and-delete
probe in the data directory, which is the only way to know the service account
will be able to write there, and it removes what it wrote.

WHAT IT DOES NOT DUPLICATE. scripts/pcc-preflight.mjs already checks the things
that are PCC's rather than Windows's: runtime version and capabilities, the data
path being absolute and writable and outside the source tree, free space, port
availability, required variables, secret strength, base URL, and whether a
datastore is present or would be created. This runs those too, by calling it —
one implementation, one report format. What is added here is the layer it
cannot see: Windows itself, IIS, the proxy modules, the supervisor, and whether
a conflicting service is already registered.

  .\scripts\preflight-windows.ps1
  .\scripts\preflight-windows.ps1 -EnvFile C:\ProgramData\pcc\pcc.env -DataDir C:\ProgramData\pcc\data
  .\scripts\preflight-windows.ps1 -Artifact .\dist\pcc -Json

Exit 0 = no blockers. Exit 1 = at least one BLOCKER. Warnings never fail the
run on their own: "I could not check this from here" is not "this is broken",
and a preflight that cries wolf is a preflight people stop reading.
-----------------------------------------------------------------------------
#>

[CmdletBinding()]
param(
  [string] $EnvFile     = 'C:\ProgramData\pcc\pcc.env',
  [string] $DataDir     = 'C:\ProgramData\pcc\data',
  [string] $Artifact    = '.\dist\pcc',
  [string] $ServiceName = 'pcc',
  [int]    $Port        = 3000,
  [int]    $MinFreeGB   = 10,
  [switch] $Json
)

$ErrorActionPreference = 'Continue'
$results = @()

function Report ($area, $id, $status, $detail, $fix = $null) {
  $script:results += [pscustomobject]@{
    area = $area; id = $id; status = $status; detail = $detail; fix = $fix
  }
}
function Pass    ($a, $i, $d)        { Report $a $i 'PASS'    $d }
function Warning ($a, $i, $d, $f)    { Report $a $i 'WARNING' $d $f }
function Blocker ($a, $i, $d, $f)    { Report $a $i 'BLOCKER' $d $f }

# --- the operating system ---------------------------------------------------
$os = Get-CimInstance Win32_OperatingSystem
$caption = $os.Caption
$build = [int]$os.BuildNumber
if ($caption -match 'Server') {
  # 17763 is Server 2019. Older is not refused outright — PCC is a Node process
  # and does not care — but it is worth saying that nobody has run it there.
  if ($build -ge 17763) { Pass 'Windows' 'os.version' "$caption (build $build)" }
  else { Warning 'Windows' 'os.version' "$caption (build $build) is older than Server 2019" 'PCC should still run; nobody has tried it on this build.' }
} else {
  Warning 'Windows' 'os.version' "$caption is not a Server edition" 'Fine for a trial; production is expected on Windows Server.'
}
Pass 'Windows' 'os.hostname' "$env:COMPUTERNAME"

$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Pass 'Windows' 'os.elevated' 'running elevated'
} else {
  Blocker 'Windows' 'os.elevated' 'not running as Administrator' 'Some checks below cannot run, and the installer requires elevation. Re-run in an elevated PowerShell.'
}

# --- the runtime ------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Blocker 'Runtime' 'node.present' 'node is not installed or not on PATH' 'Install Node.js 24 LTS (x64 MSI) from https://nodejs.org'
} else {
  $v = (& node --version).TrimStart('v')
  $major = [int]($v.Split('.')[0])
  if ($major -ge 24) {
    Pass 'Runtime' 'node.version' "node $v at $($node.Source)"
  } else {
    # node:sqlite is part of the runtime, not a dependency. On 20 the import
    # fails at startup with an error that names nothing anybody can act on.
    Blocker 'Runtime' 'node.version' "node $v is too old" 'PCC needs Node 24+: the purchasing store is node:sqlite, which is not present before it.'
  }
}

# --- the supervisor ---------------------------------------------------------
$nssm = Get-Command nssm -ErrorAction SilentlyContinue
if ($nssm) {
  Pass 'Service' 'nssm.present' "nssm at $($nssm.Source)"
} else {
  Blocker 'Service' 'nssm.present' 'nssm is not installed or not on PATH' 'Place nssm.exe in C:\Program Files\nssm and add it to PATH. It supervises the PCC process; see deployment/adapters/windows-service.mjs for why not Task Scheduler.'
}

# --- a service already there ------------------------------------------------
# Not a blocker: a reinstall over an existing service is the normal upgrade
# path and install-production.ps1 reconfigures in place. It is a blocker only
# when nobody expected it, which is why it is reported rather than assumed.
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Warning 'Service' 'service.existing' "a service named '$ServiceName' already exists (state: $($existing.Status))" 'If this is an upgrade, expected — the installer reconfigures in place. If this is a first install, find out what it is before continuing.'
} else {
  Pass 'Service' 'service.existing' "no service named '$ServiceName' yet"
}

# --- IIS and the proxy chain ------------------------------------------------
$iis = Get-Service -Name W3SVC -ErrorAction SilentlyContinue
if ($iis) {
  Pass 'IIS' 'iis.present' "IIS present (W3SVC: $($iis.Status))"
} else {
  Blocker 'IIS' 'iis.present' 'IIS (W3SVC) is not installed' 'Install-WindowsFeature Web-Server -IncludeManagementTools'
}

# URL Rewrite and ARR are separate downloads and are the two most commonly
# missed pieces. Without them IIS installs happily and proxies nothing.
$rewrite = Test-Path 'HKLM:\SOFTWARE\Microsoft\IIS Extensions\URL Rewrite'
if ($rewrite) { Pass 'IIS' 'iis.url_rewrite' 'URL Rewrite is installed' }
else { Blocker 'IIS' 'iis.url_rewrite' 'URL Rewrite is not installed' 'Download URL Rewrite 2.1 from https://www.iis.net/downloads/microsoft/url-rewrite' }

$arr = Test-Path 'HKLM:\SOFTWARE\Microsoft\IIS Extensions\Application Request Routing'
if ($arr) { Pass 'IIS' 'iis.arr' 'Application Request Routing is installed' }
else { Blocker 'IIS' 'iis.arr' 'ARR is not installed' 'Download ARR 3.0 from https://www.iis.net/downloads/microsoft/application-request-routing' }

# ARR ships installed but with proxying OFF. This is the single most common
# cause of a correct-looking IIS site returning 404 for everything.
if ($arr) {
  try {
    Import-Module WebAdministration -ErrorAction Stop
    $proxy = Get-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -ErrorAction Stop
    if ($proxy.Value) { Pass 'IIS' 'iis.arr_proxy_enabled' 'ARR proxying is enabled' }
    else { Warning 'IIS' 'iis.arr_proxy_enabled' 'ARR is installed but proxying is DISABLED' 'Configure-PCCIIS.ps1 turns it on. Without it every proxied request 404s.' }
  } catch {
    Warning 'IIS' 'iis.arr_proxy_enabled' 'could not read the ARR proxy setting' 'Check it in IIS Manager > server > Application Request Routing Cache > Server Proxy Settings.'
  }
}

# --- certificates -----------------------------------------------------------
$certs = @(Get-ChildItem Cert:\LocalMachine\My -ErrorAction SilentlyContinue |
           Where-Object { $_.NotAfter -gt (Get-Date) })
if ($certs.Count -gt 0) {
  Pass 'IIS' 'tls.certificate' "$($certs.Count) unexpired certificate(s) in LocalMachine\My"
} else {
  Warning 'IIS' 'tls.certificate' 'no unexpired certificate in LocalMachine\My' 'A LAN TLS certificate is needed before HTTPS. Internal CA preferred over self-signed so users see no warning. IP-only HTTP validation can proceed without it.'
}

# --- the network ------------------------------------------------------------
# The backend port must be FREE. It is also deliberately not exposed: PCC binds
# to loopback and IIS reaches it there.
$inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
  $owner = (Get-Process -Id $inUse[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
  if ($existing) {
    Warning 'Network' 'port.free' "port $Port is in use by '$owner' — expected if PCC is already running" 'The installer stops the service before reconfiguring.'
  } else {
    Blocker 'Network' 'port.free' "port $Port is already in use by '$owner'" "Free the port or install PCC on another with PORT= in the environment file."
  }
} else {
  Pass 'Network' 'port.free' "port $Port is free"
}

$rule443 = Get-NetFirewallRule -ErrorAction SilentlyContinue |
           Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' } |
           Where-Object { ($_ | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue).LocalPort -contains '443' }
if ($rule443) { Pass 'Network' 'firewall.443' 'an inbound rule for TCP 443 exists' }
else { Warning 'Network' 'firewall.443' 'no enabled inbound rule for TCP 443 found' 'Jose opens 443 from the LAN. Not needed for loopback validation.' }

# --- the filesystem ---------------------------------------------------------
if (Test-Path -LiteralPath $DataDir -PathType Container) {
  Pass 'Storage' 'data.exists' "$DataDir exists"
  # The only write this script performs, and it removes it.
  $probe = Join-Path $DataDir ".pcc-preflight-probe"
  try {
    Set-Content -LiteralPath $probe -Value 'probe' -ErrorAction Stop
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    Pass 'Storage' 'data.writable' 'the data directory is writable by this account'
  } catch {
    Blocker 'Storage' 'data.writable' "cannot write to $DataDir" 'The installer applies icacls, but this account must be able to create the directory contents now.'
  }
} else {
  # NOT a blocker here: the installer deliberately refuses to create it, and an
  # operator creating it on purpose is the check that a typo is not silently
  # becoming a second, empty purchasing system.
  Warning 'Storage' 'data.exists' "$DataDir does not exist yet" "Create it deliberately before installing: New-Item -ItemType Directory -Force -Path `"$DataDir`""
}

$drive = (Split-Path -Qualifier $DataDir)
try {
  $free = [math]::Round((Get-PSDrive ($drive.TrimEnd(':'))).Free / 1GB, 1)
  if ($free -ge $MinFreeGB) { Pass 'Storage' 'disk.free' "$free GB free on $drive" }
  else { Warning 'Storage' 'disk.free' "$free GB free on $drive (below $MinFreeGB GB)" 'The database is small; 30 nightly backups beside it are not. Check retention if this is tight.' }
} catch {
  Warning 'Storage' 'disk.free' "could not read free space on $drive" $null
}

# --- the artifact -----------------------------------------------------------
if (Test-Path -LiteralPath $Artifact -PathType Container) {
  $server = Join-Path $Artifact 'apps\purchasing\server.js'
  $static = Join-Path $Artifact 'apps\purchasing\.next\static'
  $relFile = Join-Path $Artifact 'apps\purchasing\RELEASE'
  if (Test-Path -LiteralPath $server) { Pass 'Artifact' 'artifact.server' 'server.js is present' }
  else { Blocker 'Artifact' 'artifact.server' "no server.js under $Artifact" 'Rebuild: npm run build --workspace purchasing' }
  # Without static the application renders unstyled while every check says fine.
  if (Test-Path -LiteralPath $static) { Pass 'Artifact' 'artifact.static' '.next/static is present' }
  else { Blocker 'Artifact' 'artifact.static' '.next/static is missing' 'The page would render with no styling and no logo. Rebuild: node scripts\stage-standalone.mjs' }
  if (Test-Path -LiteralPath $relFile) {
    $rel = (Get-Content -LiteralPath $relFile -Raw).Trim()
    if ($rel -match '-dirty') { Warning 'Artifact' 'artifact.release' "release: $rel" 'Built from uncommitted changes — cannot be reproduced from a commit. Not the installation of record.' }
    else { Pass 'Artifact' 'artifact.release' "release: $rel" }
  } else {
    Warning 'Artifact' 'artifact.release' 'no RELEASE file' '/api/health will report release: null. Rebuild with node scripts\stage-standalone.mjs'
  }
} else {
  Warning 'Artifact' 'artifact.present' "no artifact at $Artifact" 'Pass -Artifact, or copy the build across before installing.'
}

# --- the configuration ------------------------------------------------------
if (Test-Path -LiteralPath $EnvFile -PathType Leaf) {
  Pass 'Configuration' 'env.exists' "$EnvFile exists"
  $cfg = @{}
  foreach ($line in Get-Content -LiteralPath $EnvFile) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { continue }
    $cfg[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
  }
  # PRESENT or MISSING and nothing else. Never a value, a length or a prefix:
  # this output gets pasted into tickets.
  foreach ($required in @('NODE_ENV','SESSION_SECRET','PCC_DATABASE_PATH','APP_BASE_URL',
                          'PCC_PO_NUMBERING','PCC_ORG_NAME','PCC_ORG_ADDRESS','PCC_ORG_PHONE')) {
    if ($cfg.ContainsKey($required) -and $cfg[$required]) {
      Pass 'Configuration' "env.$required" 'PRESENT'
    } else {
      Blocker 'Configuration' "env.$required" 'MISSING' "PCC refuses to start without it. See config\production.env.template."
    }
  }
} else {
  Warning 'Configuration' 'env.exists' "$EnvFile does not exist yet" "Copy config\production.env.template and fill it in. It must live outside the source checkout."
}

# --- hand the rest to the checker that already exists -----------------------
if ($node -and (Test-Path -LiteralPath 'scripts\pcc-preflight.mjs')) {
  Write-Host ''
  Write-Host '== handing over to scripts\pcc-preflight.mjs (the PCC-level checks)' -ForegroundColor Cyan
  & node scripts\pcc-preflight.mjs --data "$DataDir" --port $Port
  if ($LASTEXITCODE -ne 0) {
    Report 'PCC preflight' 'pcc.preflight' 'BLOCKER' 'scripts\pcc-preflight.mjs reported problems (above)' 'Fix them and run this again.'
  } else {
    Report 'PCC preflight' 'pcc.preflight' 'PASS' 'scripts\pcc-preflight.mjs found no problems'
  }
}

# --- the report -------------------------------------------------------------
if ($Json) {
  $results | ConvertTo-Json -Depth 4
} else {
  Write-Host ''
  Write-Host '=============================================================='
  Write-Host '  PCC WINDOWS PREFLIGHT — LIPELE-RDS02'
  Write-Host '=============================================================='
  foreach ($area in ($results | Select-Object -ExpandProperty area -Unique)) {
    Write-Host ''
    Write-Host "-- $area"
    foreach ($r in ($results | Where-Object area -eq $area)) {
      $colour = switch ($r.status) { 'PASS' { 'Green' } 'WARNING' { 'Yellow' } default { 'Red' } }
      Write-Host ("  {0,-8} {1,-26} {2}" -f $r.status, $r.id, $r.detail) -ForegroundColor $colour
      if ($r.fix) { Write-Host "           -> $($r.fix)" -ForegroundColor DarkGray }
    }
  }
}

$blockers = @($results | Where-Object status -eq 'BLOCKER')
$warnings = @($results | Where-Object status -eq 'WARNING')
Write-Host ''
Write-Host ("{0} pass, {1} warning(s), {2} blocker(s)" -f
  @($results | Where-Object status -eq 'PASS').Count, $warnings.Count, $blockers.Count)

if ($blockers.Count) {
  Write-Host ''
  Write-Host 'NOT READY TO INSTALL. Clear the blockers above first.' -ForegroundColor Red
  exit 1
}
Write-Host ''
Write-Host 'READY TO INSTALL.' -ForegroundColor Green
exit 0
