# Summary 合併統計工具

把來源目錄（含所有子目錄）裡檔名以 `Summary` 開頭的 Excel 合併成一份，依日期時間排序並產生統計。

## 使用
- **EXE**：GitHub → Actions → 「Summary Merge EXE」最新一次執行 → Artifacts 下載 `SummaryMerge`（zip 內是 `SummaryMerge.exe`），雙擊開啟
  1. 選「來源目錄」（輸出目錄可留空 = 放在來源目錄）
  2. 按「開始合併」，畫面顯示每日統計，完成後自動開啟 Excel
- 命令列：`SummaryMerge.exe <來源目錄> [-o 輸出.xlsx]`
- 原始碼執行：`pip install openpyxl` 後 `python summary_merge_app.py`

## 輸出 `Merged_Summary_<起日>-<迄日>.xlsx`
| 工作表 | 內容 |
|---|---|
| Statistics | 每日良率（含合計與圖表）、Detail / Spec_class / Contrast_class 依日期分類計數 |
| Summary_SN | 各日 Summary 全部保留，同 SN 不同時間的測試以 Date / Timestamp 區分 |
| TestRecord | 全部測試紀錄 |
| SourceFiles | 讀了哪些檔、各幾筆 |

- 資料頁前面加 `Date`、最後加 `Source_File` 欄
- 只有「同 SN + 同 Timestamp」視為重複（例如同一個檔被複製到兩個資料夾）
- 良率以 Summary_SN 為準；測試次數 / 平均秒數以 TestRecord 為準（平均秒數不含 aborted）
