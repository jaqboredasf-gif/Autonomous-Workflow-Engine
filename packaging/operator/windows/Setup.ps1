# TEGG Report Tool - one-time setup for Windows.
#
# Run it once, by double-clicking Setup.bat next to this file. It checks what
# this PC needs, installs the tool into this folder, and asks for your TEGG
# sign-in so you never have to type it again.
#
# It changes nothing outside this folder, apart from saving your sign-in in
# your own Windows account's protected storage - the same mechanism Windows
# uses for saved network passwords.

$ErrorActionPreference = 'Continue'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $Here 'TEGG-Common.ps1')

Write-Say 'TEGG Report Tool - setup'
Write-Say ('Folder: ' + $Here)

# --------------------------------------------------------- the download mark
# Before anything else, because a blocked file is the first thing that stops a
# downloaded package and the message Windows gives for it is useless.
[void](Clear-DownloadMark -Root $Here)

# ------------------------------------------------------------------ python --
Write-Head 'Checking Python'

$python = Find-SupportedPython
if (-not $python) {
    $others = @(Get-PythonCandidates)
    if ($others.Count -gt 0) {
        Write-Bad ('Python ' + $others[0].Version + ' was found, which is too old.')
    } else {
        Write-Bad ('No Python ' + $script:MinPythonText + ' or newer was found on this PC.')
    }
    Write-Say ''
    Write-Say '  Windows does not come with Python. To install it:'
    Write-Say ''
    Write-Say '    1. Go to  https://www.python.org/downloads/windows/'
    Write-Say '    2. Download the latest "Windows installer (64-bit)".'
    Write-Say '    3. Run it. On the FIRST screen, tick'
    Write-Say '         [x] Add python.exe to PATH'
    Write-Say '       then click "Install Now".'
    Write-Say ''
    Write-Say '  Then double-click Setup.bat again.'
    Write-Say ''
    Write-Say '  If your company blocks software installs, send them this line:'
    Write-Say '    "Please install Python 3.12 for Windows from python.org, with'
    Write-Say '     the Add to PATH option ticked."'
    Complete-Script 4
}
Write-Ok ('Python ' + $python.Version + ' at ' + $python.Path)

# -------------------------------------------------------------- the folder --
Write-Head 'Installing the tool into this folder'

$venvPython = Get-VenvPython -Root $Here
if (Test-Path -LiteralPath $venvPython) {
    Write-Say '  (found an existing installation; refreshing it)'
} else {
    & $python.Path -m venv (Join-Path $Here '.venv')
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $venvPython)) {
        Write-Bad 'Could not create the installation folder.'
        Write-Say ''
        Write-Say '  This usually means this folder is read-only, or it is inside'
        Write-Say '  OneDrive and OneDrive is still syncing it. Move the whole'
        Write-Say '  TEGG-Report-Tool folder to  C:\TEGG  and run Setup again.'
        Complete-Script 4
    }
}
Write-Ok 'installation folder ready'

Write-Say '  installing components (this takes a minute or two)...'
& $venvPython -m pip install --quiet --upgrade pip 2>$null | Out-Null

$installLog = Join-Path $Here '.setup-install.log'
& $venvPython -m pip install --quiet -e $Here 2>&1 | Set-Content -LiteralPath $installLog -Encoding ASCII
if ($LASTEXITCODE -ne 0) {
    Write-Bad 'Could not install the components.'
    Write-Say ''
    Write-Say ('  The details are in ' + $installLog)
    Write-Say '  The most common causes are no internet connection, or a company'
    Write-Say '  proxy that blocks pypi.org.'
    Complete-Script 4
}
Write-Ok 'components installed'

# ------------------------------------------------------------- the browser --
Write-Head 'Installing the browser it drives'
Write-Say '  downloading Chromium (about 150 MB, once)...'

$browserLog = Join-Path $Here '.setup-browser.log'
& $venvPython -m playwright install chromium 2>&1 | Set-Content -LiteralPath $browserLog -Encoding ASCII
if ($LASTEXITCODE -ne 0) {
    Write-Bad 'The browser could not be downloaded.'
    Write-Say ('  Details in ' + $browserLog)
    Write-Say '  Usually this is the internet connection, or a company firewall'
    Write-Say '  blocking the download from playwright.azureedge.net.'
    Complete-Script 4
}
Write-Ok 'browser ready'

# ---------------------------------------------------------- the sign-in -----
Write-Head 'Your TEGG sign-in'
Write-Say '  This is stored in your Windows account''s protected storage, the'
Write-Say '  same place Windows keeps saved network passwords. It can only be'
Write-Say '  read back by you, on this PC. It is never written into a file in'
Write-Say '  this folder, and never appears in any log.'
Write-Say ''

$captureCredential = $true
if (Test-TeggCredentialStored) {
    $existing = Get-TeggCredential
    if ($existing) {
        Write-Say ('  Already saved for: ' + $existing.Username)
        $replace = Read-Host '  Replace it? [y/N]'
        if ($replace -notmatch '^[Yy]') {
            Write-Ok 'keeping the saved sign-in'
            $captureCredential = $false
        }
        $existing = $null
    }
}

if ($captureCredential) {
    $teggUser = Read-Host '  TEGG username'
    $teggPass = Read-Host '  TEGG password (it will not appear as you type)' -AsSecureString

    if (-not $teggUser -or -not $teggPass -or $teggPass.Length -eq 0) {
        Write-Bad 'Both a username and a password are needed.'
        Write-Say '  Run Setup again when you have them.'
        Complete-Script 4
    }
    [void](Save-TeggCredential -Username $teggUser -Password $teggPass)
    $teggPass.Dispose()
    $teggPass = $null
    Write-Ok 'saved to your Windows protected storage'
}

# ------------------------------------------------------------- check it -----
Write-Head 'Checking everything works together'

$code = 4
if (Set-TeggCredentialEnvironment) {
    Push-Location -LiteralPath $Here
    try {
        & (Get-VenvTool -Root $Here) doctor
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
        Clear-TeggCredentialEnvironment
    }
} else {
    Write-Bad 'The saved sign-in could not be read back.'
    Write-Say '  Run Setup again and enter it when asked.'
}

Write-Say ''
if ($code -eq 0) {
    Write-Say 'Setup finished.'
    Write-Say ''
    Write-Say 'To use the tool, double-click:   Run Report.bat'
    Write-Say 'If anything ever looks wrong:    Check Setup.bat'
    Write-Say 'To send me a report of this PC:  Diagnostic.bat'
    Write-Say ''
    Write-Say 'Read START HERE.txt if you have not already.'
} else {
    Write-Say 'Setup did not finish cleanly - see the PROBLEM lines above.'
    Write-Say 'TROUBLESHOOTING.txt explains each one.'
    Write-Say 'If you are stuck, double-click Diagnostic.bat and send me the file'
    Write-Say 'it puts on your Desktop.'
}
Complete-Script $code
