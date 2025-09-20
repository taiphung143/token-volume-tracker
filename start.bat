@echo off
echo Installing dependencies...
npm install

echo.
echo Starting the Token Volume Tracker server...
echo Open your browser and go to: http://localhost:3000
echo.
echo Press Ctrl+C to stop the server when you're done.
echo.

npm start

pause
