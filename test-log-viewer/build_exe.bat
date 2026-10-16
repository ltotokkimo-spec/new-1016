@echo off
REM 打包成單一 exe（需先 pip install pyinstaller openpyxl）
cd /d "%~dp0"
pyinstaller --noconfirm --onefile --windowed --name TestLogViewer log_viewer.py
echo 完成：dist\TestLogViewer.exe
pause
