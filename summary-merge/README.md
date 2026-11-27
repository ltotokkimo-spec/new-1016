# Summary 合併統計工具（初版）

把來源目錄（含所有子目錄）裡檔名以 `Summary` 開頭的 Excel 合併成一份，依 Timestamp 排序。

## 使用
- Windows：雙擊 `merge_summary.bat` 選資料夾，或把資料夾拖到 bat 上
- 命令列：`python merge_summary.py <來源目錄> [-o 輸出.xlsx]`
- 需要：Python 3 + `pip install openpyxl`

## 輸出 `Merged_Summary_<起日>-<迄日>.xlsx`
- **Summary_SN**：每個 SN 一筆，跨日期取最新一次測試
- **TestRecord**：所有測試紀錄（同 Timestamp+SN 視為重複，只留一筆）
- **SourceFiles**：讀了哪些檔、各幾筆，方便核對
