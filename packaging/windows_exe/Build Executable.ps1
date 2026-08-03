# Build the standalone Windows executable.
#
# RUN THIS ON WINDOWS. PyInstaller does not cross-compile: a Windows .exe can
# only be produced on Windows. Nothing about this script has been run at the
# time it was written, because the machine it was written on is a Mac. Read
# EXECUTABLE_BUILD.md before trusting the result of it.
#
# From a checkout of the repository:
#
#     powershell -ExecutionPolicy Bypass -File packaging\windows_exe\Build Executable.ps1
#
# What you get:  dist\awe-tegg\awe-tegg.exe

$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path (Join-Path $Here '..\..')).Path

Write-Host 'TEGG Report Tool - executable build'
Write-Host ('Repository: ' + $Root)

# ------------------------------------------------------------------ python --
$python = $null
foreach ($candidate in @('py -3.12', 'py -3.11', 'py -3', 'python')) {
    $parts = $candidate.Split(' ')
    if (-not (Get-Command $parts[0] -ErrorAction SilentlyContinue)) { continue }
    $python = $candidate
    break
}
if (-not $python) { throw 'No Python found. Install 3.10 or newer from python.org.' }
Write-Host ('Using: ' + $python)

$parts = $python.Split(' ')
$exe = $parts[0]
$prefix = @()
if ($parts.Count -gt 1) { $prefix = @($parts[1]) }

# ------------------------------------------------------------ a clean venv --
# Built in its own environment, not the developer's: whatever is installed in
# that one ends up analysed into the executable, and a 400 MB .exe carrying
# somebody's notebook stack is how this goes wrong quietly.
$buildVenv = Join-Path $Root '.venv-build'
if (-not (Test-Path -LiteralPath $buildVenv)) {
    & $exe @prefix -m venv $buildVenv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the build environment.' }
}
$venvPython = Join-Path $buildVenv 'Scripts\python.exe'

Write-Host 'Installing the tool and its build dependencies...'
& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -e $Root
if ($LASTEXITCODE -ne 0) { throw 'Could not install the tool.' }
& $venvPython -m pip install playwright reportlab pyinstaller
if ($LASTEXITCODE -ne 0) { throw 'Could not install PyInstaller.' }

Write-Host 'Downloading the browser Playwright drives...'
& $venvPython -m playwright install chromium
if ($LASTEXITCODE -ne 0) { Write-Host 'WARNING: the browser download failed. The build continues; the executable will not run until it succeeds.' }

# -------------------------------------------------------------- the build ---
Write-Host 'Building. This takes several minutes.'
Push-Location -LiteralPath $Root
try {
    & $venvPython -m PyInstaller (Join-Path $Here 'tegg-report-tool.spec') --noconfirm --clean
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($code -ne 0) { throw ('PyInstaller failed with exit code ' + $code) }

$built = Join-Path $Root 'dist\awe-tegg\awe-tegg.exe'
if (-not (Test-Path -LiteralPath $built)) {
    throw ('PyInstaller reported success but ' + $built + ' does not exist.')
}

# ------------------------------------------- the files that stay outside ----
# config\ and data\ are edited and written to, so they cannot live inside a
# read-only bundle. They are copied beside the executable instead.
$payload = Split-Path -Parent $built
foreach ($folder in @('config', 'data')) {
    $source = Join-Path $Root $folder
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination $payload -Recurse -Force
    }
}
# A real rate card is somebody's commercial position and must never be in a
# build that gets sent anywhere.
Remove-Item -LiteralPath (Join-Path $payload 'config\ratecard.yaml') -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host ('Built: ' + $built)
Write-Host ''
Write-Host 'NOW TEST IT. Nothing about this build is verified until you have,'
Write-Host 'on a PC with no Python installed:'
Write-Host ''
Write-Host ('  1. cd ' + $payload)
Write-Host '  2. .\awe-tegg.exe doctor'
Write-Host '  3. set TEGG_USERNAME / TEGG_PASSWORD and:  .\awe-tegg.exe doctor --online'
Write-Host '  4. .\awe-tegg.exe run visit-findings'
Write-Host ''
Write-Host 'Read EXECUTABLE_BUILD.md, "What to check the first time", before'
Write-Host 'telling anybody this works.'
