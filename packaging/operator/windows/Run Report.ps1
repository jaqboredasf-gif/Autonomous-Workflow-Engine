# TEGG Report Tool - read one completed site visit and write a report to review.
#
# Double-click Run Report.bat. It takes about a minute and a half.
#
# It only ever reads from TEGG. It never submits anything, approves anything,
# sends an email, uploads anything, or changes a record.

$ErrorActionPreference = 'Continue'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $Here 'TEGG-Common.ps1')

if (-not (Test-ToolInstalled -Root $Here)) {
    Write-Say 'This tool has not been set up on this PC yet.'
    Write-Say ''
    Write-Say 'Double-click  Setup.bat  first. It only needs doing once.'
    Complete-Script 4
}

if (-not (Set-TeggCredentialEnvironment)) {
    Write-Say 'Your TEGG sign-in is not saved on this PC.'
    Write-Say ''
    Write-Say 'Double-click  Setup.bat  and enter it when asked.'
    Complete-Script 4
}

# A site visit may be named as the first argument -- normally by dropping
# nothing at all, in which case the tool picks the most recently completed one
# and says which it chose.
$toolArgs = @('run', 'visit-findings')
$passthrough = @($args)
if ($passthrough.Count -gt 0 -and $passthrough[0] -and -not ("$($passthrough[0])".StartsWith('-'))) {
    $toolArgs += '--site-visit'
    $toolArgs += "$($passthrough[0])"
    $passthrough = @($passthrough | Select-Object -Skip 1)
}
if (Test-Path -LiteralPath (Join-Path $Here 'config\ratecard.yaml')) {
    $toolArgs += '--rate-card'
    $toolArgs += 'config/ratecard.yaml'
}
foreach ($extra in $passthrough) { $toolArgs += "$extra" }

Write-Say 'Reading one completed site visit from TEGG.'
Write-Say 'This takes about a minute and a half. You can leave it running.'
Write-Say ''

$code = 0
Push-Location -LiteralPath $Here
try {
    & (Get-VenvTool -Root $Here) @toolArgs
    $code = $LASTEXITCODE
} finally {
    Pop-Location
    # The sign-in existed only inside this window, and not past this line.
    Clear-TeggCredentialEnvironment
}

Write-Say ''
switch ($code) {
    0 {
        Write-Say 'Done.'
        $operations = Join-Path $Here 'work\operations'
        $latest = $null
        if (Test-Path -LiteralPath $operations) {
            $latest = Get-ChildItem -LiteralPath $operations -Directory -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
        }
        if ($latest) {
            $review = Join-Path $latest.FullName 'review'
            $file = Join-Path $review 'review.md'
            if (Test-Path -LiteralPath $file) {
                Write-Say 'The report to read is:'
                Write-Say ('  ' + $file)
                Write-Say ''
                Write-Say 'Opening the folder for you...'
                Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $review + '"') -ErrorAction SilentlyContinue
            }
        }
    }
    1 { Write-Say 'It could not finish. Nothing in TEGG was changed.'
        Write-Say 'See TROUBLESHOOTING.txt.' }
    2 { Write-Say 'That command was not understood. Nothing was attempted.' }
    3 { Write-Say 'It stopped and needs a person.'
        Write-Say 'Read the "human action required" lines above - they say what is needed.'
        Write-Say 'Nothing in TEGG was changed, and you can safely run this again.' }
    4 { Write-Say 'It did not start: something about this PC or its settings is not ready.'
        Write-Say 'Double-click  Check Setup.bat  to see what.' }
    default { Write-Say ('Finished with code ' + $code + '.') }
}
Complete-Script $code
