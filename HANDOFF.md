# 交接檔：掃雷專區（stock-app）與周邊排程

> 寫於 2026-10-21，供新的 Claude Code 對話接手。**先讀這份，再讀 `CLAUDE.md`（工作方式）與 `stock-app/virtual/DAILY.md`（虛擬 ETF 每日程序）。**
> 這份是「事實與決定」的整理，數字會變的（持股、淨值）請以檔案為準，不要照抄這裡。

## 1. 專案概況
- **掃雷專區**：個人用 Android 選股 App（Capacitor + Preact，繁體中文）。台股／美股／ETF 選股、族群、持股、自組 ETF、數據。
- Repo：`ltotokkimo-spec/new-1016`，本機資料夾叫 `-`。**開發分支 `claude/ui-calculator-interface-t3x9kh`**（repo 預設分支是 `claude/conversation-start-guide-ya0q8x`，每日回測的觸發 workflow 放在那邊）。
- 同一個 repo 還有計算機、小畫家（根目錄的 `calculator.py`、`paint.py`、`tests/`），與選股 App 無關。
- 已發布版本：**1.0.72**（Releases `stock-radar-latest`：`stock-radar.apk` ＋ `version.json`；App 內按「更新」下載）。單元測試 108 項。
- 使用者用 ROG Phone 6D（Android 14）。想要 iPhone 版，目前**未決**（見 §9）。

## 2. 工作方式（使用者指定，完整版在 CLAUDE.md）
- 自己查、自己修、自己驗證；完成後看過 CI 截圖才說完成。只在真的需要使用者決定時才問，要列選項並標推薦。
- 等待時先說「在等什麼、預計多久、背景執行中，不需要你操作」。
- **全部跑完的回覆第一行**要寫 `✅ 全部完成：…`／`❌ 失敗：原因`／`⏳ 還在跑：預計 N 分鐘`，並發手機推播（PushNotification）。
- 繁體中文回覆。台灣習慣：**漲紅、跌綠**。
- 使用者重視省算力（見 §7）。**現在這個對話在試用 Sonnet 5.5**，要切回 Opus 用 `/model claude-opus-5-5`。

## 3. 安全與禁忌（不可違反）
- **Anthropic API 金鑰只存在 scratchpad 的 `.key` 檔，絕不 commit、push、印出。** 新對話的 scratchpad 不同，可能沒有這個檔，要時請使用者重新提供。
- CI 只在 `workflow_dispatch` 才傳 `ANTHROPIC_API_KEY`，**不要手動觸發 dispatch**（會花使用者的錢）。要重跑失敗的測試用 REST：`gh api -X POST repos/ltotokkimo-spec/new-1016/actions/runs/<id>/rerun-failed-jobs`。
- 使用者給過一包「方舟 API」工具包（含 `config.json` 憑證）。**憑證不可放進 repo、不可傳給任何服務**；那包只讀過文件，沒接進 App。
- 其他排程使用的報表資料庫含使用者持股：**只能寫進該報表自己，不要把持股、成本、損益寫到別處**。
- 排程多半是別的對話建立的，**改之前要使用者點頭**（10/21 已改過三個，見 §7）。

## 4. 環境與已知坑
- 雲端環境**連不到證交所**，資料相關驗證一律靠 GitHub Actions（模擬器＋真實網路）。
- 每次重啟後 remote 網址會被改掉：**推送前先** `git remote set-url origin https://github.com/ltotokkimo-spec/new-1016`。
- 推送會**取消**同分支還在跑的 CI → **一次改完再推**，不要多個小提交連續推。
- 打包測試前有「證交所連線檢查」（最多等 4 分鐘）；證交所常暫時擋美國主機，失敗先看是不是這個，再用 REST 重跑一次。
- 讀 CI 紀錄：`mcp__github__get_job_logs` 輸出極大，會存成檔案；用 Python 找 `RESULTS [...]`、`E2E 失敗`、`=====BEGIN 名稱=====` 的 base64 截圖（先去掉時間戳與非 base64 字元再解碼）。`gh` 的 GraphQL 與寫入 Releases 會被擋，REST 讀取與 rerun 可用。
- 推到 `stock-app/**`（除了 `probe/`、`virtual/`）會觸發 12 分鐘完整測試；推根目錄檔案會觸發 Windows 打包，純文件變更請在提交訊息加 `[skip ci]`。
- 本機 Vite：重啟用 `setsid nohup npx vite --port 5173`，**不要 `pkill`（會殺掉 shell）**。
- e2e 的美股檢查會依「紐約現在幾點」判斷預期（半夜顯示收盤是正確的），別改成固定預期。

## 5. 程式地圖（`stock-app/`）
| 檔案 | 作用 |
|---|---|
| `src/store.ts` | 全域狀態、`autoRefresh`、`refreshTw/Us/Live/UsLive/TwIndex`、自組 ETF 與虛擬 ETF |
| `src/engine/score.ts` | 評分與買入／觀望／離場規則 |
| `src/engine/turning.ts` | 「剛轉強」：MA20/MA60/MACD/RSI/布林；由每日回測算好、App 下載 |
| `src/engine/backtest.ts` | 回測（含剛轉強過去表現）；`tools/backtest.ts` 在 CI 跑 |
| `src/engine/aiEtf.ts`、`virtualEtf.ts` | 自組 ETF 與 Claude 虛擬操作的計算 |
| `src/data/twLive.ts`、`twIndexLive.ts`、`usLive.ts` | 台股即時價／指數盤中（證交所 MIS）、美股即時價（CNBC，含盤前盤後） |
| `src/data/twLoader.ts`、`usLoader.ts` | 台股全市場、美股日 K 載入與快取 |
| `src/lib/dates.ts` | 日期與重抓規則（台北時間；美股用紐約時間判斷資料日） |
| `src/ui/screens.tsx`、`aiEtf.tsx` | 畫面 |
| `tools/e2e-android.cjs` | 模擬器真實網路測試與截圖（約 54 項檢查）；`tools/probe/*.mjs` 在 CI 探測資料來源 |
| `.github/workflows/stock-app.yml` | 打包 APK → e2e → 發布 |
| `virtual/virtual-etf.json`、`virtual/DAILY.md`、`tools/virtual-etf.ts` | 虛擬 ETF 狀態、每日程序、指令工具 |

## 6. 資料來源與關鍵事實
- **台股**：證交所／櫃買每日行情與三大法人；盤中用 `mis.twse.com.tw`（`tse_t00.tw` 加權、`tse_TW50.tw`、`tse_t24.tw` 半導體、`tse_t17.tw` 金融保險、`tse_t13.tw` 電子、`otc_o00.tw` 櫃買）。**MIS 指數的 `m` = 累計成交量（張）、`r` = 成交筆數**（已用官方每日量值對準）。盤中**成交金額與漲跌家數沒有免費來源**（`getStatis` 等端點都 404）。
- **美股**：Nasdaq 日 K ＋ CNBC 即時報價。Nasdaq 收盤後常晚更新，所以收盤後用 CNBC 正式收盤補當天、每 30 分鐘重試；**紐約半夜 CNBC 的 `last_time` 只剩日期、`previous_day_closing` 會等於收盤，今日漲跌要用 `change` 算昨收**。盤後漲跌自己對照收盤算（不用 CNBC 的 `change_pct`）。
- **自動重抓**：台股——沒資料、不是今天、超過 3 小時，或 16:30 後但資料是 16:30 前抓的；美股——紐約 17:00 後尚未抓到當天收盤，或資料日落後最近交易日且超過 30 分鐘。
- **剛轉強**條件：收盤在 20 日線上方 5% 內、不低於 60 日線的 98%、MACD 柱 5 天內由負轉正、RSI<70、不在布林上軌之上、外資＋投信 5 日買超、成交額 ≥ 5 千萬。**過去半年回測：之後 20 天平均只有 +0.1%、上漲機率 48%**，比 App 原本的「買入」（+3.7%）差。App 內有如實顯示。
- 其他 MCP：「台股官方」（工具前綴 `mcp__1710cc71-…__`，有即時報價、技術指標、法人、財報；上櫃歷史用 `get_otc_stock_history`，上市單日用 `get_stock_daily_trading`）。

## 7. 排程與算力（2026-10-21 盤點）
- 平日約 13 次排程＋1 個手動觸發，**幾乎都已用 Sonnet**；只有「虛擬 ETF」那個會叫醒**這個對話**。
- **10/20 台北 14:11–19:40 所有排程都因 `USAGE_LIMIT_REACHED` 失敗**（共 8 次）；備援排程與主排程共用同一份額度，額度用完備援也一起失敗。
- 最大的消耗：06:10 主分析（27 檔，約 6 分鐘）、10:23 盤中動能、17:55 持股報表，以及長對話本身（每回合重讀整段歷史）。
- **10/21 已改（使用者同意）**：①06:40／07:40 補漏不再寫 `mcp_avail` 紀錄（檢查保留）②15:00 收盤價收集拿掉興櫃步驟（改名「僅上市櫃」）③貝爾威勒追蹤改每週五 18:30。06:10 主排程裡同樣的紀錄**刻意沒動**（提示詞太長，重寫風險大於省下的一次寫入）。
- 6990 華鉬已從追蹤清單與興櫃營收移除（歷史預測保留，備份在當時的暫存資料夾，環境重啟後沒了）。

## 8. 虛擬 ETF（Claude 用虛擬 10 萬操作）
- 狀態檔 `stock-app/virtual/virtual-etf.json`；App 讀 `https://raw.githubusercontent.com/ltotokkimo-spec/new-1016/claude/ui-calculator-interface-t3x9kh/stock-app/virtual/virtual-etf.json`。程序在 `DAILY.md`，指令 `node --experimental-strip-types tools/virtual-etf.ts <init|fill|close|order|note|show> virtual/virtual-etf.json …`（在 `stock-app/` 執行）。
- 排程（10/22 起）`trig_01P8toMCwxC8oqAhFiSS27tp`：平日 17:40（台北），**綁定 `session_01ApWNmMJa7iJ1ivpuuMR7hZ`（這個有 repo 與台股官方 MCP 的對話）**。舊排程 `trig_01GKTYGpLeqWRS2Nrv75CoTv` 綁的對話已失效：10/21 17:40 在沒有 repo、沒有 MCP 的空對話裡執行，**當天沒有更新**（狀態停在 10/20），已於 10/22 使用者同意後停用。10/21、10/22 已用證交所真實價格補跑（note 標【補跑】）。CLI 參數順序是 `指令 <state> <日期> <quotes>`。若這個對話不再可用，要重建排程並先測新對話查得到台股行情。
- 10/20 收盤：淨值 97,733（−2.27%），0050 −0.50%。持有大成鋼、元大金、長榮、儒鴻、潤泰新、中鋼；10/21 開盤的委託是賣元大金 110 股、買宏碁 250 股（限價 32.85、停損 30.9）。
- **10/21 起資金加碼到 50 萬**（`topup` 指令，加入的錢當作之前閒置的現金；App 另外列加碼前報酬），配置改成**核心＋衛星**（核心約 45%：台積電、鴻海、台達電，分批進場；使用者不要 0050）。細節在 `DAILY.md`。
- **資金水位**（10/21 使用者指定）：平常 7 成股票、3 成現金；加權指數距 20 日高點跌 5% 起最多 8 成、10% 起最多 9 成。每日排程用 `cash` 指令記錄判斷，App「資金水位」卡片顯示。
- **每週六 09:50 週檢視**：排程 `trig_015iTBWsQ3HRo3CfsdP7Djom`，綁定對話 `session_01ApWNmMJa7iJ1ivpuuMR7hZ`（新對話排程拿不到台股官方連接器與 repo，所以綁舊對話）；結果寫在 `stock-app/virtual/WEEKLY.md`，只在有數據時調整 `DAILY.md` 規則，大方向改變等使用者決定。
- 規則：買進前要「離 20 日線 5% 內、MACD 或 KD 剛翻多、RSI<70、法人買超」，持股高檔回落（跌破 5 日線＋KD 高檔死叉）就換股；觀察名單：潤泰新、中鋼、友達。目的之一是**比較「剛轉強不追高」和「動能追強勢」哪個好**。

## 8b. 評分研究與影子追蹤（2026-10-22 起，**不要改凍結的設定**）
- **回測拉長到約 2 年**（`stock-backtest.yml`、`tools/backtest.ts`：520 個平日，有下載時間預算 80 分鐘，連線重置時等 10→60 秒重試最多 6 次，單日失敗先用已下載的連續天數、進度存快取下次接著）。每天 18:40 自動跑；推送改到 `src/engine/**`、`src/data/**`、`tools/backtest.ts` 也會觸發，約 10 分鐘（有快取）。
- 回測順便輸出兩個研究檔到 Releases `stock-radar-data`：`factors.json`（`src/engine/factors.ts`，各因子對之後 5／20 日報酬的 IC、五等分、大盤漲跌與前後半）與 `scorecompare.json`（`src/engine/scoreCompare.ts`，5 組評分權重對照＋影子追蹤）。**只是研究，不影響 App 的評分**（`score.ts` 的 `DEFAULT_WEIGHTS` 沒動；`scoreStocks` 多了可選的權重參數）。
- **2 年因子分析結論（4/14 的 9 個月結論「近 3 月漲幅反向」拉長後消失，是單一行情的巧合）**：穩定的只有「成交金額大」（20 日 IC +0.068，t 3.0）、「外資連買／外資買超佔比」微弱正向、「投信買超」穩定反向；動能、族群沒預測力；現有總分 IC≈0，大盤下跌日失效。**這 1.7 年偏多、含大型股領漲，流動性其實是大型股效應，行情轉向可能反轉。**
- 新舊評分對照（20 日，後半期）：現有 IC +0.002；A 去投信 +0.006（不如現有）；B 去投信＋流動性 15 +0.024；**C 動能20 籌碼40（外資佔比70＋連買30、無投信）族群15 流動性25 +0.043**；D 只看外資＋流動性 +0.059（但買入檔數 43→62）。依事先標準（後半期 IC 與前 5% 都優於現有等）**沒有任何一組通過**，使用者決定做樣本外**影子追蹤**。
- **影子追蹤（`SHADOW_START=20261015`、`SHADOW_KEY="C"`，單元測試鎖死 C 的權重與起始日；要改就等於重新開始，必須先跟使用者說）**：只算 10/15 之後的評等日，20 日報酬成熟的評等日 ≥ 40 天（約 2027 年 1 月中旬）才判定；標準寫在 `scoreCompare.ts` 開頭與 `shadowVerdict`：C 的 IC、前 5%、買入組超額都不輸現有、大盤下跌日（≥10 天）IC 不輸、買入檔數在現有 ±30% 內。`scorecompare.json` 的 `shadow` 欄位有進度、`liqSpread`（成交金額最大減最小五分之一的報酬差，轉負＝大型股效應反轉的警訊）與最新兩份買入名單。**每週六 09:50 週檢視排程已加入讀取並回報（10/22 使用者同意）；通過或未通過時要明確寫「需要你決定」，不要自己換 App 評分。**
- **已決定（10/22 使用者指定）**：①自組 ETF 候選池加「成交金額 ≥ 全市場中位數（約 3 億）」（`pickCandidates` 的 `liquidityCut`，已發布 1.0.108）；②**虛擬 ETF 衛星新買進改成「外資連買 ≥3 天＋成交金額 ≥ 3 億」，取代「剛轉強」**（改的是 `stock-app/virtual/DAILY.md`，排程本身沒動；理由：2 年回測「剛轉強」20 日平均 +2.3% < 全部 +2.7%，贏過中位數 51%）。舊衛星持股不強賣；10/22 起新買進的 `reason` 要寫「外資連買 N 天、成交金額 X 億」，週檢視用來和舊規則的持股分開比較。
- 「買入」說明（`freeReport.ts`）已依 2 年回測更正：買入組 20 日平均只比全部略好（+3.7% vs +2.7%，贏過中位數 52%）。

## 8c. 數據頁台指期（2026-10-22）
- 期交所 MIS（`https://mis.taifex.com.tw/futures/api/getQuoteList`，**POST JSON**，`MarketType` 0 = 日盤、1 = 夜盤，`CID: "TXF"`）。解析在 `src/data/taifexLive.ts`，取清單裡第一個 `TXF[A-L]\d-[FM]`（近月）；夜盤收盤後到隔天開盤前仍回傳昨晚資料；日盤開盤前沒有成交價就不顯示。`src/lib/net.ts` 的 `postJson`（手機走 `CapacitorHttp.post`，開發走 Vite proxy）。單元測試用真實回應。
- 這個雲端環境連不到期交所；要看真實回應就在 `stock-app/tools/probe/` 放探測腳本並推送（只動 probe 不會觸發 App CI，約 1 分鐘出結果）。

## 9. 待辦與未決（都等使用者決定，不要自己開工）
1. **漲跌家數（收盤版）**：盤中沒有免費來源；可用收盤資料算並標「收盤」。使用者未回覆。
2. **iPhone 版**：免費 PWA（Safari 加到主畫面，無推播）vs. TestFlight（US$99/年）。已解釋，使用者未選。
3. **方舟 API**：只有 K9／目標價／風控水位等，沒有股價；建議只在需要時加「美股分析師目標價」，且憑證只放 GitHub Secret。未決。
4. **排程進一步減耗**：把 14:40／19:40 補漏併進主排程、改每日排程為新對話——使用者決定先不動。
5. **10/20 缺口還沒補**：興櫃收盤價、`closes`（15:00 收盤價）兩份資料；收盤回填已補（只缺 6990，已移除）；收盤後歸因（`post_close_reason`）沒做。持股報表今晚 17:55 會自己更新。
6. 使用者說接下來要在**一般聊天**聊「投資迷思」，不需要這個專案的檔案；需要時會貼片段過來。

## 10. 接手檢查清單
1. `git remote set-url …`（見 §4）→ `git pull origin claude/ui-calculator-interface-t3x9kh` → `git log --oneline -5`。
2. 看 `stock-app/RELEASE_NOTES.txt` 與 Releases 的 `version.json` 確認已發布版本。
3. 跑 `cd stock-app && npm ci && npm test`（`npx tsc --noEmit -p .` 也要過）。
4. 改完一次推送，等 CI，**自己看截圖**再回報。
