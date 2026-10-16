@echo off
title College Cricket Tournament App
echo ========================================================
echo  COLLEGE CRICKET TOURNAMENT WEB APP (PWA)
echo ========================================================
echo.
echo Starting local lightweight web server...
echo.

where python >nul 2>nul
if %errorlevel% equ 0 (
    echo Python detected. Launching HTTP server on http://localhost:8080 ...
    start "" http://localhost:8080
    python -m http.server 8080
    goto :end
)

where node >nul 2>nul
if %errorlevel% equ 0 (
    echo Node.js detected. Launching npx serve on http://localhost:8080 ...
    start "" http://localhost:8080
    npx -y serve -l 8080 .
    goto :end
)

echo Opening index.html directly in browser...
start "" index.html

:end
pause
