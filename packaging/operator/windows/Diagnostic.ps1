# TEGG Report Tool - pilot diagnostic.
#
# Double-click Diagnostic.bat. It writes one text file to your Desktop and
# opens it. Send that file back to whoever gave you this tool.
#
# It changes nothing, signs in to nothing, and it does not put your password,
# your token, any cookie or any other secret into the file. Everything it
# writes is on screen and in the file, so you can read it before you send it.

$ErrorActionPreference = 'Continue'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $Here 'TEGG-Common.ps1')

# ---------------------------------------------------------------- plumbing --

$script:Lines = New-Object System.Collections.ArrayList

# Anything that must never reach the file, matched by value. Populated below.
# This is a second line of defence: nothing here is deliberately collected,
# but a diagnostic is the one artefact that definitely leaves the PC.
$script:Secrets = New-Object System.Collections.ArrayList

function Add-Secret {
    param([string]$Value, [string]$Replacement)
    if ($Value -and $Value.Length -ge 3) {
        [void]$script:Secrets.Add(@{ Value = $Value; With = $Replacement })
    }
}

function Protect-Text {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    foreach ($secret in $script:Secrets) {
        if ($Text -like ('*' + $secret.Value + '*')) {
            $Text = $Text.Replace($secret.Value, $secret.With)
        }
    }
    return $Text
}

function Add-Line {
    param([string]$Text = '')
    $clean = Protect-Text $Text
    [void]$script:Lines.Add($clean)
    Write-Host $clean
}

function Add-Section {
    param([string]$Title)
    Add-Line ''
    Add-Line ('== ' + $Title + ' ' + ('=' * [Math]::Max(4, 60 - $Title.Length)))
}

function Add-Item {
    param([string]$Status, [string]$Name, [string]$Detail = '')
    $line = ('  ' + $Status.PadRight(8) + $Name)
    if ($Detail) { $line += (' -- ' + $Detail) }
    Add-Line $line
}

# The stage the coworker was standing on when it stopped being fine. Updated as
# the diagnostic advances, so a truncated or crashed run still names a stage.
$script:Stage = 'starting'
$script:FailedStage = ''
function Set-Stage {
    param([string]$Name)
    $script:Stage = $Name
}
function Set-FailedStage {
    param([string]$Detail)
    if (-not $script:FailedStage) {
        $script:FailedStage = ($script:Stage + ': ' + $Detail)
    }
}

# ---------------------------------------------------------------- redaction -
# Register the values that must never appear before collecting anything.
Set-Stage 'reading the saved sign-in'
$credential = $null
try { $credential = Get-TeggCredential } catch { }
if ($credential) {
    Add-Secret -Value $credential.Username -Replacement '<TEGG-USERNAME-REDACTED>'
    Add-Secret -Value $credential.Password -Replacement '<TEGG-PASSWORD-REDACTED>'
}
Add-Secret -Value $env:USERNAME -Replacement '<windows-user>'

# ------------------------------------------------------------------ header --
Add-Line 'TEGG REPORT TOOL - DIAGNOSTIC'
Add-Line '============================='
Add-Line ''
Add-Line ('Written ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'))
Add-Line 'This file contains no password, token, cookie or other secret.'
Add-Line 'Send it to whoever gave you this tool.'

# ------------------------------------------------------------------ windows -
Set-Stage 'reading this PC'
Add-Section 'This PC'
try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    Add-Item 'INFO' 'Windows' ($os.Caption + ' (build ' + $os.BuildNumber + ')')
} catch {
    try {
        Add-Item 'INFO' 'Windows' ([System.Environment]::OSVersion.VersionString)
    } catch {
        Add-Item 'UNKNOWN' 'Windows' 'could not be read'
    }
}
Add-Item 'INFO' 'architecture' ($env:PROCESSOR_ARCHITECTURE + ' (' +
    $(if ([System.Environment]::Is64BitOperatingSystem) { '64-bit OS' } else { '32-bit OS' }) + ', ' +
    $(if ([System.Environment]::Is64BitProcess) { '64-bit shell' } else { '32-bit shell' }) + ')')
Add-Item 'INFO' 'PowerShell' ($PSVersionTable.PSVersion.ToString() + ' / ' + $PSVersionTable.PSEdition)
try {
    $policy = Get-ExecutionPolicy -ErrorAction SilentlyContinue
    Add-Item 'INFO' 'execution policy' ("$policy" + ' (the .bat launchers bypass this)')
} catch { }

# ------------------------------------------------------------- the folder ---
Set-Stage 'checking this folder'
Add-Section 'Where the tool is'
Add-Item 'INFO' 'folder' (Protect-Text $Here)

if ($Here -match '^\\\\') {
    Add-Item 'WARNING' 'folder location' 'this is a network share; move it to C:\TEGG'
    Set-FailedStage 'the tool folder is on a network share'
}
if ($Here -match '(?i)onedrive') {
    Add-Item 'WARNING' 'folder location' 'this is inside OneDrive, which can lock files mid-run'
}
if ($Here.Length -gt 150) {
    Add-Item 'WARNING' 'folder path length' ('' + $Here.Length + ' characters; Windows breaks past 260')
}

$probe = Join-Path $Here ('.write-probe-' + [System.Guid]::NewGuid().ToString('N') + '.tmp')
try {
    Set-Content -LiteralPath $probe -Value 'probe' -Encoding ASCII -ErrorAction Stop
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    Add-Item 'OK' 'this folder is writable'
} catch {
    Add-Item 'PROBLEM' 'this folder is NOT writable' $_.Exception.Message
    Set-FailedStage 'the tool folder cannot be written to'
}

foreach ($sub in @('work', 'output', 'data')) {
    $path = Join-Path $Here $sub
    if (Test-Path -LiteralPath $path) {
        Add-Item 'OK' ($sub + '\ exists')
    } else {
        Add-Item 'INFO' ($sub + '\ not present yet') 'it is created on first use'
    }
}

# ------------------------------------------------------------------ python --
Set-Stage 'looking for Python'
Add-Section 'Python'
$candidates = @()
try { $candidates = @(Get-PythonCandidates) } catch { }
if ($candidates.Count -eq 0) {
    Add-Item 'PROBLEM' 'no Python found on this PC' ('need ' + $script:MinPythonText + ' or newer')
    Set-FailedStage 'Python is not installed'
} else {
    foreach ($candidate in $candidates) {
        $status = $(if ($candidate.Supported) { 'OK' } else { 'TOO OLD' })
        Add-Item $status ('Python ' + $candidate.Version) (Protect-Text $candidate.Path)
    }
    if (-not (@($candidates | Where-Object { $_.Supported }).Count -gt 0)) {
        Set-FailedStage ('every Python on this PC is older than ' + $script:MinPythonText)
    }
}

# ------------------------------------------------------- the installation ---
Set-Stage 'checking the installation'
Add-Section 'The installation in this folder'
$venvPython = Get-VenvPython -Root $Here
$venvTool = Get-VenvTool -Root $Here
$installed = Test-Path -LiteralPath $venvPython
if ($installed) {
    Add-Item 'OK' '.venv exists'
    $version = $null
    try { $version = (& $venvPython -c 'import sys; print(sys.version.split()[0])' 2>$null | Select-Object -First 1) } catch { }
    if ($version) {
        Add-Item 'OK' 'its Python answers' ('version ' + $version.Trim())
    } else {
        Add-Item 'PROBLEM' 'its Python does not answer' 'the installation is broken; run Setup.bat again'
        Set-FailedStage 'the installed Python does not run'
    }
} else {
    Add-Item 'PROBLEM' '.venv is missing' 'Setup.bat has not been run, or it did not finish'
    Set-FailedStage 'Setup has not been run on this PC'
}
if (Test-Path -LiteralPath $venvTool) {
    Add-Item 'OK' 'awe-tegg.exe is installed'
} else {
    Add-Item 'PROBLEM' 'awe-tegg.exe is missing' 'run Setup.bat again'
    Set-FailedStage 'the tool itself is not installed'
}

# ------------------------------------------------------------ dependencies --
Set-Stage 'checking the dependencies'
Add-Section 'Dependencies'
if ($installed) {
    foreach ($module in @('playwright', 'pypdf', 'yaml', 'docx', 'reportlab',
                          'awe_tegg', 'awe_runtime', 'awe_knowledge', 'tegg')) {
        $answer = $null
        try {
            $answer = (& $venvPython -c ('import ' + $module + '; print(1)') 2>$null | Select-Object -First 1)
        } catch { }
        if ($answer) {
            Add-Item 'OK' $module 'importable'
        } else {
            Add-Item 'PROBLEM' $module 'not installed; run Setup.bat again'
            Set-FailedStage ('the ' + $module + ' component is missing')
        }
    }
} else {
    Add-Item 'SKIPPED' 'dependencies' 'nothing is installed to check'
}

# --------------------------------------------------------- browser runtime --
Set-Stage 'checking the browser'
Add-Section 'Browser runtime'
$browserFound = $false
foreach ($browser in @(
    @{ Name = 'Google Chrome'; Path = 'C:\Program Files\Google\Chrome\Application\chrome.exe' },
    @{ Name = 'Google Chrome (32-bit)'; Path = 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe' },
    @{ Name = 'Microsoft Edge'; Path = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' },
    @{ Name = 'Microsoft Edge'; Path = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe' }
)) {
    if (Test-Path -LiteralPath $browser.Path) {
        Add-Item 'OK' ('installed: ' + $browser.Name) $browser.Path
        $browserFound = $true
    }
}

$playwrightCache = Join-Path $env:LOCALAPPDATA 'ms-playwright'
if (Test-Path -LiteralPath $playwrightCache) {
    $builds = @(Get-ChildItem -LiteralPath $playwrightCache -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'chromium*' })
    if ($builds.Count -gt 0) {
        foreach ($build in $builds) { Add-Item 'OK' 'playwright chromium' $build.Name }
        $browserFound = $true
    } else {
        Add-Item 'PROBLEM' 'playwright has no chromium build' 'run Setup.bat again'
    }
} else {
    Add-Item 'INFO' 'no playwright browser cache' (Protect-Text $playwrightCache + ' does not exist')
}

if (-not $browserFound) {
    Add-Item 'PROBLEM' 'no browser this tool can drive' 'run Setup.bat again to download one'
    Set-FailedStage 'there is no browser for the tool to drive'
}

# -------------------------------------------------------------- the network -
Set-Stage 'checking the network'
Add-Section 'Network'
$baseUrl = Get-ConfiguredBaseUrl -Root $Here
if (-not $baseUrl) { $baseUrl = 'https://tegg2.teggpro.com' }

foreach ($target in @(
    @{ Name = 'the TEGG portal'; Url = $baseUrl; Required = $true },
    @{ Name = 'pypi.org (needed by Setup only)'; Url = 'https://pypi.org/simple/'; Required = $false },
    @{ Name = 'playwright browser download (Setup only)'; Url = 'https://playwright.azureedge.net'; Required = $false }
)) {
    $result = Test-UrlReachable -Url $target.Url -TimeoutSeconds 15
    if ($result.Ok) {
        Add-Item 'OK' $target.Name ($target.Url + ' ' + $result.Detail)
    } elseif ($target.Required) {
        Add-Item 'PROBLEM' $target.Name ($target.Url + ' ' + $result.Detail)
        Set-FailedStage 'the TEGG portal cannot be reached from this PC'
    } else {
        Add-Item 'WARNING' $target.Name ($target.Url + ' ' + $result.Detail)
    }
}
if ($env:HTTP_PROXY -or $env:HTTPS_PROXY) {
    # The names only. A proxy URL can carry a password in it.
    $names = @()
    if ($env:HTTP_PROXY) { $names += 'HTTP_PROXY' }
    if ($env:HTTPS_PROXY) { $names += 'HTTPS_PROXY' }
    Add-Item 'INFO' 'a proxy is configured' (($names -join ', ') + ' is set (value not shown)')
}

# ------------------------------------------------------------ configuration -
Set-Stage 'checking the configuration'
Add-Section 'Configuration'
foreach ($file in @('config\service.yaml', 'config\workflow.yaml',
                    'config\ratecard.example.yaml')) {
    if (Test-Path -LiteralPath (Join-Path $Here $file)) {
        Add-Item 'OK' $file 'present'
    } else {
        Add-Item 'PROBLEM' $file 'missing from this folder'
        Set-FailedStage ($file + ' is missing from the package')
    }
}
if (Test-Path -LiteralPath (Join-Path $Here 'config\ratecard.yaml')) {
    Add-Item 'OK' 'config\ratecard.yaml' 'present: real labour rates are in use'
} else {
    Add-Item 'WARNING' 'config\ratecard.yaml' 'not present: every money figure will be marked NOT PRICED'
}
Add-Item 'INFO' 'configured portal' $baseUrl

$knowledge = Join-Path $Here 'data\operational_knowledge'
if (Test-Path -LiteralPath $knowledge) {
    $count = @(Get-ChildItem -LiteralPath $knowledge -Recurse -File -ErrorAction SilentlyContinue).Count
    Add-Item 'OK' 'data\operational_knowledge' ('' + $count + ' file(s)')
} else {
    Add-Item 'PROBLEM' 'data\operational_knowledge' 'missing from this folder'
    Set-FailedStage 'the operational knowledge is missing from the package'
}

# --------------------------------------------------------------- sign-in ----
Set-Stage 'checking the saved sign-in'
Add-Section 'Sign-in'
Add-Line '  (The username and password themselves are never read into this file.)'
if (Test-TeggCredentialStored) {
    Add-Item 'OK' 'a sign-in is saved' 'in this Windows account''s protected storage'
    if ($credential) {
        Add-Item 'OK' 'it can be read back by this Windows account'
    } else {
        Add-Item 'PROBLEM' 'it cannot be read back' 'saved by a different Windows user, or another PC'
        Set-FailedStage 'the saved sign-in cannot be decrypted by this Windows account'
    }
} else {
    Add-Item 'PROBLEM' 'no sign-in is saved' 'run Setup.bat and enter it when asked'
    Set-FailedStage 'no TEGG sign-in has been saved on this PC'
}
foreach ($name in @('TEGG_USERNAME', 'TEGG_PASSWORD', 'TEGG_CHROMIUM', 'AWE_ROOT')) {
    # Names only, never values.
    $isSet = Test-Path ('Env:' + $name)
    Add-Item 'INFO' ('environment ' + $name) $(if ($isSet) { 'set (value not shown)' } else { 'not set' })
}

# ------------------------------------------------------------- readiness ----
Set-Stage 'asking the tool to check itself'
Add-Section 'Setup readiness (the tool checking itself)'
if ((Test-Path -LiteralPath $venvTool) -and $credential) {
    $doctorCode = -1
    $output = @()
    try {
        $env:TEGG_USERNAME = $credential.Username
        $env:TEGG_PASSWORD = $credential.Password
        Push-Location -LiteralPath $Here
        $output = @(& $venvTool doctor --online 2>&1 | ForEach-Object { "$_" })
        $doctorCode = $LASTEXITCODE
    } catch {
        $output = @('the check could not be run: ' + $_.Exception.Message)
    } finally {
        Pop-Location
        Clear-TeggCredentialEnvironment
    }
    foreach ($line in $output) { Add-Line ('  ' + (Protect-Text $line)) }
    Add-Line ''
    Add-Item 'INFO' 'result' ('exit code ' + $doctorCode +
        $(if ($doctorCode -eq 0) { ' (ready)' } else { ' (not ready)' }))
    if ($doctorCode -ne 0) {
        Set-FailedStage ('the tool reported it is not ready (exit code ' + $doctorCode + ')')
    }
} else {
    Add-Item 'SKIPPED' 'the tool cannot check itself yet' 'it is not installed, or no sign-in is saved'
}

# ------------------------------------------------------------- past runs ----
Set-Stage 'looking at past runs'
Add-Section 'Past runs'
$operations = Join-Path $Here 'work\operations'
if (Test-Path -LiteralPath $operations) {
    $runs = @(Get-ChildItem -LiteralPath $operations -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 5)
    if ($runs.Count -eq 0) {
        Add-Item 'INFO' 'no runs yet'
    } else {
        foreach ($run in $runs) {
            $hasReview = Test-Path -LiteralPath (Join-Path $run.FullName 'review\review.md')
            Add-Item 'INFO' $run.Name (
                $run.LastWriteTime.ToString('yyyy-MM-dd HH:mm') + ', report ' +
                $(if ($hasReview) { 'written' } else { 'NOT written' }))
        }
    }
} else {
    Add-Item 'INFO' 'no runs yet' 'work\operations does not exist'
}

# --------------------------------------------------------------- verdict ----
Add-Section 'Verdict'
if ($script:FailedStage) {
    Add-Line '  NOT READY.'
    Add-Line ''
    Add-Line ('  First thing that is wrong: ' + $script:FailedStage)
    Add-Line ''
    Add-Line '  TROUBLESHOOTING.txt explains what to do about it. If it does not'
    Add-Line '  help, send this file on.'
} else {
    Add-Line '  READY. Everything this diagnostic can check from here is in order.'
    Add-Line '  Double-click Run Report.bat to use the tool.'
}

# ----------------------------------------------------------------- write ----
$stamp = (Get-Date).ToString('yyyy-MM-dd-HHmm')
$name = 'TEGG-Diagnostic-' + $stamp + '.txt'

$desktop = $null
try { $desktop = [System.Environment]::GetFolderPath('Desktop') } catch { }
if (-not $desktop -or -not (Test-Path -LiteralPath $desktop)) { $desktop = $Here }

$written = @()
foreach ($folder in @($desktop, $Here)) {
    $target = Join-Path $folder $name
    try {
        Set-Content -LiteralPath $target -Value $script:Lines -Encoding UTF8 -ErrorAction Stop
        $written += $target
    } catch { }
}

Write-Host ''
Write-Host '-----------------------------------------------------------------'
if ($written.Count -gt 0) {
    Write-Host 'The diagnostic was saved to:'
    foreach ($target in $written) { Write-Host ('  ' + $target) }
    Write-Host ''
    Write-Host 'Send the file on. It contains no password and no secret --'
    Write-Host 'it is opening now so you can read it first.'
    try { Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $written[0] + '"') -ErrorAction SilentlyContinue } catch { }
} else {
    Write-Host 'The diagnostic could not be saved to a file, but everything it'
    Write-Host 'found is on screen above. Copy it and send it on.'
}
Complete-Script $(if ($script:FailedStage) { 4 } else { 0 })
