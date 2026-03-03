param(
  [Parameter(Mandatory = $true)]
  [string]$Authorization,   # Accepts full "Bearer xxx" or raw token

  [string]$BaseUrl = "http://localhost:8317",
  [switch]$DryRun
)

if ($Authorization -notmatch '^\s*Bearer\s+') {
  $Authorization = "Bearer $Authorization"
}

$BaseUrl = $BaseUrl.TrimEnd('/')
$headers = @{ Authorization = $Authorization }

$listUrl = "$BaseUrl/v0/management/auth-files"
$apiCallUrl = "$BaseUrl/v0/management/api-call"
$usageUrl = "https://chatgpt.com/backend-api/wham/usage"
$codexUserAgent = "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal"

function Get-ObjectPropertyValue {
  param(
    [Parameter(Mandatory = $true)]
    [AllowNull()]
    [object]$Object,

    [Parameter(Mandatory = $true)]
    [string[]]$Names
  )

  if ($null -eq $Object) {
    return $null
  }

  foreach ($name in $Names) {
    if ($Object -is [System.Collections.IDictionary]) {
      if ($Object.Contains($name)) {
        return $Object[$name]
      }
      continue
    }

    $prop = $Object.PSObject.Properties[$name]
    if ($null -ne $prop) {
      return $prop.Value
    }
  }

  return $null
}

function Normalize-StringValue {
  param([AllowNull()][object]$Value)
  if ($null -eq $Value) { return $null }
  $text = [string]$Value
  $trimmed = $text.Trim()
  if ([string]::IsNullOrWhiteSpace($trimmed)) { return $null }
  return $trimmed
}

function Normalize-AuthIndex {
  param([AllowNull()][object]$Value)
  if ($null -eq $Value) { return $null }
  if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) {
    return [string]$Value
  }
  return (Normalize-StringValue -Value $Value)
}

function ConvertFrom-Base64UrlPayload {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }

  try {
    $normalized = $Value.Replace('-', '+').Replace('_', '/')
    while (($normalized.Length % 4) -ne 0) {
      $normalized += '='
    }
    $bytes = [System.Convert]::FromBase64String($normalized)
    $jsonText = [System.Text.Encoding]::UTF8.GetString($bytes)
    return $jsonText | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Parse-IdTokenPayload {
  param([AllowNull()][object]$Value)
  if ($null -eq $Value) { return $null }

  if ($Value -isnot [string]) {
    return $Value
  }

  $trimmed = $Value.Trim()
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    return $null
  }

  try {
    return $trimmed | ConvertFrom-Json
  } catch {
    # Continue to JWT payload parsing.
  }

  $segments = $trimmed.Split('.')
  if ($segments.Length -lt 2) {
    return $null
  }

  return ConvertFrom-Base64UrlPayload -Value $segments[1]
}

function Resolve-ChatgptAccountId {
  param([AllowNull()][object]$File)
  if ($null -eq $File) { return $null }

  $metadata = Get-ObjectPropertyValue -Object $File -Names @("metadata")
  $attributes = Get-ObjectPropertyValue -Object $File -Names @("attributes")

  $directCandidates = @(
    (Get-ObjectPropertyValue -Object $File -Names @("chatgpt_account_id", "chatgptAccountId")),
    (Get-ObjectPropertyValue -Object $metadata -Names @("chatgpt_account_id", "chatgptAccountId")),
    (Get-ObjectPropertyValue -Object $attributes -Names @("chatgpt_account_id", "chatgptAccountId"))
  )
  foreach ($candidate in $directCandidates) {
    $value = Normalize-StringValue -Value $candidate
    if ($value) { return $value }
  }

  $idTokenCandidates = @(
    (Get-ObjectPropertyValue -Object $File -Names @("id_token")),
    (Get-ObjectPropertyValue -Object $metadata -Names @("id_token")),
    (Get-ObjectPropertyValue -Object $attributes -Names @("id_token"))
  )

  foreach ($idToken in $idTokenCandidates) {
    $payload = Parse-IdTokenPayload -Value $idToken
    if ($null -eq $payload) { continue }
    $accountId = Normalize-StringValue -Value (Get-ObjectPropertyValue -Object $payload -Names @("chatgpt_account_id", "chatgptAccountId"))
    if ($accountId) { return $accountId }
  }

  return $null
}

try {
  $resp = Invoke-RestMethod -Method GET -Uri $listUrl -Headers $headers -TimeoutSec 30
} catch {
  throw "Failed to query auth files: $($_.Exception.Message)"
}

$files = @()
if ($resp -is [System.Array]) {
  $files = $resp
} elseif ($null -ne $resp.files) {
  $files = @($resp.files)
} else {
  throw "No files array found in API response."
}

if ($files.Count -eq 0) {
  Write-Host "No auth files found."
  exit 0
}

Write-Host "Found $($files.Count) auth files. Verifying validity via /v0/management/api-call ..."

$checkResults = @()
foreach ($f in $files) {
  if ($null -eq $f) { continue }

  $name = Normalize-StringValue -Value (Get-ObjectPropertyValue -Object $f -Names @("name"))
  if (-not $name) { continue }

  $rawAuthIndex = Get-ObjectPropertyValue -Object $f -Names @("auth_index", "authIndex")
  $authIndex = Normalize-AuthIndex -Value $rawAuthIndex
  $accountId = Resolve-ChatgptAccountId -File $f

  if (-not $authIndex) {
    $checkResults += [pscustomobject]@{
      name       = $name
      authIndex  = $null
      statusCode = $null
      valid      = $false
      reason     = "missing authIndex"
    }
    Write-Warning "[INVALID] $name -> missing authIndex"
    continue
  }

  if (-not $accountId) {
    $checkResults += [pscustomobject]@{
      name       = $name
      authIndex  = $authIndex
      statusCode = $null
      valid      = $false
      reason     = "missing Chatgpt-Account-Id"
    }
    Write-Warning "[INVALID] $name -> missing Chatgpt-Account-Id"
    continue
  }

  $payload = @{
    authIndex = $authIndex
    method    = "GET"
    url       = $usageUrl
    header    = @{
      Authorization       = 'Bearer $TOKEN$'
      "Content-Type"      = "application/json"
      "User-Agent"        = $codexUserAgent
      "Chatgpt-Account-Id" = $accountId
    }
  }

  try {
    $apiResp = Invoke-RestMethod -Method POST -Uri $apiCallUrl -Headers $headers -Body ($payload | ConvertTo-Json -Depth 20) -ContentType "application/json" -TimeoutSec 30
    $statusCodeRaw = Get-ObjectPropertyValue -Object $apiResp -Names @("status_code", "statusCode")
    $statusCode = 0
    if ($null -ne $statusCodeRaw) {
      [void][int]::TryParse(([string]$statusCodeRaw), [ref]$statusCode)
    }
    $isValid = ($statusCode -eq 200)
    $reason = if ($isValid) { "status_code=200" } else { "status_code=$statusCode" }

    $checkResults += [pscustomobject]@{
      name       = $name
      authIndex  = $authIndex
      statusCode = $statusCode
      valid      = $isValid
      reason     = $reason
    }

    if ($isValid) {
      Write-Host "[VALID] $name -> status_code=200"
    } else {
      Write-Warning "[INVALID] $name -> status_code=$statusCode"
    }
  } catch {
    $msg = $_.Exception.Message
    $checkResults += [pscustomobject]@{
      name       = $name
      authIndex  = $authIndex
      statusCode = $null
      valid      = $false
      reason     = $msg
    }
    Write-Warning "[INVALID] $name -> api-call failed: $msg"
  }
}

$targets = @($checkResults | Where-Object { $_.valid -eq $false })
$validCount = @($checkResults | Where-Object { $_.valid -eq $true }).Count

Write-Host ""
Write-Host "Validation done. Valid: $validCount, Invalid: $($targets.Count)"

if ($targets.Count -eq 0) {
  Write-Host "No invalid auth files to delete."
  exit 0
}

Write-Host "Invalid files to delete:"
$targets | ForEach-Object { Write-Host " - $($_.name) ($($_.reason))" }

if ($DryRun) {
  Write-Host "DryRun mode enabled. No files were deleted."
  exit 0
}

$success = 0
$failed = @()

foreach ($f in $targets) {
  $name = [string]$f.name
  $encodedName = [System.Uri]::EscapeDataString($name)
  $deleteUrl = "$BaseUrl/v0/management/auth-files?name=$encodedName"

  try {
    Invoke-RestMethod -Method DELETE -Uri $deleteUrl -Headers $headers -TimeoutSec 30 | Out-Null
    $success++
    Write-Host "[OK] $name"
  } catch {
    $msg = $_.Exception.Message
    $failed += [pscustomobject]@{ name = $name; error = $msg }
    Write-Warning "[FAIL] $name -> $msg"
  }
}

Write-Host ""
Write-Host "Done. Success: $success, Failed: $($failed.Count)"
if ($failed.Count -gt 0) {
  $failed | Format-Table -AutoSize
  exit 1
}
