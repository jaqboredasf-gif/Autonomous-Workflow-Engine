# TEGG Report Tool - check this PC is ready.
#
# Double-click Check Setup.bat any time. It changes nothing: it does not sign
# in, it does not create any files, and it does not touch anything in TEGG.

$ErrorActionPreference = 'Continue'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $Here 'TEGG-Common.ps1')

Write-Say 'TEGG Report Tool - checking this PC'
Write-Say ('Folder: ' + $Here)

# Everything below assumes these, so they are checked first and separately:
# a missing Python produces a completely different instruction to a missing
# installation, and running the tool's own checks needs the tool to exist.

Write-Head 'Before the tool can be asked anything'

$python = Find-SupportedPython
if (-not $python) {
    Write-Bad ('No Python ' + $script:MinPythonText + ' or newer on this PC.')
    Write-Say '  Double-click Setup.bat - it says where to get it.'
    Complete-Script 4
}
Write-Ok ('Python ' + $python.Version)

if (-not (Test-ToolInstalled -Root $Here)) {
    Write-Bad 'The tool is not installed on this PC yet.'
    Write-Say ''
    Write-Say '  Double-click  Setup.bat  first. It only needs doing once.'
    Complete-Script 4
}
Write-Ok 'the tool is installed in this folder'

if (-not (Test-TeggCredentialStored)) {
    Write-Bad 'Your TEGG sign-in is not saved on this PC.'
    Write-Say ''
    Write-Say '  Double-click  Setup.bat  and enter it when asked.'
    Complete-Script 4
}
Write-Ok 'a TEGG sign-in is saved for this Windows account'

# ------------------------------------------------------------ the real check
# From here the tool checks itself, because the tool is the thing that knows
# what it needs. --online asks the portal for its sign-in page and nothing
# else: no credential is sent by this.

Write-Say ''
Write-Say 'Asking the tool to check itself...'
Write-Say ''

$code = 4
if (Set-TeggCredentialEnvironment) {
    Push-Location -LiteralPath $Here
    try {
        & (Get-VenvTool -Root $Here) doctor --online
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
        Clear-TeggCredentialEnvironment
    }
} else {
    Write-Bad 'The saved sign-in could not be read back on this PC.'
    Write-Say '  This happens if it was saved by a different Windows user, or'
    Write-Say '  restored from a backup of another PC. Run Setup.bat again.'
}

Write-Say ''
if ($code -eq 0) {
    Write-Say 'This PC is ready. Double-click  Run Report.bat  to use the tool.'
} else {
    Write-Say 'Something needs attention - the PROBLEM lines above say what.'
    Write-Say 'TROUBLESHOOTING.txt explains each one.'
    Write-Say ''
    Write-Say 'If you are stuck: double-click Diagnostic.bat and send me the file'
    Write-Say 'it puts on your Desktop.'
}
Complete-Script $code
