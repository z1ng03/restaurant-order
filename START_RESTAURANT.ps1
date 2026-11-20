param([switch]$StayOpen)
$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot
$runtime=Join-Path $PSScriptRoot '.local'
$postgres='C:\Program Files\PostgreSQL\18\bin\postgres.exe'
$node=(Get-Command node.exe).Source
$started=@()
function Test-LocalPort([int]$Port){
  $client=[Net.Sockets.TcpClient]::new()
  try{$client.Connect('127.0.0.1',$Port); return $true}catch{return $false}finally{$client.Dispose()}
}
function Start-Component($Exe,$Arguments,$Name,$WorkingDirectory){
  $process=Start-Process -FilePath $Exe -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput "$runtime\$Name.stdout.log" -RedirectStandardError "$runtime\$Name.stderr.log"
  return @{id=$process.Id;started=$process.StartTime.ToUniversalTime().ToString('o');name=$Name}
}
if(Test-Path "$runtime\runtime.json") { $started=@(Get-Content "$runtime\runtime.json" -Raw | ConvertFrom-Json) }
if(!(Test-LocalPort 5433)){
  $started+=Start-Component $postgres ('-D "'+$runtime+'\postgres" -p 5433 -h 127.0.0.1') 'postgres' $PSScriptRoot
  for($i=0;$i -lt 30 -and !(Test-LocalPort 5433);$i++){Start-Sleep -Milliseconds 500}
  if(!(Test-LocalPort 5433)){throw 'Database did not start; see .local/postgres.stderr.log'}
}
if(!(Test-LocalPort 4000)) { $started+=Start-Component $node 'node_modules/tsx/dist/cli.mjs src/server.ts' 'backend' "$PSScriptRoot\backend" }
if(!(Test-LocalPort 8000)) { $started+=Start-Component $node 'tools/frontend-server.cjs' 'frontend' $PSScriptRoot }
ConvertTo-Json -InputObject @($started) | Set-Content -Encoding utf8 "$runtime\runtime.json"
Write-Host 'Menu: http://localhost:8000/index.html?monitor=1'
Write-Host 'RFID: http://localhost:8000/rfid-setup.html'
if($StayOpen){while($true){Start-Sleep -Seconds 5}}
