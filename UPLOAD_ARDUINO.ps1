param([string]$Port='COM3')
$ErrorActionPreference='Stop'
$programmer=Join-Path $PSScriptRoot '.local\programmer'
$firmware=Join-Path $PSScriptRoot '.local\firmware\rc522_payment.ino.hex'
if($Port -notmatch '^COM\d+$'){throw 'Specify a port such as COM3'}
Write-Host 'Uno: RGB D5/D6/D7, no buzzer (D4 unused), RC522 SS D10, RST D9.'
Write-Host 'Close Serial Monitor and disconnect the browser from Arduino before upload.'
& "$programmer\bin\avrdude.exe" -C "$programmer\etc\avrdude.conf" -p atmega328p -c arduino -P $Port -b 115200 -D -U "flash:w:${firmware}:i"
if($LASTEXITCODE -ne 0){throw 'Upload failed. Check COM port, USB cable, and other apps using the board.'}
Write-Host 'Verified. Open http://localhost:8000/rfid-setup.html and assign two payment cards and one waiter badge.'
