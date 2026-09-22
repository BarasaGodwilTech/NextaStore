@echo off
setlocal enabledelayedexpansion

REM This launcher is for LOCAL DEVELOPMENT. Keep a production .env file intact,
REM but force only the processes started by this script into development mode.
REM This prevents the production-only config checks (SMTP/R2/etc.) from stopping
REM a local server when those services are intentionally not configured.
set "NODE_ENV=development"

REM Some Windows/ISP setups have a broken IPv6 route while IPv4 works fine.
REM Node 18+ tries IPv6 first by default, which then hangs/fails (Prisma
REM P1001) even though the host is reachable over IPv4. Forcing IPv4-first
REM resolution here applies to every node/npx process this script launches
REM (prisma generate, prisma migrate/deploy, and node server.js).
set "NODE_OPTIONS=--dns-result-order=ipv4first"

cd /d "%~dp0"

echo.
echo NextaStore local start
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js/npm is not installed or not on PATH.
  echo Install Node.js 18+ and try again.
  pause
  exit /b 1
)

if not exist "nextastore-backend\.env" (
  copy /Y "nextastore-backend\.env.example" "nextastore-backend\.env" >nul
)

REM Decide whether DATABASE_URL points at a disposable local database or a
REM real/shared one. Local -> "prisma migrate dev" is fine (it's allowed to
REM reset a disposable local schema when it detects drift). Anything else
REM (Railway, RDS, Supabase, a shared team DB, etc.) -> use the safer
REM "prisma migrate deploy", which only applies pending migrations and never
REM resets the schema or touches existing data.
set "DB_URL="
for /f "usebackq tokens=1,* delims==" %%A in ("nextastore-backend\.env") do (
  if /I "%%A"=="DATABASE_URL" set "DB_URL=%%B"
)
REM NOTE: DB_URL almost always contains "&" (e.g. "?connection_limit=10&pool_timeout=20").
REM The old check piped it through "echo !DB_URL! | findstr ...", which hands that "&"
REM straight to cmd — cmd reads an unquoted "&" as a command separator and tries to run
REM "pool_timeout=20" as its own command. That's the "'pool_timeout' is not recognized..."
REM error you saw. Doing the substring check with variable substitution instead (no echo,
REM no pipe) never lets cmd re-parse the URL's contents, no matter what's in it.
set "IS_LOCAL_DB="
for %%K in (localhost 127.0.0.1 host.docker.internal) do (
  if not "!DB_URL:%%K=!"=="!DB_URL!" set "IS_LOCAL_DB=1"
)

set "DOCKER=docker"
where docker >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\Docker\Docker\resources\bin\docker.exe" set "DOCKER=%ProgramFiles%\Docker\Docker\resources\bin\docker.exe"
  if exist "%LocalAppData%\Programs\Docker\Docker\resources\bin\docker.exe" set "DOCKER=%LocalAppData%\Programs\Docker\Docker\resources\bin\docker.exe"
  if exist "%ProgramData%\DockerDesktop\version-bin\docker.exe" set "DOCKER=%ProgramData%\DockerDesktop\version-bin\docker.exe"
)

if /I "%DOCKER%"=="docker" (
  where docker >nul 2>nul
  if errorlevel 1 (
    echo Docker is not installed or not on PATH.
    echo.
    echo Install Docker Desktop for Windows (and make sure it finishes installing),
    echo then re-run this file.
    echo.
    echo If you already have a Postgres database elsewhere, you can continue without Docker
    echo but DATABASE_URL in nextastore-backend\.env must point to a working Postgres.
    echo.
    choice /C YN /M "Continue without Docker?"
    if errorlevel 2 (
      pause
      exit /b 1
    )
    set "SKIP_DOCKER=1"
  )
) else (
  if not exist "%DOCKER%" (
    echo Docker is not installed or not on PATH.
    echo.
    echo Install Docker Desktop for Windows (and make sure it finishes installing),
    echo then re-run this file.
    echo.
    echo If you already have a Postgres database elsewhere, you can continue without Docker
    echo but DATABASE_URL in nextastore-backend\.env must point to a working Postgres.
    echo.
    choice /C YN /M "Continue without Docker?"
    if errorlevel 2 (
      pause
      exit /b 1
    )
    set "SKIP_DOCKER=1"
  )
)

if not defined SKIP_DOCKER (
  "%DOCKER%" info >nul 2>nul
  if errorlevel 1 (
    echo Docker is installed but not running. Start Docker Desktop first.
    pause
    exit /b 1
  )

  set "HAS_CONTAINER="
  for /f "usebackq delims=" %%N in (`"%DOCKER%" ps -a --filter "name=nextastore-postgres" --format "{{.Names}}"`) do (
    if /I "%%N"=="nextastore-postgres" set "HAS_CONTAINER=1"
  )

  if not defined HAS_CONTAINER (
    echo Creating Postgres container: nextastore-postgres
    "%DOCKER%" run --name nextastore-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=nextastore -p 5432:5432 -d postgres:16
    if errorlevel 1 (
      echo Failed to create Postgres container.
      pause
      exit /b 1
    )
  ) else (
    echo Starting Postgres container: nextastore-postgres
    "%DOCKER%" start nextastore-postgres >nul 2>nul
  )

  echo Waiting for Postgres to be ready...
  set "READY="
  for /l %%I in (1,1,30) do (
    "%DOCKER%" exec nextastore-postgres pg_isready -U postgres -d nextastore >nul 2>nul
    if not errorlevel 1 (
      set "READY=1"
      goto :db_ready
    )
    timeout /t 1 /nobreak >nul
  )

  :db_ready
  if not defined READY (
    echo Postgres did not become ready in time.
    echo Try: "%DOCKER%" logs nextastore-postgres
    pause
    exit /b 1
  )
)

echo Starting frontend at http://localhost:3000 ...
start "NextaStore Frontend" cmd /k "cd /d ""%~dp0"" && npx http-server . -p 3000 -P http://127.0.0.1:4000"

echo.
echo Starting backend at http://localhost:4000 ...
echo.

cd /d "%~dp0nextastore-backend"

if not exist "node_modules" (
  echo Installing backend dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
) else if not exist "node_modules\@aws-sdk\client-s3" (
  echo Installing new backend dependency: @aws-sdk/client-s3 ...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

REM Device push notifications need a VAPID keypair in .env. This fills the two
REM keys only when both are empty (never overwrites), and never blocks startup.
call node scripts\ensure-vapid-keys.js

call npx prisma generate

if defined IS_LOCAL_DB (
  echo Applying migrations with "prisma migrate dev" ^(local database^)...
  call npx prisma migrate dev --name init
) else (
  echo Applying migrations with "prisma migrate deploy" ^(remote database - safe, no reset^)...
  call npx prisma migrate deploy
)
if errorlevel 1 (
  echo Migration failed.
  if defined IS_LOCAL_DB (
    echo Check DATABASE_URL in nextastore-backend\.env points to a running Postgres.
  ) else (
    echo Your database schema may be out of sync with the migration history.
    echo "prisma migrate deploy" never resets or drops data, so nothing was lost -
    echo it just refused to apply. If this is drift, write a new migration to
    echo reconcile it rather than running "migrate dev" against this database.
  )
  pause
  exit /b 1
)

REM Only seed a disposable LOCAL database. Never seed a Railway/RDS/Supabase/etc.
REM database just because the local launcher is being used against it.
if defined IS_LOCAL_DB (
  echo Seeding local development database...
  call npm run seed:dev
  if errorlevel 1 (
    echo Dev seed failed. The backend will not be started with incomplete local data.
    pause
    exit /b 1
  )
) else (
  echo Remote/shared DATABASE_URL detected; skipping dev seed.
)

start "" "http://localhost:3000/index.html"

call npm start

echo.
echo Backend stopped.
pause
