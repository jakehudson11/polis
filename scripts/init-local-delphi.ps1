<#
.SYNOPSIS
Initializes local Delphi infrastructure for Polis development.

.DESCRIPTION
Creates/updates the local DynamoDB tables and MinIO bucket used by Delphi.
This script is idempotent and safe to run multiple times.

IMPORTANT: Must be run from the `polis/` directory (where docker-compose.yml lives).

.EXAMPLE
PS> cd D:\dev\polis
PS> .\scripts\init-local-delphi.ps1

.NOTES
Platform: Windows + Docker Desktop
Requires: Docker running, and these compose services running: dynamodb-local, minio, polis-delphi
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Info([string]$Message) { Write-Host $Message -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host $Message -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host $Message -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host $Message -ForegroundColor Red }

function Fail([string]$Message, [int]$ExitCode = 1) {
	Write-Fail $Message
	exit $ExitCode
}

function Assert-FileExists([string]$Path, [string]$OnFailMessage) {
	if (-not (Test-Path -LiteralPath $Path)) {
		Fail $OnFailMessage 2
	}
}

function Assert-Command([string]$Name, [string]$OnFailMessage) {
	$cmd = Get-Command $Name -ErrorAction SilentlyContinue
	if (-not $cmd) {
		Fail $OnFailMessage 2
	}
	return $cmd
}

function Invoke-ExternalCommand {
	param(
		[Parameter(Mandatory)] [string]$FilePath,
		[Parameter(Mandatory)] [string[]]$Arguments,
		[string]$DisplayName = $FilePath
	)

	$joined = ($Arguments | ForEach-Object {
		if ($_ -match '\s') { '"' + $_.Replace('"', '\\"') + '"' } else { $_ }
	}) -join ' '
	Write-Info ("-> {0} {1}" -f $DisplayName, $joined)

	# In Windows PowerShell 5.1, native commands writing to stderr can surface as non-terminating
	# errors (NativeCommandError) which become terminating under $ErrorActionPreference = 'Stop'.
	# Use Process redirection to capture output without generating those error records.
	$psi = New-Object System.Diagnostics.ProcessStartInfo
	$psi.FileName = $FilePath
	$psi.Arguments = $joined
	$psi.RedirectStandardOutput = $true
	$psi.RedirectStandardError = $true
	$psi.UseShellExecute = $false
	$psi.CreateNoWindow = $true

	$p = New-Object System.Diagnostics.Process
	$p.StartInfo = $psi

	[void]$p.Start()
	$stdout = $p.StandardOutput.ReadToEnd()
	$stderr = $p.StandardError.ReadToEnd()
	$p.WaitForExit()

	$outText = ($stdout + $stderr) 
	return [pscustomobject]@{
		ExitCode = $p.ExitCode
		Output   = ($outText | Out-String)
	}
}

function Invoke-DockerCompose {
	param(
		[Parameter(Mandatory)] [string[]]$Arguments,
		[string]$DisplayName = 'docker compose'
	)
	return Invoke-ExternalCommand -FilePath 'docker' -Arguments (@('compose') + $Arguments) -DisplayName $DisplayName
}

function Test-OutputMatchesAny {
	param(
		[Parameter(Mandatory)] [string]$Text,
		[Parameter(Mandatory)] [string[]]$Patterns
	)
	foreach ($p in $Patterns) {
		if ($Text -match $p) { return $true }
	}
	return $false
}

function Assert-DockerRunning {
	Write-Info 'Checking Docker Desktop / engine availability...'
	$docker = Assert-Command -Name 'docker' -OnFailMessage "Docker is not installed or not on PATH. Install Docker Desktop, then retry."
	$info = Invoke-ExternalCommand -FilePath $docker.Path -Arguments @('info') -DisplayName 'docker'
	if ($info.ExitCode -ne 0) {
		Fail ("Docker does not appear to be running. Start Docker Desktop and retry.`n`nOutput:`n{0}" -f $info.Output.Trim()) 3
	}
	Write-Ok 'Docker is running.'
}

function Assert-ComposeProjectHere {
	# Compose supports docker-compose.yml / compose.yml; we enforce being in repo root per requirements.
	if (Test-Path -LiteralPath '.\docker-compose.yml') { return }
	if (Test-Path -LiteralPath '.\compose.yml') { return }
	if (Test-Path -LiteralPath '.\compose.yaml') { return }
	Fail "No docker-compose.yml/compose.yml found in the current directory.`n`nRemediation:`n- cd into the polis/ directory (where docker-compose.yml lives)`n- Then re-run: .\scripts\init-local-delphi.ps1" 2
}

function Get-ComposeRunningServices {
	# Best effort: use service list with status filter (returns actual service names).
	$svc = Invoke-DockerCompose -Arguments @('ps', '--services', '--filter', 'status=running') -DisplayName 'docker compose ps'
	if ($svc.ExitCode -eq 0) {
		$lines = @(
			$svc.Output -split "`r?`n" |
			ForEach-Object { $_.Trim() } |
			Where-Object { $_ -ne '' } |
			# Filter out docker-compose warnings captured from stderr and keep only plausible service names.
			Where-Object { $_ -match '^[A-Za-z0-9][A-Za-z0-9_.-]*$' }
		)
		if ($lines.Count -gt 0) {
			return $lines
		}
	}

	# Next preference: JSON output when available.
	$ps = Invoke-DockerCompose -Arguments @('ps', '--format', 'json') -DisplayName 'docker compose ps'
	if ($ps.ExitCode -eq 0 -and ($ps.Output.Trim().StartsWith('['))) {
		try {
			$items = $ps.Output | ConvertFrom-Json
			$running = @()
			foreach ($i in $items) {
				# Compose JSON schema can vary; handle common keys.
				$svcName = $i.Service
				$state = $i.State
				$status = $i.Status
				if ($null -ne $svcName -and (($state -eq 'running') -or ($status -match '^Up\b'))) {
					$running += $svcName
				}
			}
			return $running
		} catch {
			# Fall through
		}
	}

	# Final fallback: plain ps output. Note: first column is typically container name, not service name.
	$ps2 = Invoke-DockerCompose -Arguments @('ps') -DisplayName 'docker compose ps'
	if ($ps2.ExitCode -ne 0) {
		Fail ("Failed to query compose status. Ensure you're in polis/ and Docker is running.`n`nRemediation:`n- Run: docker compose up -d`n`nOutput:`n{0}" -f $ps2.Output.Trim()) 3
	}
	Write-Warn 'Could not reliably determine running service names from this docker compose version; continuing with best-effort checks.'
	return @()
}

function Assert-ComposeServicesRunning([string[]]$RequiredServices) {
	Write-Info 'Checking required compose services are running...'
	$running = @(Get-ComposeRunningServices)
	if ($running.Count -eq 0) {
		Write-Warn 'Could not determine running services from docker compose output; proceeding, but setup may fail if containers are not running.'
		Write-Warn "If you see failures below, run: docker compose up -d"
		return
	}
	$missing = @($RequiredServices | Where-Object { $_ -notin $running })
	if ($missing.Count -gt 0) {
		Fail ("Required containers are not running: {0}`n`nRemediation:`n- Run: docker compose up -d`n- Then re-run: .\scripts\init-local-delphi.ps1`n`nRunning services detected: {1}" -f ($missing -join ', '), ($running -join ', ')) 4
	}
	Write-Ok ("Required services are up: {0}" -f ($RequiredServices -join ', '))
}

function Invoke-ComposePythonScript {
	param(
		[Parameter(Mandatory)] [string]$ScriptPathInContainer,
		[Parameter(Mandatory)] [string]$ScriptPathRelative,
		[Parameter(Mandatory)] [string]$Description,
		[Parameter(Mandatory)] [string[]]$AlreadyExistsPatterns
	)

	Write-Info $Description

	# 1) Preferred: exec (no new container). Use -T to avoid TTY issues in non-interactive shells.
	$execResult = Invoke-DockerCompose -Arguments @('exec', '-T', 'polis-delphi', 'python', $ScriptPathInContainer) -DisplayName 'docker compose exec'
	if ($execResult.ExitCode -eq 0) {
		Write-Ok 'Completed via exec.'
		return
	}

	# If failure looks like an idempotent "already exists" case, treat as success.
	if (Test-OutputMatchesAny -Text $execResult.Output -Patterns $AlreadyExistsPatterns) {
		Write-Warn 'Resource already exists; continuing (idempotent).'
		return
	}

	Write-Warn ("Exec failed (exit {0}); attempting fallback run..." -f $execResult.ExitCode)

	# 2) Fallback: run one-off container.
	$runResult = Invoke-DockerCompose -Arguments @('run', '--rm', 'polis-delphi', 'python', $ScriptPathRelative) -DisplayName 'docker compose run'
	if ($runResult.ExitCode -eq 0) {
		Write-Ok 'Completed via run.'
		return
	}

	if (Test-OutputMatchesAny -Text $runResult.Output -Patterns $AlreadyExistsPatterns) {
		Write-Warn 'Resource already exists; continuing (idempotent).'
		return
	}

	Fail ("{0} failed.`n`nRemediation:`n- Ensure containers are running: docker compose up -d`n- Check service logs: docker compose logs polis-delphi`n`nExec output:`n{1}`n`nRun output:`n{2}" -f $Description, $execResult.Output.Trim(), $runResult.Output.Trim()) 5
}

function Test-DynamoTables {
	Write-Info 'Verifying DynamoDB tables...'
	$list = Invoke-DockerCompose -Arguments @(
		'exec', '-T', 'dynamodb-local',
		'aws', 'dynamodb', 'list-tables',
		'--endpoint-url', 'http://localhost:8000',
		'--region', 'us-east-1'
	) -DisplayName 'docker compose exec (aws dynamodb list-tables)'

	if ($list.ExitCode -ne 0) {
		Fail ("Failed to list DynamoDB tables.`n`nRemediation:`n- Confirm 'dynamodb-local' is running: docker compose ps`n- Confirm AWS CLI exists in that container (or update image)`n`nOutput:`n{0}" -f $list.Output.Trim()) 6
	}

	Write-Ok 'DynamoDB tables reported by local DynamoDB:'
	Write-Host $list.Output.Trim()
}

function Test-MinIOBucket {
	Write-Info 'Verifying MinIO bucket endpoint...'
	$url = 'http://localhost:9000/polis-delphi/'

	# Prefer curl.exe if present (avoids PowerShell alias differences). Fall back to Invoke-WebRequest.
	$curlExe = Get-Command 'curl.exe' -ErrorAction SilentlyContinue
	if ($curlExe) {
		$res = Invoke-ExternalCommand -FilePath $curlExe.Path -Arguments @('-sS', '-D', '-', '-o', 'NUL', '-w', '%{http_code}', $url) -DisplayName 'curl'
		# Output will include headers + status code at end; should be 200 with public-read bucket policy.
		if ($res.ExitCode -ne 0) {
			Fail ("MinIO check failed (curl error).`n`nRemediation:`n- Confirm MinIO is running: docker compose ps`n- Check minio logs: docker compose logs minio`n`nOutput:`n{0}" -f $res.Output.Trim()) 7
		}
		if ($res.Output -notmatch '200$') {
			Fail ("MinIO bucket check returned unexpected status. Expected 200.`n`nOutput:`n{0}" -f $res.Output.Trim()) 7
		}
		Write-Ok "MinIO responded for $url"
		return
	}

	try {
		$resp = Invoke-WebRequest -Uri $url -Method Get -UseBasicParsing -TimeoutSec 10
		if ($resp.StatusCode -ne 200) {
			Fail ("MinIO bucket check returned HTTP {0} (expected 200)." -f $resp.StatusCode) 7
		}
		Write-Ok "MinIO responded for $url (HTTP $($resp.StatusCode))"
	} catch {
		Fail ("MinIO check failed: {0}`n`nRemediation:`n- Confirm MinIO is running: docker compose ps`n- Check minio logs: docker compose logs minio" -f $_.Exception.Message) 7
	}
}

# --------------------
# Main
# --------------------

Assert-ComposeProjectHere
Assert-DockerRunning
Assert-ComposeServicesRunning -RequiredServices @('dynamodb-local', 'minio', 'polis-delphi')


Invoke-ComposePythonScript 
	-ScriptPathInContainer '/app/create_dynamodb_tables.py' 
	-ScriptPathRelative 'create_dynamodb_tables.py' 
	-Description 'Initializing DynamoDB tables (Delphi)...' 
	-AlreadyExistsPatterns @(
		'Table.*already exists',
		'ResourceInUseException',
		'Cannot create preexisting table'
	)

Invoke-ComposePythonScript 
	-ScriptPathInContainer '/app/setup_minio.py' 
	-ScriptPathRelative 'setup_minio.py' 
	-Description 'Initializing MinIO bucket (polis-delphi)...' 
	-AlreadyExistsPatterns @(
		'Bucket.*already exists',
		'BucketAlready',
		'You already own this bucket'
	)

Test-DynamoTables
Test-MinIOBucket

Write-Ok 'Local Delphi infrastructure initialized successfully.'
Write-Host
Write-Info 'Next steps:'
Write-Host '1) Start/confirm the stack: docker compose up -d' -ForegroundColor White
Write-Host '2) Run your Delphi dev workflow (app/services) as usual.' -ForegroundColor White
