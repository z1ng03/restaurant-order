$ErrorActionPreference='Stop'
$runtime=Join-Path $PSScriptRoot '.local\runtime.json'
if(!(Test-Path $runtime)){Write-Host 'No recorded processes.';exit}
$records=@(Get-Content $runtime -Raw | ConvertFrom-Json)
foreach($record in ($records | Sort-Object {if($_.name -eq 'postgres'){1}else{0}})){
  $process=Get-Process -Id $record.id -ErrorAction SilentlyContinue
  if($process -and $process.StartTime.ToUniversalTime().ToString('o') -eq $record.started){
    if($record.name -eq 'postgres') { & 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe' -D "$PSScriptRoot\.local\postgres" -m fast stop }
    else { Stop-Process -Id $record.id }
  }
}
Remove-Item -LiteralPath $runtime
