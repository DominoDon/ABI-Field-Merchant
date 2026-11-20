@echo off
:: Fallback launcher - everything (web server + direct game-audio loopback) lives in the exe.
cd /d "%~dp0"
start "" "%~dp0Launch-ABI-Companion.exe"
