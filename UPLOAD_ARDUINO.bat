@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0UPLOAD_ARDUINO.ps1" -Port COM3
pause
