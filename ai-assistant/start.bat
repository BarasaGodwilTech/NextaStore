@echo off
setlocal enabledelayedexpansion
title NextaStore AI (Nexi) - local assistant

REM ------------------------------------------------------------------
REM Starts the NextaStore AI assistant on this PC.
REM  - Only the models written in .env are used.
REM  - Any of them that are not installed in Ollama yet are downloaded.
REM  - Knowledge search is built in (no index to rebuild). Knowledge files reload by themselves.
REM Edit .env to choose your models, then run this file.
REM ------------------------------------------------------------------

REM Same IPv4-first setting as start-local.bat (avoids slow or failed "localhost" lookups on some PCs).
set "NODE_OPTIONS=--dns-result-order=ipv4first"

cd /d "%~dp0"

echo.
echo NextaStore AI assistant - local start
echo.

REM --- 1. Node.js ---
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install Node.js 18 or newer from https://nodejs.org and run this file again.
  goto :fail
)

REM --- 2. .env ---
if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
    echo There was no .env file, so one was created from .env.example.
    echo Opening it now. Choose your models, save it, then run start.bat again.
    start "" notepad ".env"
    pause
    exit /b 0
  )
  echo Missing .env and .env.example in this folder.
  goto :fail
)

REM --- 3. Packages (first run only) ---
if not exist "node_modules" (
  echo Installing assistant dependencies, first run only...
  call npm install
  if errorlevel 1 (
    echo npm install failed. Check your internet connection and try again.
    goto :fail
  )
)

REM --- 4. Read the model names from .env (same loader the assistant itself uses) ---
set "ENVCMD=%TEMP%\nextastore_ai_env_%RANDOM%.cmd"
node scripts\env-for-bat.js > "%ENVCMD%"
if errorlevel 1 (
  del "%ENVCMD%" >nul 2>nul
  echo.
  echo Fix .env and run start.bat again.
  goto :fail
)
call "%ENVCMD%"
del "%ENVCMD%" >nul 2>nul

echo Models from .env:
echo   Chat model:       %NX_CHAT%
if defined NX_EMBED (echo   Embedding model:  %NX_EMBED%) else (echo   Embedding model:  none needed, keyword search)
if defined NX_GANDA (echo   Luganda model:    %NX_GANDA%) else (echo   Luganda model:    none, Luganda follows LUGANDA_PROVIDER in .env)
echo.

REM --- 5. Find Ollama ---
set "OLLAMA=ollama"
where ollama >nul 2>nul
if errorlevel 1 (
  if exist "%LocalAppData%\Programs\Ollama\ollama.exe" (
    set "OLLAMA=%LocalAppData%\Programs\Ollama\ollama.exe"
  ) else (
    echo Ollama is not installed.
    echo Download it from https://ollama.com/download, install it, then run this file again.
    goto :fail
  )
)

REM --- 6. Make sure the Ollama server is running ---
call :ollama_up
if not errorlevel 1 goto :ollama_ready
if not "%NX_OLLAMA_LOCAL%"=="1" (
  echo Cannot reach Ollama at %OLLAMA_HOST%
  echo Check OLLAMA_HOST in .env and that the other machine is running Ollama.
  goto :fail
)
echo Ollama is not running. Starting it...
start "Ollama server" /min "%OLLAMA%" serve
set "TRIES=0"
:wait_ollama
call :ollama_up
if not errorlevel 1 goto :ollama_ready
set /a TRIES+=1
if !TRIES! GEQ 30 (
  echo Ollama did not start within 30 seconds.
  echo Open the Ollama app yourself, then run this file again.
  goto :fail
)
timeout /t 1 /nobreak >nul
goto :wait_ollama
:ollama_ready
echo Ollama is running.
echo.

REM --- 7. Models: install whatever from .env is missing ---
echo Checking models...
call :ensure_model "%NX_CHAT%" "Chat"
if errorlevel 1 goto :fail
if defined NX_EMBED (
  call :ensure_model "%NX_EMBED%" "Embedding"
  if errorlevel 1 goto :fail
)
if defined NX_GANDA (
  call :ensure_model "%NX_GANDA%" "Luganda"
  if errorlevel 1 goto :fail
)
echo.

REM --- 8. Knowledge index (only for the optional RETRIEVAL=hybrid mode; otherwise this does nothing) ---
node scripts\ensure-index.js
if errorlevel 1 goto :fail
echo.

REM --- 9. Is something already using the port? ---
netstat -ano | findstr /R /C:":%NX_PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo Something is already listening on port %NX_PORT%.
  echo If that is this assistant, it is already running. Close its window first.
  goto :fail
)

REM --- 10. Start the assistant ---
echo Starting the assistant on port %NX_PORT%.
echo Keep this window open. Press Ctrl+C or close it to stop.
echo.
call npm start
echo.
echo The assistant has stopped.
pause
exit /b 0

:fail
echo.
pause
exit /b 1

:ollama_up
"%OLLAMA%" list >nul 2>nul
exit /b %errorlevel%

:ensure_model
echo   %~2 model: %~1
"%OLLAMA%" show "%~1" >nul 2>nul
if not errorlevel 1 (
  echo     already installed.
  exit /b 0
)
echo     not installed yet, downloading it now. This can take a while.
"%OLLAMA%" pull "%~1"
if errorlevel 1 (
  echo.
  echo     Could not download %~1
  echo     Check the model name in .env and your internet connection.
  exit /b 1
)
echo     installed.
exit /b 0
