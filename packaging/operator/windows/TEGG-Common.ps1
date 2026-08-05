# TEGG Report Tool - shared helpers for the Windows launchers.
#
# Dot-sourced by Setup.ps1, Check Setup.ps1, Run Report.ps1 and Diagnostic.ps1.
# There is one copy of this logic rather than four, because four copies of
# "find Python" is how three of them quietly go wrong.
#
# Deliberately ASCII-only and Windows PowerShell 5.1 compatible: 5.1 reads a
# .ps1 without a byte-order mark as ANSI, so a stray Unicode character becomes
# mojibake on somebody else's machine, and 5.1 is the only shell every Windows
# box is guaranteed to have.

# No Set-StrictMode on purpose. Strict mode turns a never-assigned variable
# into a terminating error, and half of what these scripts touch -- $matches,
# $LASTEXITCODE, environment variables that may not exist -- is exactly that.
# An operator tool must degrade into a readable message, not a stack trace.

# The minimum Python this tool runs on, as (major * 100 + minor).
$script:MinPythonCode = 310
$script:MinPythonText = '3.10'

# Where the sign-in is kept. Outside the tool folder on purpose: the folder
# gets zipped, copied and mailed around, and a credential must never be in it.
function Get-CredentialStorePath {
    $base = $env:LOCALAPPDATA
    if (-not $base) { $base = Join-Path $env:USERPROFILE 'AppData\Local' }
    return (Join-Path $base 'TEGG Report Tool\credentials.dat')
}

# ---------------------------------------------------------------- output ---
function Write-Say  { param([string]$Text = '') Write-Host $Text }
function Write-Head {
    param([string]$Text)
    Write-Host ''
    Write-Host $Text
    Write-Host ('-' * $Text.Length)
}
function Write-Ok   { param([string]$Text) Write-Host ('  OK       ' + $Text) }
function Write-Bad  { param([string]$Text) Write-Host ('  PROBLEM  ' + $Text) }
function Write-Warn { param([string]$Text) Write-Host ('  WARNING  ' + $Text) }

# Every launcher ends here, so a double-clicked window never vanishes before
# the person in front of it has read why.
function Complete-Script {
    param([int]$Code = 0)
    Write-Host ''
    Write-Host 'Press Enter to close this window.'
    try { [void](Read-Host) } catch { }
    exit $Code
}

# ---------------------------------------------------------------- python ---

# Does this executable answer as a Python new enough to run the tool?
# Returns a hashtable, or $null. Never throws.
function Test-PythonCandidate {
    param([string]$Exe)

    if (-not $Exe) { return $null }
    # The Microsoft Store "app execution alias" is a stub that opens the Store
    # and reports success at doing so. It is not a Python.
    if ($Exe -like '*\WindowsApps\*') { return $null }

    $code = $null
    $real = $null
    $text = $null
    try {
        # No quote characters in any of these snippets: PowerShell mangles
        # embedded double quotes on their way to a native executable.
        #
        # And the whole output is collected before anything is taken from it.
        # `... | Select-Object -First 1` reads the first line and then stops the
        # pipeline, which leaves $LASTEXITCODE holding whatever the *previous*
        # native command set -- so a perfectly good Python was rejected because
        # the exit code being tested was never the one it returned.
        $codeOut = @(& $Exe -c 'import sys; print(sys.version_info[0]*100+sys.version_info[1])' 2>$null)
        if ($LASTEXITCODE -ne 0) { return $null }
        $realOut = @(& $Exe -c 'import sys; print(sys.executable)' 2>$null)
        $textOut = @(& $Exe -c 'import sys; print(sys.version.split()[0])' 2>$null)
        if ($codeOut.Count -gt 0) { $code = $codeOut[0] }
        if ($realOut.Count -gt 0) { $real = $realOut[0] }
        if ($textOut.Count -gt 0) { $text = $textOut[0] }
    } catch {
        return $null
    }

    if (-not $code) { return $null }
    $code = ($code -as [int])
    if (-not $code) { return $null }
    if (-not $real) { $real = $Exe }

    return @{
        Path       = $real.Trim()
        Command    = $Exe
        VersionInt = $code
        Version    = $(if ($text) { $text.Trim() } else { 'unknown' })
        Supported  = ($code -ge $script:MinPythonCode)
    }
}

# Everything on this machine that answers as a Python, best first.
# Read-only: it installs nothing and changes nothing.
function Get-PythonCandidates {
    $seen = @{}
    $found = @()

    $tries = @()

    # The py launcher first: it is the documented way to pick a version on
    # Windows and it is not shadowed by the Store stub.
    if (Get-Command 'py' -ErrorAction SilentlyContinue) {
        foreach ($tag in @('-3.13', '-3.12', '-3.11', '-3.10', '-3')) {
            $probe = @()
            try { $probe = @(& py $tag -c 'import sys; print(sys.executable)' 2>$null) } catch { }
            if ($probe.Count -gt 0 -and $probe[0]) { $tries += ([string]$probe[0]).Trim() }
        }
    }

    foreach ($name in @('python', 'python3')) {
        foreach ($command in @(Get-Command $name -All -ErrorAction SilentlyContinue)) {
            if ($command.Source) { $tries += $command.Source }
        }
    }

    # The usual installer locations, in case PATH was never set up.
    $patterns = @(
        'C:\Program Files\Python3*\python.exe',
        'C:\Program Files (x86)\Python3*\python.exe',
        'C:\Python3*\python.exe'
    )
    # Guarded: a locked-down or service profile can have no LOCALAPPDATA, and
    # Join-Path on a null path is a red error line in the middle of a check
    # that is supposed to read as calm.
    if ($env:LOCALAPPDATA) {
        $patterns += (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python3*\python.exe')
    }
    foreach ($pattern in $patterns) {
        foreach ($hit in @(Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue)) {
            $tries += $hit.FullName
        }
    }

    foreach ($candidate in $tries) {
        $key = $candidate.ToLower()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $result = Test-PythonCandidate -Exe $candidate
        if ($result) {
            $resultKey = $result.Path.ToLower()
            if ($seen.ContainsKey($resultKey) -and $resultKey -ne $key) { continue }
            $seen[$resultKey] = $true
            $found += $result
        }
    }

    return @($found | Sort-Object -Property VersionInt -Descending)
}

# The newest supported Python, or $null.
function Find-SupportedPython {
    foreach ($candidate in @(Get-PythonCandidates)) {
        if ($candidate.Supported) { return $candidate }
    }
    return $null
}

# --------------------------------------------------------------- the venv --
function Get-VenvPython    { param([string]$Root) return (Join-Path $Root '.venv\Scripts\python.exe') }
function Get-VenvTool      { param([string]$Root) return (Join-Path $Root '.venv\Scripts\awe-tegg.exe') }
function Test-ToolInstalled {
    param([string]$Root)
    return (Test-Path -LiteralPath (Get-VenvTool -Root $Root))
}

# ----------------------------------------------------------- run folders ---
#
# The most recent run folder, or $null. Used to tell the operator where their
# documents and their email draft actually are, and to name the run they can
# carry on from. -LiteralPath throughout: the installation path routinely
# contains a space ("C:\Users\Paul Smith\TEGG Report Tool") and every one of
# these calls has been wrong about that at least once.
function Get-LatestRunFolder {
    param([string]$Root)
    $operations = Join-Path $Root 'work\operations'
    if (-not (Test-Path -LiteralPath $operations)) { return $null }
    return (Get-ChildItem -LiteralPath $operations -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1)
}

# ---------------------------------------------------------- credentials ----
#
# Stored with the Windows Data Protection API, through PowerShell's own
# ConvertFrom-SecureString. The file that results can only be decrypted by this
# Windows user on this machine: copying it elsewhere yields nothing. It is the
# same mechanism a saved network password uses, and it is the Windows answer to
# what the macOS package does with the Keychain.
#
# The password is held as a SecureString for as long as PowerShell allows, and
# is only ever turned back into text at the moment it is handed to the tool as
# an environment variable for that one process.

function Save-TeggCredential {
    # The analyzer objects to ConvertTo-SecureString -AsPlainText on principle,
    # and it is right to in general. Here the plain-text value being converted
    # is the *username*, which is not a secret and which arrived as typed text
    # because that is what Read-Host gives you. The password is never plain
    # text in this function: it arrives as a SecureString and is encrypted
    # straight out of one.
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute(
        'PSAvoidUsingConvertToSecureStringWithPlainText', '',
        Justification = 'Converts the username, not the password.')]
    param(
        [Parameter(Mandatory = $true)][string]$Username,
        [Parameter(Mandatory = $true)][System.Security.SecureString]$Password
    )
    $path = Get-CredentialStorePath
    $folder = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $folder)) {
        [void](New-Item -ItemType Directory -Path $folder -Force)
    }

    $userSecure = ConvertTo-SecureString -String $Username -AsPlainText -Force
    $lines = @(
        (ConvertFrom-SecureString -SecureString $userSecure),
        (ConvertFrom-SecureString -SecureString $Password)
    )
    Set-Content -LiteralPath $path -Value $lines -Encoding ASCII

    # Only this user should be able to read it, even though what is in it is
    # useless to anybody else. Belt and braces, and it costs nothing.
    try {
        $acl = Get-Acl -LiteralPath $path
        $acl.SetAccessRuleProtection($true, $false)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            "$env:USERDOMAIN\$env:USERNAME", 'FullControl', 'Allow')
        $acl.SetAccessRule($rule)
        Set-Acl -LiteralPath $path -AclObject $acl
    } catch {
        # Not fatal: DPAPI is what actually protects the contents.
    }
    return $path
}

function Test-TeggCredentialStored {
    $path = Get-CredentialStorePath
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    $lines = @(Get-Content -LiteralPath $path -ErrorAction SilentlyContinue)
    return ($lines.Count -ge 2 -and $lines[0] -and $lines[1])
}

function ConvertFrom-SecureToPlain {
    param([System.Security.SecureString]$Secure)
    if (-not $Secure) { return '' }
    $pointer = [System.IntPtr]::Zero
    try {
        $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        if ($pointer -ne [System.IntPtr]::Zero) {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

# Returns @{ Username = '...'; Password = '...' } or $null.
# The only place in this package where a credential exists as text.
function Get-TeggCredential {
    $path = Get-CredentialStorePath
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $lines = @(Get-Content -LiteralPath $path -ErrorAction SilentlyContinue)
    if ($lines.Count -lt 2) { return $null }
    try {
        $user = ConvertFrom-SecureToPlain (ConvertTo-SecureString -String $lines[0])
        $pass = ConvertFrom-SecureToPlain (ConvertTo-SecureString -String $lines[1])
    } catch {
        # Written by a different Windows user, or restored onto another machine.
        return $null
    }
    if (-not $user -or -not $pass) { return $null }
    return @{ Username = $user; Password = $pass }
}

# Puts the sign-in into this process's environment and nowhere else. It is not
# written to a file, not exported to the machine, and gone when this window
# closes.
function Set-TeggCredentialEnvironment {
    $credential = Get-TeggCredential
    if (-not $credential) { return $false }
    $env:TEGG_USERNAME = $credential.Username
    $env:TEGG_PASSWORD = $credential.Password
    return $true
}

function Clear-TeggCredentialEnvironment {
    $env:TEGG_USERNAME = ''
    $env:TEGG_PASSWORD = ''
    Remove-Item Env:TEGG_USERNAME -ErrorAction SilentlyContinue
    Remove-Item Env:TEGG_PASSWORD -ErrorAction SilentlyContinue
}

# ------------------------------------------------------------- the portal --

# The address the tool is configured to reach, read out of config/service.yaml
# without needing a YAML parser. Returns $null if the file is not readable.
function Get-ConfiguredBaseUrl {
    param([string]$Root)
    $service = Join-Path $Root 'config\service.yaml'
    if (-not (Test-Path -LiteralPath $service)) { return $null }
    foreach ($line in @(Get-Content -LiteralPath $service -ErrorAction SilentlyContinue)) {
        if ($line -match '^\s*base_url:\s*[''"]?([^''"\s]+)') {
            return $matches[1]
        }
    }
    return $null
}

# Ask an address for its sign-in page. Sends no credential: this is the same
# request a browser makes before anybody has typed anything.
function Test-UrlReachable {
    param([string]$Url, [int]$TimeoutSeconds = 15)
    if (-not $Url) { return @{ Ok = $false; Detail = 'no address configured' } }
    try {
        # Windows PowerShell 5.1 still defaults to TLS 1.0 on some builds, and
        # every modern site refuses that.
        [Net.ServicePointManager]::SecurityProtocol = `
            [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11
    } catch { }
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSeconds -Method Get
        return @{ Ok = $true; Detail = ('answered HTTP ' + [int]$response.StatusCode) }
    } catch [System.Net.WebException] {
        $webResponse = $null
        try { $webResponse = $_.Exception.Response } catch { }
        if ($webResponse) {
            # A 4xx still proves the host is there and answering.
            return @{ Ok = $true; Detail = ('answered HTTP ' + [int]$webResponse.StatusCode) }
        }
        return @{ Ok = $false; Detail = ('did not answer: ' + $_.Exception.Message) }
    } catch {
        return @{ Ok = $false; Detail = ('did not answer: ' + $_.Exception.Message) }
    }
}

# --------------------------------------------------------------- the zip ---

# Windows marks everything that came out of a downloaded zip as untrusted, and
# then refuses to run it with a message about publishers that tells a
# non-developer nothing. Clearing the mark on our own folder is the fix, and it
# is the first thing Setup does.
function Clear-DownloadMark {
    param([string]$Root)
    try {
        Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue |
            Unblock-File -ErrorAction SilentlyContinue
        return $true
    } catch {
        return $false
    }
}
