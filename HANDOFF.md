# 交接檔：金雷達（stock-app，10/27 由「掃雷專區」改名「掃金雷達」，10/28 再改「金雷達」）與周邊排程

> 初版 2026-10-21，**2026-10-23 更新（使用者換聊天室）**，供新的 Claude Code 對話接手。**先讀這份，再讀 `CLAUDE.md`（工作方式）與 `stock-app/virtual/DAILY.md`（虛擬 ETF 每日程序）。**
> 這份是「事實與決定」的整理，數字會變的（持股、淨值）請以檔案為準，不要照抄這裡。

## 1. 專案概況
- **金雷達**：個人用 Android 選股 App（Capacitor + Preact，繁體中文）。台股／美股／ETF 選股、族群、持股、自組 ETF、數據。
- Repo：`ltotokkimo-spec/new-1016`，本機資料夾叫 `-`。**開發分支 `claude/ui-calculator-interface-t3x9kh`**（repo 預設分支是 `claude/conversation-start-guide-ya0q8x`，每日回測的觸發 workflow 放在那邊）。
- 同一個 repo 還有計算機、小畫家（根目錄的 `calculator.py`、`paint.py`、`tests/`），與選股 App 無關。
- 已發布版本：**1.0.132**（2026-10-22 深夜，Releases `stock-radar-latest`：`stock-radar.apk` ＋ `version.json`；App 內按「更新」下載）。單元測試 184 項、模擬器 e2e 約 100 項檢查。
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
- **模型（10/23 使用者指定：Claude 虛擬每日選股固定用 Opus 5.5）**：每日排程沒有自己的模型設定（`model` 為空），綁定對話時會沿用「那個對話目前的模型」；`update_trigger` 的 model 對綁定既有對話的排程無效。所以要在該對話（`session_01ApWNmMJa7iJ1ivpuuMR7hZ`）輸入 `/model claude-opus-5-5`，之後不要再切走；對話內若又切成 Sonnet，排程隔天就會跟著用 Sonnet。
- 排程（10/22 起）`trig_01P8toMCwxC8oqAhFiSS27tp`：平日 16:40（台北；10/27 使用者要求從 17:40 提早，和規則組合一致），**綁定 `session_01ApWNmMJa7iJ1ivpuuMR7hZ`（這個有 repo 與台股官方 MCP 的對話）**。舊排程 `trig_01GKTYGpLeqWRS2Nrv75CoTv` 綁的對話已失效：10/21 17:40 在沒有 repo、沒有 MCP 的空對話裡執行，**當天沒有更新**（狀態停在 10/20），已於 10/22 使用者同意後停用。10/21、10/22 已用證交所真實價格補跑（note 標【補跑】）。CLI 參數順序是 `指令 <state> <日期> <quotes>`。若這個對話不再可用，要重建排程並先測新對話查得到台股行情。
- 10/20 收盤：淨值 97,733（−2.27%），0050 −0.50%。持有大成鋼、元大金、長榮、儒鴻、潤泰新、中鋼；10/21 開盤的委託是賣元大金 110 股、買宏碁 250 股（限價 32.85、停損 30.9）。
- **10/21 起資金加碼到 50 萬**（`topup` 指令，加入的錢當作之前閒置的現金；App 另外列加碼前報酬），配置改成**核心＋衛星**（核心約 45%：台積電、鴻海、台達電，分批進場；使用者不要 0050）。細節在 `DAILY.md`。
- **資金水位**（10/21 使用者指定）：平常 7 成股票、3 成現金；加權指數距 20 日高點跌 5% 起最多 8 成、10% 起最多 9 成。每日排程用 `cash` 指令記錄判斷，App「資金水位」卡片顯示。
- **每週六 09:50 週檢視**：排程 `trig_015iTBWsQ3HRo3CfsdP7Djom`，綁定對話 `session_01ApWNmMJa7iJ1ivpuuMR7hZ`（新對話排程拿不到台股官方連接器與 repo，所以綁舊對話）；結果寫在 `stock-app/virtual/WEEKLY.md`，只在有數據時調整 `DAILY.md` 規則，大方向改變等使用者決定。
- 規則：買進前要「離 20 日線 5% 內、MACD 或 KD 剛翻多、RSI<70、法人買超」，持股高檔回落（跌破 5 日線＋KD 高檔死叉）就換股；觀察名單：潤泰新、中鋼、友達。目的之一是**比較「剛轉強不追高」和「動能追強勢」哪個好**。

## 8b. 評分研究與影子追蹤（2026-10-22 起，**不要改凍結的設定**）
- **回測拉長到約 2 年**（`stock-backtest.yml`、`tools/backtest.ts`：520 個平日，有下載時間預算 80 分鐘，連線重置時等 10→60 秒重試最多 6 次，單日失敗先用已下載的連續天數、進度存快取下次接著）。每天 16:40 自動跑（**10/28 16:40 的定時工作被 GitHub 漏掉**，預設分支的 `stock-backtest-daily.yml` 改成 16:40／17:10／17:40／18:40 四個 cron，每次先查「今天 16:30 之後有沒有成功的回測」，有就跳過，所以正常只跑一次；手動 dispatch 可勾 `force` 強制跑。已實測跳過邏輯）（10/27 使用者要求從 18:40 提早；當天三大法人若還沒公布，隔天重算會補正，因為空結果不快取）；推送改到 `src/engine/**`、`src/data/**`、`tools/backtest.ts` 也會觸發，約 10 分鐘（有快取）。
- 回測順便輸出兩個研究檔到 Releases `stock-radar-data`：`factors.json`（`src/engine/factors.ts`，各因子對之後 5／20 日報酬的 IC、五等分、大盤漲跌與前後半）與 `scorecompare.json`（`src/engine/scoreCompare.ts`，5 組評分權重對照＋影子追蹤）。**只是研究，不影響 App 的評分**（`score.ts` 的 `DEFAULT_WEIGHTS` 沒動；`scoreStocks` 多了可選的權重參數）。
- **2 年因子分析結論（4/14 的 9 個月結論「近 3 月漲幅反向」拉長後消失，是單一行情的巧合）**：穩定的只有「成交金額大」（20 日 IC +0.068，t 3.0）、「外資連買／外資買超佔比」微弱正向、「投信買超」穩定反向；動能、族群沒預測力；現有總分 IC≈0，大盤下跌日失效。**這 1.7 年偏多、含大型股領漲，流動性其實是大型股效應，行情轉向可能反轉。**
- 新舊評分對照（20 日，後半期）：現有 IC +0.002；A 去投信 +0.006（不如現有）；B 去投信＋流動性 15 +0.024；**C 動能20 籌碼40（外資佔比70＋連買30、無投信）族群15 流動性25 +0.043**；D 只看外資＋流動性 +0.059（但買入檔數 43→62）。依事先標準（後半期 IC 與前 5% 都優於現有等）**沒有任何一組通過**，使用者決定做樣本外**影子追蹤**。
- **影子追蹤（`SHADOW_START=20261015`、`SHADOW_KEY="C"`，單元測試鎖死 C 的權重與起始日；要改就等於重新開始，必須先跟使用者說）**：只算 10/15 之後的評等日，20 日報酬成熟的評等日 ≥ 40 天（約 2027 年 1 月中旬）才判定；標準寫在 `scoreCompare.ts` 開頭與 `shadowVerdict`：C 的 IC、前 5%、買入組超額都不輸現有、大盤下跌日（≥10 天）IC 不輸、買入檔數在現有 ±30% 內。`scorecompare.json` 的 `shadow` 欄位有進度、`liqSpread`（成交金額最大減最小五分之一的報酬差，轉負＝大型股效應反轉的警訊）與最新兩份買入名單。**每週六 09:50 週檢視排程已加入讀取並回報（10/22 使用者同意）；通過或未通過時要明確寫「需要你決定」，不要自己換 App 評分。**
- **已決定（10/22 使用者指定）**：①自組 ETF 候選池加「成交金額 ≥ 全市場中位數（約 3 億）」（`pickCandidates` 的 `liquidityCut`，已發布 1.0.108）；②**虛擬 ETF 衛星新買進改成「外資連買 ≥3 天＋成交金額 ≥ 3 億」，取代「剛轉強」**（改的是 `stock-app/virtual/DAILY.md`，排程本身沒動；理由：2 年回測「剛轉強」20 日平均 +2.3% < 全部 +2.7%，贏過中位數 51%）。舊衛星持股不強賣；10/22 起新買進的 `reason` 要寫「外資連買 N 天、成交金額 X 億」，週檢視用來和舊規則的持股分開比較。
- 「買入」說明（`freeReport.ts`）已依 2 年回測更正：買入組 20 日平均只比全部略好（+3.7% vs +2.7%，贏過中位數 52%）。

## 8c. 數據頁台指期（2026-10-22）
- 期交所 MIS（`https://mis.taifex.com.tw/futures/api/getQuoteList`，**POST JSON**，`MarketType` 0 = 日盤、1 = 夜盤，`CID: "TXF"`）。解析在 `src/data/taifexLive.ts`，取清單裡第一個 `TXF[A-L]\d-[FM]`（近月）；夜盤收盤後到隔天開盤前仍回傳昨晚資料；日盤開盤前沒有成交價就不顯示。`src/lib/net.ts` 的 `postJson`（手機走 `CapacitorHttp.post`，開發走 Vite proxy）。單元測試用真實回應。
- 這個雲端環境連不到期交所；要看真實回應就在 `stock-app/tools/probe/` 放探測腳本並推送（只動 probe 不會觸發 App CI，約 1 分鐘出結果）。

## 8d. 2026-10-22～23 這個對話做的事（新接手先看）
**⚠️ 最重要：兩個排程綁在上一個對話 `session_01ApWNmMJa7iJ1ivpuuMR7hZ`**（每日虛擬 ETF `trig_01P8toMCwxC8oqAhFiSS27tp`、週六檢視 `trig_015iTBWsQ3HRo3CfsdP7Djom`）。使用者換聊天室後，排程仍會喚醒舊對話；舊對話在就會照常執行，不在就會失敗（10/21 就是這樣漏跑一天）。`update_trigger` **不能改綁定的對話**，要換就得「建新排程＋停用舊的」（改排程前要使用者同意），而且新對話**必須先實測拿得到「台股官方」MCP（呼叫一次 `get_stock_daily_trading`）與 repo**，不行就維持綁舊對話。每日提示詞已寫明 CLI 參數順序：`指令 <state> <日期> <quotes>`（`fill/close/cash/note/order` 都是 state 在前）。

**已發布的功能（都有 e2e）**
- 持股頁：美股台幣損益（NT$）、美金損益加 $、台股／美股現價改標「盤中／收盤」（盤前盤後另一行，皆不顯示時間）、每檔加「股數・均價」、上方兩張市值卡的損益標「總損益」。
- 個股／ETF 詳情頁：大字現價（ETF 加即時折溢價，來源證交所 `all_etf.txt` 預估淨值）、**K 線圖**（5/20/60 日線、成交量、KD/MACD/RSI 切換、拖曳／兩指縮放／點選看當天；`src/ui/candles.tsx`，指標在 `src/engine/indicators.ts`）、**法人分頁**（一個月三大法人買賣超柱狀圖＋逐日表，`src/ui/flows.tsx`、`src/engine/flowSeries.ts`，資料同選股用的 `tw2:f:*` 快取，今天資料公布後每 2 分鐘重試最多 15 次）。美股沒有法人分頁（美股沒有外資買賣超；替代資料見 §9）。
- 數據頁：台指期日夜盤與**基差**（期貨−現貨）、大盤成交金額（官方 FMTQIK，不是行情加總）。
- 自組／虛擬 ETF：「報酬走勢」改成一句話結論＋0% 本金線＋最大回檔／贏過 0050 天數／最好最差一天＋逐日表（`src/engine/navStats.ts`）；候選池加成交金額門檻；買進不在選股「買入」清單的標「非選股清單」（只警告）。
- **整個 App 檢修（10/22，4 位唯讀審查員＋我逐項確認，修 24 項）**：虛擬 ETF 賣光清停損價、ETF 證交稅 0.1%（`aiEtf.ts` `TAX_ETF`）、成交價四捨五入一致、本月日 K 收盤後重抓、櫃買空結果不記休市、公司清單兩邊都有才存、IndexedDB abort 不卡死、init 失敗仍可用、AI 失敗也記費用、回覆截斷加警語、parsePlan 只認買賣、重新建議失敗保留舊建議、移除美股寫回存檔、照片匯入成本可打小數且驗證、美股切換篩選、詳情持股損益用即時價、美股成交量單位、警告改琥珀色（綠色＝跌，不能當警告）、K 線 pointercancel／resize、法人輪詢上限、Markdown 小數、餘額驗證。**沒修且判斷不用修**：照片辨識失敗不記費用、AI 多文字段落串接不換行（citations 會把同一句切成多段，加換行反而壞）。
- **Android 自動備份已關閉**（`AndroidManifest.xml` `allowBackup="false"`，單元測試鎖住）：API 金鑰與持股不會備份到雲端；換手機要重新輸入、持股用「拍照／截圖匯入」。

**虛擬 ETF 現況（10/22 收盤，以檔案為準）**：10/21、10/22 當天排程沒跑成功，已用證交所真實價格補跑（note 標【補跑】）。淨值約 492,028（−1.59%），0050 對照 −1.05%；股票 62%／目標 80%（大盤距 20 日高點 −7.6%）。核心（台積電、鴻海、台達電）已買 2/3，剩 1/3 依計畫等 KD 黃金交叉或 10/24 收盤後再補；衛星新買進要「外資連買 ≥3 天＋成交金額 ≥ 3 億」，目前沒有符合的。

**CI 常見假失敗（今天遇過）**：e2e 卡在「下載中：三大法人」（RESULTS 只有「找到模擬器」）＝證交所對 GitHub 機器暫時不回應；模擬器開機失敗（adb offline、WebView segfault）。處理：用 `mcp__github__actions_run_trigger` `rerun_failed_jobs` **重跑一次**，連續失敗再問使用者要不要把 `net.ts` 單次逾時（90 秒×3 次）縮短。**不要手動 dispatch**。讀 CI 紀錄時日誌極大：存成檔案後用 Python 去掉 base64 再找 `RESULTS [`；每次改完要「一次推送」，推送會取消前一個還在跑的 CI。
**省算力**：使用者用量已超過 50%，「一個主題一個對話」；每次回合都重讀歷史，不要為小事多開回合；CI 檢查用 `send_later` 排一次，不要輪詢。

## 8e. 穩健選股研究與「N5 觀察組合」（2026-10-23，Opus 評估＋回測）

- **研究結論（2 年回測，368 個交易日，含手續費與證交稅，隔天收盤成交；全在 `src/engine/steady.ts`，結果在 Release `stock-radar-data` 的 `steady.json`）**：沒有任何不加槓桿的選股法贏過只抱 0050（年化 +90.8%、最大回檔 −18.6%）。第一版「穩健」（斜率×R²）選到暴漲小型股，年化 +14%、回檔 −36%，**不要用**。
- **方案 A**（`aPicks`）：成交金額 ≥ 3 億的普通股，近 60 日波動最小的一半 → 站上且上彎 60 日線、年化趨勢 0～100%（排除暴漲股，100% 是看過結果才定的）→ 依「趨勢×R²」取前 10 檔、每產業最多 2 檔、依波動反比配置（單檔 ≤12%）、不停損。單獨年化 +64%、回檔 −9.8%。
- **N5 = 0050 五成＋A 五成**（回測是每 5 個交易日調整；**App 上追蹤的 N5 與權值強化 10/29 起改成每天重新判斷**，`watch.ts` 的 `decide`，改頻率後歷史會從 10/23 起重算，還沒重新回測）：年化 +78.0%、最大回檔 −10.6%、夏普 2.92（0050 為 2.69）。槓桿 00631L 年化 +197% 但回檔 −31%、單日 −13.5%，使用者不要槓桿。追強勢股／ETF 輪動／相對強度都輸 0050。
- **已套用（使用者 10/23 同意「獨立觀察組合、照回測規則原樣」）**：`src/engine/watch.ts` 的 `runWatch` 每天在 Stock Backtest 工作流程（`tools/backtest.ts`）裡**從 `WATCH.start`（20261023）重算整個組合**（不需要保存狀態、不用 Claude、不花額度），輸出和 Claude 虛擬 ETF 同格式的 `n5.json` 到 Release `stock-radar-data`；App「自組ETF → N5 觀察」分頁（`VirtualView kind="watch"`，`store.refreshWatch`）顯示。選股當天收盤後決定、下一個交易日收盤價成交，虛擬 50 萬。**Claude 虛擬 ETF 與它的每日排程完全沒動**，兩個可以互相比較。
- 開始日 10/23 當天的資料收盤後才有，所以 10/23 晚上第一次排程跑完 `n5.json` 還是空的（asOf 空）、有 10/23 的選股說明；10/26（週一）收盤才會有第一批成交。回測資料每天由 `stock-backtest-daily.yml`（預設分支）觸發。
- 觀察重點：和 0050 的差距、最大回檔是否真的小；樣本只有 1.5 年且是多頭，要持續觀察幾個月再決定要不要真的用。若失敗：看 Actions 日誌的「N5 觀察組合」那行（有失敗會印出但不影響回測）。

- **第二個觀察組合「全個股」（10/23 使用者指定：不放 0050、不限檔數、每天局部修正）**：`runWatch(..., { mode: "wide" })`＋`steady.ts` 的 `wideTargets`，輸出 `wide.json`（Release `stock-radar-data`），App「自組ETF → 全個股」分頁。條件同 A 再加 R² ≥ 0.6，通過的全部持有（依波動反比、單檔 ≤ max(5%, 1.5/檔數)、單產業 ≤ 25%），已持有者用寬鬆條件才賣（波動前 2/3、趨勢 ≤150%），與目標差距 < 0.5% 淨值不動。**回測（2 年）：每天修正 W1 年化 +23.0%、回檔 −8.8%、夏普 1.67、平均 12 檔、持股 71%；每週修正 W2 年化 +27.2%、回檔 −7.3%、夏普 2.01。都遠輸 A（+64%）與 N5（+78%）**：不限檔數其實沒讓檔數變多（條件才是限制，約 12 檔），R² 門檻與每天換股拖累報酬。App 上線的是每天版（使用者指定），要改成每週版或拿掉 R² 門檻需先問使用者。
- **第三個觀察組合「攻守輪動 R1」（10/23 使用者授權「你決定規則」）**：`runWatch(..., { mode: "regime" })`＋`steady.ts` 的 `regimeStep`/`REGIME`，輸出 `regime.json`，App「自組ETF → 攻守輪動」。每 5 個交易日看 0050 與 60 日線（±2% 緩衝）：進攻 0050 七成＋A 三成；防守 0050 四成＋A 四成、其餘現金。**2 年回測：年化 +77.2%、回檔 −13.7%、夏普 2.77、換手 9.5 倍——幾乎等於「0050 七成＋A 三成」（+83.3%／−13.7%／2.89），防守切換沒有帶來額外好處**（這段多頭，0050 很少跌破 60 日線）。上線是為了在空頭時觀察，現階段它和 C 沒有實質差別。
- **「總評比」分頁（10/23，App 1.0.140）**：`src/engine/compare.ts` 的 `compareGroups` 把 Claude 虛擬（第一組）與 N5／全個股／攻守輪動並排（各自全期間＋同期＋規則 2 年回測，回測數字讀 Release 的 `steady.json`，對應鍵 N5_half0050_A／W1_wideDaily／R1_regime／0050）。Claude 虛擬沒有固定規則所以沒有回測。三個規則組合要到 10/26 收盤才有淨值。
- **證交所節流（10/27 修）**：`src/lib/net.ts` 的 `www.twse.com.tw` 間隔 3 秒，而且每次重試都要重新節流。之前 2 秒、重試不節流，連假後（往回找交易日會連打好幾個休市日）會被證交所封鎖，App 卡在「下載中：三大法人 0%」，e2e 也因此一天失敗 3 次。
- **ETF排行分頁（10/27，使用者要求）**：底部第 6 個分頁（設定移到第 7 個，e2e 的 nth-child 已跟著改）。內容是**個股被 ETF 買賣超**的排名（使用者更正過：不是 ETF 本身被法人買賣），兩種來源切換：
  - **主動式 ETF（預設）**：`tools/activeEtf.ts` 每天抓 MoneyDJ「個別ETF-全部持股」頁（`https://www.moneydj.com/ETF/X/Basic/Basic0007B.xdjhtm?etfid=00981A.TW`，電腦版 UA 才有完整持股與股數；手機版只有前 10 大），代號清單＝程式內 SEED＋證交所／櫃買 openapi 收盤行情裡 `00xxxA` 的代號；只算 4 碼台股（期貨、國外股票不算）。歷史持股存在 Releases `stock-radar-data` 的 `active-etf-hist.json`（每檔 ETF 最近 12 份），每次下載→加上最新一份→傳回去；`src/lib/activeEtf.ts` 把同一檔 ETF 相鄰兩份持股的股數差算在後一份的日期，輸出 `active-etf.json`（App 下載，`refreshActiveEtf`）。排程：`.github/workflows/stock-active-etf.yml` 是可重用 workflow，由 `stock-backtest.yml` 的 `active-etf` job 在每天 16:40 dispatch 時呼叫（不用改預設分支）；改 `tools/activeEtf.ts`／`src/lib/activeEtf.ts` 推送時也會單獨跑一次（放 `src/lib` 是為了不觸發 100 分鐘的回測）。10/27 第一次跑抓到 31 檔（資料日 10/21～10/22），只有一份所以 App 顯示「資料累積中」；之後每天多一份就有買賣超。**App 端即時補抓**（使用者 10/27 要求「不用等」）：`active-etf.json` 帶 `latest`（各 ETF 最新一份持股），打開 ETF排行 時 `refreshActiveLive()` 用 `fetchText`（CapacitorHttp、電腦版 UA，MoneyDJ 節流 400ms）抓 31 頁，`mergeLive()` 把比 latest 新的持股算成新的一天（同一天 GitHub 已算過的 ETF 不重算），10 分鐘內不重複；畫面顯示「已檢查最新持股（時間，取得 N 檔）」與「重新檢查」。**舊資料無法回補**：MoneyDJ 只有最新一份、不能指定日期；免費歷史只有 GitHub 個人專案 sarsadsl/etf_scratch 封存 7 檔（使用者選不補）；31 檔完整歷史只有付費的 ETFedge。口袋證券（CMoney）的內部 API 有試探但被安全規則擋下（不要再試）。注意：各 ETF 持股更新時間不一（有的晚一天），16:40 抓到的多半是前一天（當天的靠 App 打開時自己補抓）；漏抓一天時，差額會併到下一份的日期。
  - **投信全部**：官方沒有「ETF 買賣個股」資料時使用者先選的替代方案——證交所 T86＋櫃買的投信買賣超（含被動 ETF 與一般基金）。`src/engine/etfRank.ts` 的 `flowRank` 依買賣超**金額**（股數×收盤）排前 20，固定 `trust`、只用個股 `tw.scored`；`buildTwInputs` 多存 `flow1`／`flow5`，`TW_SNAPSHOT_VERSION` 升到 3；`MarketState.flowDate` 是法人資料日。
- **發布改用 release APK（10/27，使用者選 A）**：10/27 使用者手機更新時 Google Play 安全防護顯示「已封鎖有害的應用程式」。原因 Google 不公開，推測是側載＋App 自己下載安裝更新（REQUEST_INSTALL_PACKAGES）＋debug（可除錯）版本。現在 `stock-app.yml` 同時 `assembleDebug assembleRelease`：模擬器 e2e 仍用 debug（Playwright 要連 WebView 除錯），**發布 `app-release.apk`**；release 也用 `stock-radar.keystore` 的 stable 簽章（`build.gradle`），CI 新增步驟檢查 release 不可除錯、且 SHA-256 簽章和 debug 相同（不同就無法覆蓋更新、資料會丟）。release 關掉 lintVital（`lint { checkReleaseBuilds false }`）。未做：B 拿掉 App 內自動安裝、C 向 Google 申訴。被擋時的暫時解法：按「更多詳情」找「仍要安裝」，或暫時關閉 Play 安全防護掃描。
- **K 線圖盤中即時（10/27，使用者要求）**：`src/engine/liveBar.ts` 的 `withLiveBar` 用證交所 mis 即時報價（`twLive.ts` 新增 `volume`＝v 張×1000）拼今天暫時的一根（`live: true`），只在日 K 還沒有今天那根時加；詳情頁 `shownBars` 只給 K 線圖用（法人分頁仍用正式日 K），圖下 `kbar-live` 說明；美股也拼（10/27 加：CNBC 日期是紐約交易日，和日 K 一致；同一天且盤中就用即時價取代下載當時那根，已收盤保留正式的）。10/27 09:26 實盤驗證：大成鋼開 51.00 高 51.30 低 50.50 與證交所一致、量 2,619 張（09:34 證交所 2,897 張）。台股盤中**成交金額**仍沒有免費來源，數據頁維持收盤官方數字。`candles.tsx` 改成檔數不變時保留畫面與點選、多一根時原本在最右邊才跟著移。e2e：有盤中 K 棒時檢查標示「盤中」。
- **「AI 供應鏈」（10/26，使用者：「先做 AI 相關股回測，能超過 0050 有明顯趨勢就新增一組」）**：`steady.ts` 的 `AI_GROUPS`（7 類 51 檔，代號名稱已用證交所即時報價逐檔核對）、`aiTargets`；回測鍵 AI1_equal／**AI2_cap（上線版）**／AI3_capTrend／AI4_top20，對照 E1_elecCap／E2_elecEqual（電子相關產業）。**回測前先訂標準（AI2 全部達成才新增）**：①年化高於 0050 ②前、後半段都高於 0050 ③≥11/19 個月贏 0050 ④最大回檔不比 0050 差超過 5 個百分點 ⑤贏過電子股對照 E1。結果（2025/4/24～2026/10/22）：AI2 +118.2%／回檔 −19.0%／夏普 2.65／11/19 月；前半 +142% 後半 +96%（0050 +115%／+64%，年化 +88.1%／−18.6%／2.63）；E1 +103.5%；AI1 等權 +180.9%（回檔 −24.5%，不符④）；AI3 +125.8%／−21.0%／13/19。5 項皆通過，所以新增 `watch.ts` mode "ai"（每 20 個交易日調整，`WATCH.aiEvery`）→ Release `ai.json`，App「自組ETF → AI 供應鏈」與總評比（回測鍵 AI2_cap）。**⚠️ 必須記得的限制**：清單是 2026-10 用今天眼光挑的（有事後諸葛），回測偏樂觀；夏普 2.65 ≈ 0050 2.63，多賺的主要是承擔更高波動（年化波動 31% vs 25%、最差一天 −7.8% vs −5.9%）；台積電碰 35% 上限；AI 族群一起修正時會跌得比 0050 重。要靠 10/27 起的實際觀察，不要當結論。
- **「權值強化」（10/23，使用者：「不要 0050、Claude 設計、往贏 0050 前進」）**：`steady.ts` 的 `LEAD`／`leadTargets`，`watch.ts` mode "lead" → Release `lead.json`，App「自組ETF → 權值強化」與總評比（回測鍵 **Q5_lead**）。規則：市值前 50 檔個股依市值配置（市值＝收盤×實收資本額÷10；公司資料快取鍵改成 `tw:companies2:` 以取得實收資本額，CI 確認 1985/1985 有資料），趨勢（上彎 1／下彎 0.7／破 60 日線 0.3／60、120 都破 0）、外資 20 日買超佔量前 1/3 ×1.3 後 1/3 ×0.8、投信前 1/10 ×0.8、90 日趨勢×R² 前 1/3 ×1.2，**永遠滿倉**（減掉的權重轉給其他股），單檔上限 60%，每 5 日調整、0.5% 內不動。第一版 Q2 把趨勢打折的部分留現金：年化 +71.7%（純市值 Q0 +95.1%、0050 +90.8%），所以改成 Q5。對照組 Q0／Q1（只趨勢留現金）／Q3（前 30）／Q4（不看趨勢）／Q6（Q5 前 30）。2 年回測（4/23/2025～10/22/2026）：**Q5 年化 +99.1%、最大回檔 −16.2%、夏普 2.69、月報酬贏 0050 11/19**；Q0 +95.1%/−15.0%；Q4 +97.7%/−15.9%；Q6 +96.8%/−17.2%；0050 +90.8%/−18.6%。贏的幅度不大且樣本是多頭、規則看過回測才定（Q2→Q5），要靠實際觀察。App 1.0.143 上線；自組ETF 模式按鈕 7 個改為兩列（`.seg.tight`，`gridAutoFlow: row`，e2e 檢查兩列）。

## 9. 待辦與未決（都等使用者決定，不要自己開工）
0. **（最新、使用者剛提的想法，尚未決定要不要做）穩健選股**：使用者不要「核心」（AI 權值股近幾個月回檔頻繁），想從選股分頁的「買入」清單挑，要的是走勢平滑、緩慢往上（不追漲停或單日 7～9%），**一個產業只挑 1 檔最穩的**，擔心族群輪動輪流跌。我的建議與已說明的限制：①「每天穩定漲 1～5%」不現實（買入組 20 日平均 +3.9%≈每天 +0.2%），用「波動小、最大回檔小」衡量穩；②一產業一家只能分散不能消除輪動，要加「只挑目前強的族群、族群轉弱就換」、限制單產業比重、混入與 AI 關聯低的產業、停損照舊；③題材（AI、原物料漲價）App 資料沒有，要由使用者與 Claude 手動維護名單。**下一步是先做最小版 2 年回測對照組**（每週從「買入」股取強勢族群、每族群最穩一檔，持有 20 天，比報酬／波動／最大回檔／同時下跌天數，對照現有買入與大盤），數字好才改虛擬 ETF 與選股頁；使用者擔心額度，我提的做法是「一次寫完、只推一次、只排一次檢查、結果放 Release 資料檔、週六檢視一起看」，**使用者還沒回答要不要做、要用哪一種**。
0b. **美股「外資」**：美股沒有每日外資買賣超；可用的替代都比較慢：機構持股 13F（季報，滯後 45 天）、內部人交易（幾天內）、放空比率（雙週）、選擇權資金流（要付費）。我建議先做「內部人交易」與「機構持股變化」並標資料日期；使用者說暫時不用改。
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

- **即時資料更新間隔 `LIVE_MS` = 30 秒（10/28 使用者一度改 10 秒，實測證交所資料本身約 30～60 秒才更新，使用者又改回 30 秒）**：`store.ts` 的 `LIVE_MS`（10_000）給所有盤中輪詢用（選股清單前 60 檔、詳情頁、持股、數據分頁指數／期貨／成交金額、虛擬 ETF 現價）；`refreshLive`／`refreshUsLive` 加了 `liveBusy`，上一次還沒抓完就略過，避免重疊。證交所 MIS 節流是 1 秒一次，60 檔分 3 批約 3 秒抓完，10 秒夠用；若被證交所擋（回應變慢、一直沒資料），先把 `LIVE_MS` 調回 15～30 秒。
- **證交所 MIS 即時資料更新很慢（10/28 實測）**：在 GitHub 主機盤中連打 `getStockInfo.jsp`（每 5 秒一次、有無 `_=` 參數都試），回傳的 `t`／`z`／`v` 會連續約 1 分鐘不變，然後才一次更新（例：12:04:00 的快照維持到約 12:05:20，才換成 12:04:34／12:05:14）；`z` 常是 `-`（那一刻沒成交，App 改用最佳買價）。所以更新間隔再短也只是「多問幾次」，畫面實際大約 30～60 秒才會變一次，來源本身的限制，App 快不了。使用者 10/28 看 ETF排行覺得「沒在跳動」是因為那頁原本沒接即時價（只有收盤價），已改成盤中顯示即時價。
- **選股 ETF 分頁依成交量排序（10/28 使用者指定）**：`StockInput.volume`（成交股數，來自 `QRow[5]`）→ `Scored.volume`，`TW_SNAPSHOT_VERSION` 升到 4；`screens.tsx` 的清單在 `market === "ETF"` 時依 `volume` 由大到小，每列顯示「量 N 張」。刻意用最近一個交易日的固定量（不用盤中即時量），盤中排序才不會一直重排。台股個股、美股仍依分數。
- **ETF排行點進個股（10/28 使用者要求）**：主動式 ETF 來源下，點列表某檔開 `WhoSheet`（`etfRank.tsx`）：`etfBreakdown(data, code, days)`（`src/lib/activeEtf.ts`）算每檔 ETF 的增減、持有前後（`data.latest` 的最新持股 − 期間增減＝之前）、每天明細；寫出「加碼／減碼／新增／清倉」。右上角「個股詳情」才開原本的個股頁。「投信全部」沒有逐檔資料，點了仍直接開個股詳情。
- **標題特效（10/28 使用者選定 A 流光金）**：`app.tsx` 標題改 `<span class="brand-fx" data-testid="brand">金雷達</span>`，`styles.css` 的 `.brand-fx` 用金色漸層 `background-clip:text` 加 `brand-flow` 動畫（深色加光暈、淺色用較深金、reduced-motion 停止）。範例頁在 claude.ai artifact（5 種特效 A～E）。
- **主動式 ETF 詳情頁買賣成份（10/28）**：`ui/etfHoldings.tsx` 的 `EtfHoldingsPanel`（`screens.tsx` StockDetail 對 `00xxxA` 顯示），資料用 `lib/activeEtf.ts` `etfHoldings(data, etf, days)`：買賣 = 該 ETF 在 `days[].flows` 的增減、持股 = `latest[etf].shares`；只有一份持股時沒有買賣、只列持股。
- **準時觸發規則組合更新（10/29 使用者同意）**：GitHub 定時工作被拖延數小時（10/28 排 16:40 實際 23:27 才跑，10/29 當天沒有定時那次），所以每日虛擬 ETF 排程（`trig_01P8toMCwxC8oqAhFiSS27tp`，16:40）推送後多一步：用 github 工具 `run_workflow` 觸發 `stock-backtest-daily.yml`（預設分支，有「今天已成功就跳過」的檢查）。GitHub 的定時工作保留當備援。見 `virtual/DAILY.md` 步驟 7b。
- **調整時程標示（10/29）**：`runWatch` 輸出 `plan`（`every`／`lastDecision`／`band`），`aiEtf.tsx` 的 `SchedulePlanView` 每個組合都顯示調整頻率、最近與下次判斷日（平日推算，國定假日會順延）、成交日與原則；Claude 虛擬操作標「不固定」。
- **雷達圖示（10/28 使用者選定 B3）**：標題雷達改金色圓環＋38 片漸淡扇形殘影（約半圈，4.5 秒一圈）＋4 個紅色目標點（掃到才亮），由 `app.tsx` 的 `RADAR_FAN`／`RADAR_BLIPS` 產生，樣式在 `styles.css` `.radar-logo`（淺色模式用深金、reduced-motion 停止）。啟動畫面（`index.html` 的 `#boot-radar`）、Android 12 系統啟動畫面（`res/drawable/radar_icon.xml`、`values-v31/styles.xml`）也一併改金色＋暖黑背景；Android 11 以下的 `splash.png` 與桌面圖示（`mipmap-*/ic_launcher*.png`）10/28 也已改金色，由 scratchpad 的產圖腳本畫（金色 B3 靜態版、底色 #120D04）。

## 虛擬ETF 共通區塊（1.0.178）
- 所有虛擬ETF組合（Claude/N5/全個股/攻守輪動/權值強化/AI供應鏈）都顯示：資金水位（`CashReserve`，規則組合另顯示明天調整後目標 `plan.nextStock`）、每日損益 vs 0050（`DailyCompare`）、明天要調整的股票（`pending`，規則組合由 `runWatch` 以最後資料日目標權重 vs 現有持股產生，帶日期註記）。
- UI 在 `src/ui/aiEtf.tsx`；e2e 檢查 testid：`cash-reserve`、`daily-today`、`daily-table`、`virtual-pending`。舊 JSON 沒有 pending/plan 時 UI 要容忍。

## 興櫃股票（1.0.186）
- 證交所 MIS 查不到興櫃。盤中價用櫃買中心「興櫃當日行情表」`https://www.tpex.org.tw/www/zh-tw/emerging/latest?response=json`（每分鐘更新、一次全部；欄位 0 代號 2 前日均價 7 高 8 低 9 日均價 10 成交 13 成交量(股)），程式在 `src/data/esb.ts`、`store.ts refreshLive`。
- 歷史行情 `…/emerging/historical?code=7861&date=2026/09/01&id=&response=json`：**日期一定要給完整日（年/月/日），只給年月會一律回傳當月**；只有最高、最低、均價、成交量，沒有開收盤，K 線用「前日均價為開、當日均價為收」。
- UI：持股列表點興櫃個股 → `EsbDetail`（screens.tsx）。e2e 檢查在持股段（testid `esb-*`）。

## K 線載入（1.0.190）
- `twHistory`（src/data/history.ts）改為分段：手機裡有的月份先讀出來馬上回報（onPartial），缺的由最近月份往回下載、每月回報一次；更早月份失敗不丟掉已有資料。
- 背景預載 `runHistoryPrefetch`（store.ts）：applyTw 後 30 秒，持股＋評分最高 10 檔買入，6 個月；前景下載時會讓路（`foreground` 計數）。快取 key 與前景相同（逐月）。

## 指數走勢（1.0.194）
- 數據頁指數卡片可點（testid `idx-card-<名稱>`）→ `IndexDetail`（screens.tsx）→ `CandleChart noVol`（不畫成交量）。資料層 `src/data/indexHistory.ts`。
- 加權指數：`TAIEX/MI_5MINS_HIST` 每月一份真實開高低收（每月存 kv `idx:t00:YYYYMM`）。櫃買指數：`tpex.org.tw/openapi/v1/tpex_index` 只回當月，每次打開合併存到 kv `idx:o00`，越用越長。
- 臺灣50／半導體／金融保險／電子：官方沒有歷史開高低收。逐日抓 `MI_INDEX?date=YYYYMMDD&type=IND`（每天約 22KB，**含全部指數；電子指數在這裡叫「電子工業類指數」**），存 kv `idx:d:YYYYMMDD`（休市存 `{}`）；K 棒開＝前一天收盤。證交所限速每 3 秒 1 次，70 天第一次要約 3.5 分鐘：兩天一批先出圖、關畫面就停、抓過存手機；載入時用 `beginForeground()`（history.ts）讓背景預載讓路。
- 診斷：e2e 把 `window.__srIdxTrace=[]`，下載過程會記進去，逾時會印出（平常沒有任何作用）。
- **每日累積檔（1.0.201，使用者 10/30 同意改排程）**：`stock-backtest.yml` 每天 18:40 的 `index-hist` job 呼叫 `stock-index-hist.yml` → `tools/indexHist.ts`，把 `index-hist.json`（Releases `stock-radar-data`）補齊後傳回。內容：`ohlc`（加權、櫃買真實開高低收）、`closes`（臺灣50／半導體／金融保險／電子工業類每日收盤）、`seen`（檢查過的日期，休市也算）。第一次要逐日抓約 260 個平日（約 15 分鐘），之後每天 1～2 個請求。App 端 `loadRemote`（indexHistory.ts）6 小時內只下載一次（kv `idx:rem`），只補檔案之後缺的日子。改程式的推送（路徑符合 stock-index-hist.yml）也會跑一次。
- 美股指數日 K：CNBC bars `https://ts-api.cnbc.com/harmony/app/bars/<代號>/1D/<起>/<迄>/adjusted/EXTENDED.json`（代號同 MACRO_SYMBOLS：.SPX .IXIC .SOX .DJI .VIX），手機直接抓，一次約 1 年；kv `idx:us:<代號>` 先畫再更新。數據頁卡片 testid `idx-card-.SPX`。

## 配息入帳（2026-10-30，為 ETF 組做準備）
- 引擎新增**選用**的配息：`AiEtf.dividends`／`benchDividends`（aiEtf.ts），`recordDividend`（virtualEtf.ts），指令 `dividend <state> <除息日> <代號> <每股配息>`。沒有這兩個欄位的組合，`valuate` 算出來和以前一模一樣（有單元測試固定）。
- 規則：除息日**前一天收盤**持有的股數 × 每股配息，現金入帳；除息日當天才買的不算，除息日開盤賣掉的仍算。0050 另外記進對照組（不管有沒有持有），讓「同樣的錢買 0050」也有配息。不扣二代健保補充保費（單筆 ≥ 2 萬元 2.11%），所以是稅前、略高估。
- **每日排程（DAILY.md）還沒要求記配息**，現有的 Claude 虛擬操作組、規則組合都沒有記，所以它們目前仍是只看價格（高股息成分會被低估）。要不要補，等使用者決定。

## ETF 組合回測（2026-10-30，規則式框架）
- 引擎 `src/engine/etfBacktest.ts`（純計算＋測試），資料與輸出 `tools/etfBacktest.ts`，工作流程 `stock-etf-backtest.yml`（不排程；推送或手動執行；結果 `etf-backtest.json` 發布到 Releases `stock-radar-data`）。
- 資料：Yahoo 日線（5 年）含配息與分割，上市 `.TW`、上櫃 `.TWO`。候選名單與「重疊群組」寫在 `ETF_UNIVERSE`（用 2026/09 前十大持股人工分群，**不是逐期實際重疊**）。海外型、槓桿、反向、期貨型不納入。
- 規則：每週五收盤判斷、隔天開盤成交；0050 在 60 日線之上 → 股票型 80%／公司債 20%，之下 → 股票型 50%／公司債 30%＋長債 20%；股票型挑動能／波動排名前 3（同群組 1 檔、同類型 ≤ 2、大盤型 1 檔、主動式單檔 ≤ 20%、單檔 ≤ 40%）；已持有且排名還在前 5 就留著。規模門檻用「近 60 日平均成交金額 ≥ 5000 萬」代替（沒有歷史規模資料）。
- 成功標準（使用者 10/30 同意）：1 含息報酬 ≥ 固定比例組合（60% 0050＋20% 00878＋20% 00720B，每季平衡）；2 最大回檔比 0050 小 20% 以上；3 0050 回落 ≥ 5% 的區間表現比 0050 好；4 年化調整成本 ≤ 1% 且平均每次 ≤ 2 筆買賣；5 配置沒有失控。
- 這測的是「框架合不合理」，不是 Claude 逐週判斷的功力；虛擬操作開始後才看得到後者。
- **V1 每月判斷（使用者 10/30 同意，版本事先寫死、只跑一次）**：每月最後一個交易日收盤判斷、隔天開盤成交，每 3 次判斷（一季）強制重新平衡；其餘規則、名單、成本、成功標準與 V0（每週，結果檔 `etf-backtest.json`）完全相同。V1 結果檔 `etf-backtest-monthly.json`（工作流程現在跑 V1；要再跑 V0 用 `node .eb-build/etfBacktest.js <檔> week`）。

## 目前進度與待辦（2026-10-30 晚，換新對話時從這裡接）
**已完成並發布（1.0.201）**：數據頁指數可點進去看日 K（台股指數＋美股 S&P／那斯達克／費半／道瓊／VIX）；每日排程 18:40 順便累積台股指數歷史（`index-hist.json`）。
**已完成、未改 App**：虛擬 ETF 引擎的選用配息入帳（`recordDividend`、指令 `dividend`）；ETF 組合回測（V0 每週 `etf-backtest.json`、V1 每月 `etf-backtest-monthly.json`，都在 Releases `stock-radar-data`）。

**待辦／未決（都等使用者決定，不要自己開工）**
1. **ETF 組合（全 ETF、不分類、Claude 選配）要不要開成第七組**：回測結果 5 條標準只達成 3 條（回檔、下跌段、配置沒失控），未達成：報酬輸固定比例組合（V1 +132.8% vs +181.4%）、調整成本（V1 年化 1.42%、平均每次 4.43 筆，標準 4 的「每次 ≤ 2 筆」可能訂得不合理）。我的建議是不開；備選：事先寫好規則的 V2（只在入選名單改變才換）、或不靠回測直接開一組由 Claude 每月判斷的虛擬組觀察。**不要自己再調參數重跑**（使用者要求每個版本只跑一次）。
2. **App 完整測試（Stock App）最近在晚上連續失敗**：run #203（提交 6d9abfd）4 次：停在「自組ETF」前、模擬器啟動卡住、兩次「興櫃詳情的前日均價／高低／成交量沒顯示」；run #204（提交 fe9318a）首頁台股資料 8 分鐘沒載入。這些提交都沒改 App。櫃買興櫃行情表晚上 8 點資料正常（探測確認），原因未確認，懷疑晚上連續跑很多次被證交所暫時擋。已排定 10/31 台北 09:30 重跑 run #204 一次（綁在舊對話裡，見下）；通過就沒事，再失敗才需要查 `EsbDetail` 與 `refreshLive` 的興櫃流程。線上版本仍是 1.0.201。
3. **每日排程（DAILY.md）還沒要求記配息**：現有 Claude 虛擬操作組與規則組合仍只看價格（高股息成分被低估）。要不要補，等使用者決定。
4. **10/30 16:40 排程觸發的 Stock Backtest Daily**：只確認 GitHub 回應「已排入佇列」，沒有確認它有沒有跑完、五組規則組合有沒有更新。

**排程綁定注意（換新對話前要處理）**
- `trig_01P8toMCwxC8oqAhFiSS27tp`「Claude 虛擬自組ETF 每日操作（綁定本對話）」：每個交易日 16:40，**會叫醒舊對話**，不是新對話。
- `trig_01ABAFSRzsGufiRFdEkuNRZQ`：10/31 01:30 UTC 的一次性提醒（重跑 App 測試），同樣叫醒舊對話。
- 改綁定要使用者同意：可改成「每次觸發開新對話」（`create_new_session_on_fire`）或綁到新對話；舊對話很長，每天叫醒它會多花額度。
