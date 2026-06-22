@echo off
setlocal EnableDelayedExpansion

:: SmartCode — Windows zagonski skript
:: Zahteva: Docker Desktop
:: Zaženite iz mape smartCodev4\

set SCRIPT_DIR=%~dp0
set COMPOSE_DIR=%SCRIPT_DIR%langserver
set ENV_FILE=%COMPOSE_DIR%\.env

:: Ustvari .env če ne obstaja
if not exist "%ENV_FILE%" (
    copy "%COMPOSE_DIR%\.env.example" "%ENV_FILE%" >nul
    echo Ustvarjen %ENV_FILE% — preveri poti pred zagonom!
)

if "%1"=="stop"    goto stop
if "%1"=="logs"    goto logs
if "%1"=="restart" goto restart
if "%1"=="status"  goto status
goto start

:stop
docker-compose -f "%COMPOSE_DIR%\docker-compose.yml" --env-file "%ENV_FILE%" down
goto end

:logs
docker-compose -f "%COMPOSE_DIR%\docker-compose.yml" --env-file "%ENV_FILE%" logs -f
goto end

:restart
docker-compose -f "%COMPOSE_DIR%\docker-compose.yml" --env-file "%ENV_FILE%" down
docker-compose -f "%COMPOSE_DIR%\docker-compose.yml" --env-file "%ENV_FILE%" up -d --build
goto end

:status
docker-compose -f "%COMPOSE_DIR%\docker-compose.yml" --env-file "%ENV_FILE%" ps
curl -s http://localhost:3000/health
goto end

:start
echo === SmartCode ===
echo   Za spremembo poti uredi: langserver\.env
echo   LSP: http://localhost:3000
echo.
docker-compose -f "%COMPOSE_DIR%\docker-compose.yml" --env-file "%ENV_FILE%" up -d --build
if %errorlevel% neq 0 goto err
echo.
echo OK. Odpri urejevalnik:
echo   editor-single.html?projectFolder=PROJ-BasicSort
echo.
echo   smartcode.bat logs   — logi
echo   smartcode.bat stop   — ustavi
goto end

:err
echo NAPAKA!
exit /b 1

:end
endlocal
