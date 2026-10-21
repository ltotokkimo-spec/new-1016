@echo off
REM 打包成單一 exe（需先 pip install pyinstaller openpyxl）
cd /d "%~dp0"
for /f %%v in ('python -c "import log_viewer as m; print(m.APP_VERSION)"') do set VER=%%v
pyinstaller --noconfirm --onefile --windowed --name TestLogViewer_v%VER% log_viewer.py
echo 完成：dist\TestLogViewer_v%VER%.exe
pause
