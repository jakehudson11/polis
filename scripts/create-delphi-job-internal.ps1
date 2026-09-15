Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
Set-Location $repoRoot

$secretLine = (Select-String -Path .\.env -Pattern '^POLIS_INTERNAL_PROXY_SECRET=' -ErrorAction Stop).Line
$secret = $secretLine.Split('=', 2)[1]

# Signed budget-context header (audit F-801), keyed with the same secret as
# x-polis-internal-key. This script sends no deliberation_id/admin_user_id,
# so the HMAC input is the unattributed '|' and the header is '||<hex>'.
$hmac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($secret))
$hmacBytes = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes('|'))
$budgetContextHeader = '||' + [System.BitConverter]::ToString($hmacBytes).Replace('-', '').ToLowerInvariant()

'{"zid":9,"report_id":9}' |
  curl.exe -sS -X POST http://localhost:5000/api/v3/delphi/jobs `
    -H "Content-Type: application/json" `
    -H "x-polis-internal-key: $secret" `
    -H "x-agora-budget-context: $budgetContextHeader" `
    -H "x-polis-uid: 1" `
    --data-binary '@-'
