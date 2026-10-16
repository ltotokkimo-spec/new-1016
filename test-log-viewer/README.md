# 測試結果檢視器（operator_log.csv）

自動載入測試程式寫出的 `operator_log.csv`，持續偵測檔案變動，把新寫入的結果整理成固定格式表格：

`timestamp | date | time | opid | sn | verdict | hold_channels | fail_channels | CH0~CH5 | station | station_name`

![screenshot](screenshot.png)

## 功能
- **自動載入**：記住上次開的 CSV，下次開啟直接載入；也可用 `log_viewer.py <路徑>` 指定。
- **自動更新**：預設每 2 秒檢查檔案有沒有變動（看修改時間和檔案大小），有變動就重新讀取。測試程式寫到一半的行會先跳過。檔案被鎖住時，下一輪會自動再試。
- **時間排序**：`2026/10/14` 和 `2026-10-14` 兩種日期格式都能讀，統一顯示成 `YYYY/MM/DD`，再依時間排序。可勾選「最新在上」。
- **有新資料時自動捲到最新的一筆**，同時發出提示音，並顯示「新增 N 筆」。
- **上色**：
  - verdict：PASS 綠、FAIL 紅、HOLD 黃
  - CH 欄顯示 `ch_contrast`：fail 通道淺紅底紅字、hold 通道淺黃底褐字
  - 要改顏色，請修改程式開頭的 `COLORS`
- **篩選和統計**：可依日期、站別、結果或 SN/OPID 關鍵字篩選，上方即時顯示總數、PASS、FAIL、HOLD 和良率。
- **詳細資料**：雙擊任一列（或選取後按 Enter）會顯示各通道的 tof / contrast / cnr / noise / pkpk / baseline 和 notes 等完整欄位，並可一鍵開啟 `out_dir` 結果資料夾。
- **匯出**：把目前篩選的資料匯出成 Excel，格式和畫面相同（需要 `openpyxl`；沒有安裝時改匯出 CSV）。
- 用 Ctrl+C 複製選取的列（以 Tab 分隔，可直接貼進 Excel）。

## 直接使用 exe（免安裝 Python）
下載 [`release/TestLogViewer.exe`](release/TestLogViewer.exe)，雙擊即可執行。要重新打包時，到 GitHub Actions 的「Build TestLogViewer.exe」按 Run workflow，它會在 Windows 上打包並把 exe 存回分支。

## 用 Python 執行
只需要 Python 3.8 以上（內建 tkinter），不必另外安裝套件。
```
python log_viewer.py "C:\path\to\operator_log.csv"
```
或雙擊 `run.bat`。第一次執行若沒有指定檔案，會跳出選檔視窗。

## 打包成 exe（給產線電腦用）
```
pip install pyinstaller openpyxl
build_exe.bat
```
打包好的檔案在 `dist\TestLogViewer.exe`。設定會存在 exe 旁邊的 `log_viewer_settings.json`。
