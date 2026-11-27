@echo off
chcp 65001 >nul
REM 可直接雙擊（會跳出選資料夾視窗），或把資料夾拖曳到這個 bat 上
python "%~dp0merge_summary.py" %*
pause
