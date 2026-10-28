@echo off
title LyricTok Local Studio (Python + FFmpeg GPU Server)
cd /d "%~dp0"
echo Starting LyricTok Studio (Python + FFmpeg H.264 NVENC Engine) on http://localhost:3000 ...
start "" "http://localhost:3000"
python server.py
