param(
  [int]$Zid = 9,
  [int]$ReportId = 9,
  [int]$RestartWaitSeconds = 10,
  [int]$ProcessWaitSeconds = 15,
  [string]$ApiBase = 'http://localhost:5000'
)

$ErrorActionPreference = 'Stop'

function Write-Section([string]$Title) {
  Write-Output ""
  Write-Output "=== $Title ==="
}

Set-Location $PSScriptRoot\..

Write-Section "Restart polis-delphi"
docker compose restart polis-delphi
if ($LASTEXITCODE -ne 0) { throw "docker compose restart failed with exit code $LASTEXITCODE" }

Write-Output "Waiting $RestartWaitSeconds seconds for startup..."
Start-Sleep -Seconds $RestartWaitSeconds

Write-Section "polis-delphi recent logs"
docker logs polis-delphi --tail 80

Write-Section "Create Delphi job via Polis API"
$uri = "$ApiBase/api/v3/delphi/jobs"
$bodyObj = @{ zid = $Zid; report_id = $ReportId }
$bodyJson = ($bodyObj | ConvertTo-Json -Compress)

Write-Output "POST $uri"
Write-Output "Body: $bodyJson"

# Print status line + response body.
# Using curl.exe explicitly to avoid Invoke-RestMethod formatting.
$resp = curl.exe -sS -D - -X POST $uri -H "Content-Type: application/json" -d $bodyJson
$code = $LASTEXITCODE
Write-Output $resp
if ($code -ne 0) { throw "curl.exe failed with exit code $code" }

Write-Output "Waiting $ProcessWaitSeconds seconds for processing..."
Start-Sleep -Seconds $ProcessWaitSeconds

Write-Section "polis-delphi logs (last ~20s)"
docker logs polis-delphi --tail 50 --since 20s
