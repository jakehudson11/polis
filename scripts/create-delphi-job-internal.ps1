Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
Set-Location $repoRoot

$secretLine = (Select-String -Path .\.env -Pattern '^POLIS_INTERNAL_PROXY_SECRET=' -ErrorAction Stop).Line
$secret = $secretLine.Split('=', 2)[1]

'{"zid":9,"report_id":9}' |
  curl.exe -sS -X POST http://localhost:5000/api/v3/delphi/jobs `
    -H "Content-Type: application/json" `
    -H "x-polis-internal-key: $secret" `
    -H "x-polis-uid: 1" `
    --data-binary '@-'
