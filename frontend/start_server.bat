@echo off
title Restaurant Menu Server
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 goto use_py

where python >nul 2>nul
if %errorlevel%==0 goto use_python

echo Python not found. Install Python or run the project through another local web server.
pause
exit /b 1

:use_py
start "" "http://localhost:8000/index.html"
py -m http.server 8000
goto end

:use_python
start "" "http://localhost:8000/index.html"
python -m http.server 8000

:end
pause
