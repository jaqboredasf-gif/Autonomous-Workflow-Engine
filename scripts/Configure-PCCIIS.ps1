<#
-----------------------------------------------------------------------------
Configure-PCCIIS.ps1 — the reverse proxy in front of PCC.

THE TOPOLOGY, WHICH IS THE WHOLE DESIGN:

    Mike/Rick browser
      --> HTTPS 443 on the LAN
        --> IIS on LIPELE-RDS02   (terminates TLS)
          --> http://127.0.0.1:3000  (PCC, loopback only)
            --> C:\ProgramData\pcc\data\pcc.sqlite

PCC never terminates TLS and never listens on the LAN. That is not a
limitation to work around later — it is what makes the certificate, the
hostname and the eventual public-access decision infrastructure concerns that
can change without the application changing. Moving from 192.168.10.152 to
pcc.lippoliselectric.com is a binding here and one line in the environment
file; PCC is not rebuilt and not redesigned.

TWO PHASES, BECAUSE THE CERTIFICATE ARRIVES LATER THAN THE SERVER.

  -Phase Http    an HTTP-only site on the LAN IP, so the whole chain can be
                 proven before a certificate exists. Sign-in works because the
                 environment file states PCC_ALLOW_INSECURE_HTTP=1 — a
                 deliberate, recorded decision, correct only on a trusted
                 internal network and only until the certificate lands.
  -Phase Https   binds 443 to a certificate and (unless -KeepHttp) removes the
                 HTTP binding. This is the production state.

  .\scripts\Configure-PCCIIS.ps1 -Phase Http
  .\scripts\Configure-PCCIIS.ps1 -Phase Https -CertThumbprint ABC123... -Hostname pcc.lippoliselectric.com
  .\scripts\Configure-PCCIIS.ps1 -Phase Https -CertThumbprint ABC123...            # IP-only, no SNI

Idempotent: re-running assigns the same configuration rather than adding a
second site, a second binding or a second rewrite rule.
-----------------------------------------------------------------------------
#>

[CmdletBinding()]
param(
  [ValidateSet('Http','Https')][string] $Phase = 'Http',
  [string] $SiteName       = 'PCC',
  [string] $BackendPort    = '3000',
  [string] $ListenAddress  = '192.168.10.152',
  [string] $Hostname       = '',
  [string] $CertThumbprint = '',
  [string] $SitePath       = 'C:\inetpub\pcc',
  [switch] $KeepHttp
)

$ErrorActionPreference = 'Stop'

function Ok    ($m) { Write-Host "  ok  $m" }
function Warn  ($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }
function Fatal ($m) { Write-Host ""; Write-Host "FATAL: $m" -ForegroundColor Red; exit 1 }
function Step  ($m) { Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fatal 'this must run in an elevated PowerShell (Run as Administrator).'
}

Import-Module WebAdministration -ErrorAction Stop

# --- 1. ARR proxying --------------------------------------------------------
# ARR ships installed but with proxying OFF, and this is the single most common
# cause of a correct-looking site returning 404 for every request.
Step 'enabling ARR proxying'
Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -Value 'True'
# Do not let ARR rewrite the Host header: PCC builds absolute URLs from
# APP_BASE_URL, and a rewritten host produces password-reset links pointing at
# 127.0.0.1 that work for nobody.
Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'preserveHostHeader' -Value 'True'
Ok 'ARR proxying enabled, host header preserved'

# --- 2. the site ------------------------------------------------------------
Step "creating the site '$SiteName'"
New-Item -ItemType Directory -Force -Path $SitePath | Out-Null

if (-not (Test-Path "IIS:\Sites\$SiteName")) {
  New-Website -Name $SiteName -PhysicalPath $SitePath -Port 80 -IPAddress $ListenAddress -Force | Out-Null
  Ok "created, listening on $ListenAddress"
} else {
  Ok 'already exists — reconfiguring in place'
}

# The site serves nothing of its own; every request is proxied. An application
# pool with no managed runtime is the correct shape for that and one less thing
# loaded into the worker process.
$pool = (Get-Item "IIS:\Sites\$SiteName").applicationPool
Set-ItemProperty "IIS:\AppPools\$pool" -Name managedRuntimeVersion -Value ''
Ok "application pool '$pool' set to No Managed Code"

# --- 3. the rewrite rule ----------------------------------------------------
# Written as web.config rather than through Set-WebConfiguration: it is one
# file an administrator can read, diff and copy, and it travels with the site.
Step 'writing the reverse-proxy rule'
$webConfig = @"
<?xml version="1.0" encoding="UTF-8"?>
<!--
  PCC reverse proxy. Every request is forwarded to the PCC service on the
  loopback interface; IIS terminates TLS and PCC never listens on the LAN.

  X-Forwarded-* are set so the application can see the scheme and the client
  address it was actually reached on, rather than the loopback hop.
-->
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="PCC reverse proxy" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:$BackendPort/{R:1}" />
          <serverVariables>
            <set name="HTTP_X_FORWARDED_PROTO" value="{MapScheme:{HTTPS}}" />
            <set name="HTTP_X_FORWARDED_HOST"  value="{HTTP_HOST}" />
            <set name="HTTP_X_FORWARDED_FOR"   value="{REMOTE_ADDR}" />
          </serverVariables>
        </rule>
      </rules>
      <rewriteMaps>
        <rewriteMap name="MapScheme">
          <add key="on"  value="https" />
          <add key="off" value="http" />
        </rewriteMap>
      </rewriteMaps>
    </rewrite>
    <!--
      The upload ceiling. PCC carries delivery evidence (photographs of what
      arrived), and IIS's 30 MB default request limit rejects a large one with
      a 404.13 that looks like a broken page rather than a size problem.
    -->
    <security>
      <requestFiltering>
        <requestLimits maxAllowedContentLength="52428800" />
      </requestFiltering>
    </security>
    <httpErrors errorMode="Detailed" />
  </system.webServer>
</configuration>
"@
Set-Content -LiteralPath (Join-Path $SitePath 'web.config') -Value $webConfig -Encoding UTF8
Ok 'web.config written (proxy rule, X-Forwarded-*, 50 MB upload ceiling)'

# The server variables must be allowed before a rule may set them.
foreach ($v in @('HTTP_X_FORWARDED_PROTO','HTTP_X_FORWARDED_HOST','HTTP_X_FORWARDED_FOR')) {
  $existing = Get-WebConfiguration -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter "system.webServer/rewrite/allowedServerVariables/add[@name='$v']"
  if (-not $existing) {
    Add-WebConfiguration -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/rewrite/allowedServerVariables' -Value @{ name = $v }
  }
}
Ok 'X-Forwarded-* server variables allowed'

# --- 4. bindings ------------------------------------------------------------
Step "binding for phase: $Phase"
if ($Phase -eq 'Https') {
  if (-not $CertThumbprint) { Fatal '-CertThumbprint is required for -Phase Https. Get it from: Get-ChildItem Cert:\LocalMachine\My' }
  $cert = Get-ChildItem "Cert:\LocalMachine\My\$CertThumbprint" -ErrorAction SilentlyContinue
  if (-not $cert) { Fatal "no certificate with thumbprint $CertThumbprint in LocalMachine\My" }
  if ($cert.NotAfter -lt (Get-Date)) { Fatal "that certificate expired on $($cert.NotAfter)" }
  Ok "certificate: $($cert.Subject), expires $($cert.NotAfter.ToString('yyyy-MM-dd'))"

  $existing443 = Get-WebBinding -Name $SiteName -Protocol https -ErrorAction SilentlyContinue
  if (-not $existing443) {
    if ($Hostname) { New-WebBinding -Name $SiteName -Protocol https -Port 443 -IPAddress $ListenAddress -HostHeader $Hostname -SslFlags 1 }
    else           { New-WebBinding -Name $SiteName -Protocol https -Port 443 -IPAddress $ListenAddress }
  }
  $b = Get-WebBinding -Name $SiteName -Protocol https
  $b.AddSslCertificate($CertThumbprint, 'My')
  Ok "https bound on ${ListenAddress}:443$(if ($Hostname) { " for $Hostname" })"

  if (-not $KeepHttp) {
    Get-WebBinding -Name $SiteName -Protocol http -ErrorAction SilentlyContinue | Remove-WebBinding
    Ok 'http binding removed — HTTPS only'
    Warn 'Set APP_BASE_URL in the environment file to the https:// address and restart the service,'
    Warn 'or every sign-in will bounce back to the sign-in page: the session cookie becomes Secure'
    Warn 'and the browser will not return it over plain HTTP.'
  } else {
    Warn 'http binding kept by request — plain HTTP remains reachable on the LAN.'
  }
} else {
  Ok "http on ${ListenAddress}:80 — validation phase, no certificate needed"
  Warn 'PCC_ALLOW_INSECURE_HTTP=1 must be set in the environment file for sign-in to work,'
  Warn 'and APP_BASE_URL must be the http:// address. Both change when the certificate lands.'
}

# --- 5. prove it ------------------------------------------------------------
Step 'restarting IIS and checking the chain'
iisreset /restart | Out-Null

$scheme = if ($Phase -eq 'Https') { 'https' } else { 'http' }
$host_ = if ($Hostname) { $Hostname } else { $ListenAddress }
$url = "${scheme}://${host_}/api/health"

# The backend first: if PCC itself is not answering, the proxy is not the fault.
try {
  $backend = Invoke-RestMethod "http://127.0.0.1:$BackendPort/api/health" -TimeoutSec 10
  Ok "backend answers on 127.0.0.1:$BackendPort — status $($backend.status), release $($backend.release)"
} catch {
  Fatal "the PCC service is not answering on 127.0.0.1:$BackendPort. IIS is configured, but there is nothing behind it. Check: Get-Service pcc"
}

try {
  $through = Invoke-RestMethod $url -TimeoutSec 15
  Ok "through IIS at $url — status $($through.status)"
  Write-Host ''
  Write-Host "PCC is reachable at ${scheme}://${host_}/" -ForegroundColor Green
} catch {
  Warn "could not reach $url from this machine: $($_.Exception.Message)"
  Warn 'The backend is healthy, so this is the proxy, the binding, the firewall or DNS.'
  Warn 'Check in order: the site is Started, ARR proxying is on, 443 is open, the name resolves.'
  exit 1
}
