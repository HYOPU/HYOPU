param(
  [Parameter(Mandatory = $true)][string]$FilePath,
  [int]$DelaySeconds = 45
)

$node = (Get-Command node -ErrorAction Stop).Source
if (-not $env:HYOPU_ETA_SYNC_TOKEN) {
  throw 'HYOPU_ETA_SYNC_TOKEN 사용자 환경 변수를 먼저 설정한 뒤 새 PowerShell 창에서 다시 실행해 주세요.'
}
if (-not (Test-Path -LiteralPath $FilePath)) { throw "파일을 찾지 못했습니다: $FilePath" }
$script = Join-Path $PSScriptRoot 'eta-local-sync.mjs'
$arguments = '"{0}" --watch --file "{1}" --delay {2}' -f $script, $FilePath, $DelaySeconds
$action = New-ScheduledTaskAction -Execute $node -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'HYOPU ETA Local Sync' -Action $action -Trigger $trigger -Settings $settings -Description 'OneDrive KOREA ETA UPDATE를 HYOPU에 반자동 반영합니다.' -Force | Out-Null
Write-Host '등록 완료: 다음 로그인부터 OneDrive ETA 파일 변경을 감시합니다.'
