@echo off
setlocal EnableDelayedExpansion

:: SmartCode v4 - Windows zagon prek Docker Compose
:: Uporabnik nastavi samo ALGATOR_ROOT v langserver\.env

set SCRIPT_DIR=%~dp0
set COMPOSE_DIR=%SCRIPT_DIR%langserver
set ENV_FILE=%COMPOSE_DIR%\.env

if not exist "%ENV_FILE%" (
    copy "%COMPOSE_DIR%\.env.example" "%ENV_FILE%" >nul
    echo Ustvarjen %ENV_FILE%
    echo Po potrebi popravi ALGATOR_ROOT in ponovno zazeni skripto.
)

where docker-compose >nul 2>nul
if %errorlevel% equ 0 (
    set DC=docker-compose
) else (
    set DC=docker compose
)

if "%1"=="stop"    goto stop
if "%1"=="logs"    goto logs
if "%1"=="restart" goto restart
if "%1"=="status"  goto status
goto start

:stop
%DC% -f "%COMPOSE_DIR%\docker-compose.yml" --env-file "%ENV_FILE%" down
goto end

:logs
%DC% -f "%COMPOSE_DIR%\docker-compose.yml" --env-file "%ENV_FILE%" logs -f
goto end

:restart
%DC% -f "%COMPOSE_DIR%\docker-compose.yml" --env-file "%ENV_FILE%" down
%DC% -f "%COMPOSE_DIR%\docker-compose.yml" --env-file "%ENV_FILE%" up -d --build
goto end

:status
%DC% -f "%COMPOSE_DIR%\docker-compose.yml" --env-file "%ENV_FILE%" ps
curl.exe -s http://localhost:3000/health
goto end

:start
echo === SmartCode v4 ===
echo Nastavitev poti: langserver\.env
echo Uporablja se samo ALGATOR_ROOT.
echo LSP: http://localhost:3000
echo.
%DC% -f "%COMPOSE_DIR%\docker-compose.yml" --env-file "%ENV_FILE%" up -d --build
if %errorlevel% neq 0 goto err
echo.
echo OK.
echo Logi:     smartcode.bat logs
echo Status:   smartcode.bat status
echo Ustavi:   smartcode.bat stop
goto end

:err
echo NAPAKA pri zagonu.
exit /b 1

:end
endlocal
