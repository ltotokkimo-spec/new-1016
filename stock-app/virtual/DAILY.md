# Claude 虛擬自組 ETF：每日操作程序

使用者想觀察「照 Claude 建議操作」的效果：Claude 用虛擬 10 萬元每天自動操作，App 的「自組ETF → Claude 虛擬操作」顯示結果。
這份程序由每個交易日 17:40（台北）啟動的排程任務執行。全部用繁體中文。不是投資建議，只是模擬。

## 檔案
- 狀態檔：`stock-app/virtual/virtual-etf.json`（分支 `claude/ui-calculator-interface-t3x9kh`；App 從 raw.githubusercontent.com 讀它）
- 工具：`node --experimental-strip-types tools/virtual-etf.ts <指令> virtual/virtual-etf.json ...`（在 `stock-app/` 目錄執行；不用 npm install）
  - `show`：目前狀態　`fill <日期> <quotes.json>`　`close <日期> <quotes.json>`　`order <日期> <orders.json>`　`note <日期> <文字>`
- 價格一律用證交所資料工具（MCP，名稱類似 `get_realtime_quote`，收盤後回傳當天開高低收；上市、上櫃都可查）。這個環境連不到證交所網站，不要用 curl。

## 步驟（D = 今天，台北日期 YYYYMMDD）
1. `git pull origin claude/ui-calculator-interface-t3x9kh`，再 `show` 看狀態。如果狀態的 `asOf` 已經是 D，代表今天做過了，直接結束。
2. 用 `get_realtime_quote` 查 0050 確認今天有交易（時間戳是今天）。沒交易（假日、颱風）就結束，不要改檔案。
3. **成交前一天的委託**：查所有 `pending` 代號與 0050 的今日開高低收，寫成 quotes.json，執行 `fill D quotes.json`。
4. **收盤**：查所有持股與 0050 的收盤（同樣的 quotes 格式），執行 `close D quotes.json`。工具會自動把收盤跌破停損價的持股排入明天開盤賣出。
5. **研究與決策**（重點，不用每天都交易）：
   - 對每檔持股：用 MCP 查最近的三大法人買賣超、重大訊息、月營收（每月 10 日前後公布），並上網搜尋最近 3 天新聞。
   - 判斷要不要賣出、減碼、加碼；也可以從 App 的邏輯找新標的：近 1 月動能強但近 1 週漲幅沒過熱、外資連續買超、營收年增。
   - 規則：持股 4～8 檔、至少 3 個產業、單一檔不超過淨值 25%、保留 3～5% 現金、零股以「股」為單位、買進都要給停損價；不追高（限價設在今天收盤價附近，最多 +1.5%）。
   - 避免過度交易：沒有明確理由就維持不變。單日換股不超過 2 檔。
   - 有要做的就寫 orders.json：`[{"code":"2330","name":"台積電","side":"buy","shares":10,"limit":1010,"stop":930,"reason":"一句話理由"}]`，執行 `order D orders.json`。賣出不用 limit。
6. **寫說明**：`note D "..."`，2～4 句：今天組合表現與 0050 比較、明天要做什麼（或為什麼不動）、需要注意的風險。
7. `show` 檢查沒有錯（沒有負現金、沒有缺價）。然後只 `git add stock-app/virtual/virtual-etf.json`，commit 訊息「virtual-etf: D 收盤更新」，`git push origin claude/ui-calculator-interface-t3x9kh`（衝突就 `git pull --rebase` 再推，最多重試 4 次）。只改這個 JSON，不要改其他程式。
8. 發手機推播（PushNotification 工具），一行：「✅ 虛擬ETF D：淨值 X（+Y%），0050 +Z%；明天：…」。失敗就推「❌ 虛擬ETF D 更新失敗：原因」。
