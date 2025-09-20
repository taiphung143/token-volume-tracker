@echo off
echo =================================================
echo    TOKEN VOLUME TRACKER - DEPLOYMENT HELPER
echo =================================================
echo.
echo This script helps you prepare your website for deployment.
echo.
echo Choose an option:
echo 1. Run locally (for development)
echo 2. Prepare for GitHub upload
echo 3. Open deployment guide
echo 4. Exit
echo.
set /p choice="Enter your choice (1-4): "

if "%choice%"=="1" goto local
if "%choice%"=="2" goto github
if "%choice%"=="3" goto guide
if "%choice%"=="4" goto exit

:local
echo.
echo Installing dependencies and starting local server...
npm install
echo.
echo Starting server... Open http://localhost:3000 in your browser
echo Press Ctrl+C to stop the server
echo.
npm start
goto end

:github
echo.
echo Preparing files for GitHub upload...
npm install
echo.
echo ✅ Dependencies installed
echo ✅ Files ready for GitHub
echo.
echo NEXT STEPS:
echo 1. Create a GitHub repository
echo 2. Upload these files to GitHub
echo 3. Deploy to Render (see DEPLOYMENT.md)
echo.
echo Opening deployment guide...
start DEPLOYMENT.md
goto end

:guide
echo Opening deployment guide...
start DEPLOYMENT.md
goto end

:exit
echo Goodbye!
goto end

:end
pause
