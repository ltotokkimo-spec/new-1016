# 測試資料工具（TestDataTool）

一個程式、兩個分頁：

| 分頁 | 內容 |
|---|---|
| **Cal Testing**（測試結果 CSV） | operator_log.csv 即時檢視。兩組來源設定（各自可啟用 / 清除），資料合併顯示並以「來源」欄區分。測試程式往下追加資料時自動更新 |
| **Roll Testing**（Summary 統計） | 來源目錄往下找所有 `Summary*.xlsx`，合併 TestRecord / Summary_SN，即時更新、篩選、統計、匯出 |

## 共同功能
- **表格外觀照原程式**：黑底表頭、格線；verdict / Result 整格上色（PASS 綠、FAIL 紅、HOLD 橘、Aborted 灰），FAIL / HOLD 通道格上色，重覆測試的 SN 紫色；拖曳表頭邊界調整欄寬（會記住）
- **自動更新**：每 N 秒偵測檔案變動，只重讀有變的檔案；「最新在上」、「有新資料時自動捲到最新」
- **篩選**：日期（可多選）、時間區間（`HH:MM` = 每天同時段；含日期 = 指定區間，可跨天）、下拉選單、SN（可貼多個，空白或逗號分隔）、只看重覆測試、清除篩選
- **統計列**：總數 / Pass / Fail / 良率 / 重覆測試
- **表格**：點標題排序、Ctrl/Shift 多選、Ctrl+A、Ctrl+C（Tab 分隔可直接貼到 Excel）、只顯示選取的列、選擇欄位
- **右鍵**：複製格 / 列 / 整欄、用此 SN 篩選、只看這一天、從此時間開始 / 到此時間結束、開啟資料夾
- **雙擊 / Enter**：詳細資料（CSV 分頁有各通道 tof / contrast / cnr / noise / pkpk / baseline 表）

## 分頁說明
**測試結果 (CSV)**：預設讀程式旁邊的 `operator_log.csv`。verdict 依 PASS / FAIL / HOLD 上色，同站重覆測試標記次數，cal2 站別標 FT / RT。匯出 Excel 時 verdict、FAIL / HOLD 通道、重覆 SN 會上色。

**Summary 統計**：可切換 TestRecord（每次測試）/ Summary_SN。「統計…」可看每日良率、Detail / Spec_class / Contrast_class 分類。「匯出 Excel」會輸出目前篩選後的資料 + 統計頁（含圖表）；「合併全部存到來源目錄」輸出 `Merged_Summary_<起日>-<迄日>.xlsx`。

## 程式內更新
說明 → **檢查更新**：從更新來源下載最新程式碼，確認後自動重開，不用重新下載 exe。
- 判斷依據是「檔案內容」，來源的程式只要有改就會偵測到
- 預設來源是本 repo 分支的 GitHub raw 網址；也可在「更新來源設定」改成共用資料夾（例如 `\\server\share\TestDataTool`），讓產線多台電腦一起更新
- 下載的程式有語法錯誤不會安裝；載入失敗會自動退回 exe 內建版本；「回復 exe 內建版本」可手動還原
- 開發測試：在 exe 旁邊建 `app\` 資料夾放 .py，會優先使用

## 下載 / 執行
- **EXE**：GitHub → Actions → 「Summary Merge EXE」最新一次執行 → Artifacts 下載 `TestDataTool`（zip 內是 `TestDataTool.exe`）
- 原始碼：`pip install openpyxl` 後 `python launcher.py`
- 命令列（只合併 Summary，不開視窗）：`TestDataTool.exe <來源目錄> [-o 輸出.xlsx]`
- 設定檔：`%APPDATA%\SummaryMerge\settings.json`
