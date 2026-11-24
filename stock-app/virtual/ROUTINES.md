# 排程總表與轉移程序（2026-11-19 盤點、11/25 更新；新對話接手時第一份要讀、要照做的）

> **11/25 已轉移（對話「接收金雷達」`session_01JrEEmaPZT7sMSm276njmzN`）**：新每日 `trig_01RJT1FieteRvuw8i22jQHQC`、新每週 `trig_015gHFMUth4MzpFVHA92rzuk`，皆啟用、綁新對話；舊的 `trig_01Vw5Wq5B5YnS863Ho2nx4ip`、`trig_011RBJFtAWwRWm5CtJHCpjpi`（綁 `session_01JrEEmaZvY5uHpZ3UCVJ3ip`）已停用。下次換對話要停用的是**新的這兩個**。下表的 id 已更新。

> **11/25：本對話（…Ip，「金雷達工作交接-1117」）上下文已滿，使用者要換新對話。** 新對話照 §D 轉移：要停用的舊 id 現在是 **`trig_01Vw5Wq5B5YnS863Ho2nx4ip`（每日）與 `trig_011RBJFtAWwRWm5CtJHCpjpi`（每週）**（§D 第 3、4 點寫的 `trig_01N2F…`／`trig_011Nd…` 是 11/19 前的舊 id，已停用）。本對話留下的一次性提醒（send_later，名稱「檢查…打包」）都只是檢查 CI，可以不理或停用。

> 這份**不含任何持股、成本、損益**（repo 公開）。排程的「定義」都寫在這裡：換對話時可以**原樣重建**，不需要翻舊對話。
> 工具：`mcp__claude-code-remote__list_triggers／create_trigger／update_trigger／delete_trigger／fire_trigger／send_later`（要先 ToolSearch 載入）；GitHub 工具 `mcp__github__actions_list／actions_run_trigger／get_job_logs`。

## A. 一眼看完（2026-11-19 狀態）

| # | 排程 | 時間（台北） | 誰在跑 | 綁定對話 | 狀態 |
|---|---|---|---|---|---|
| 1 | **Claude 虛擬自組ETF 每日操作＋雙引擎＋新聞否決** `trig_01RJT1FieteRvuw8i22jQHQC` | 週一～五 16:40 | Claude 排程（叫醒綁定的對話） | `session_01JrEEmaPZT7sMSm276njmzN`（**目前對話，11/19 轉入**） | **啟用中** |
| 2 | **虛擬ETF每週檢視** `trig_015gHFMUth4MzpFVHA92rzuk` | 週六 09:50 | Claude 排程 | 同上 | **啟用中**（下一次 11/21） |
| 3 | 貝爾威勒（興櫃 7861）轉上市進度追蹤 `trig_01MHAM59HPmLsnWaH6vs6zaX` | 週五 18:30 | Claude 排程（不綁對話，Sonnet） | 無 | 啟用中，**不需轉移** |
| 4 | Stock Backtest Daily（GitHub 定時） | 週一～五 16:40／17:10／17:40／18:40 | GitHub Actions（預設分支 `claude/conversation-start-guide-ya0q8x`） | 無 | 啟用中，**不需轉移**（見 §C） |
| — | **已停用（11/19 轉出）**：`trig_01N2FNVWPGY5BLFzHRPR6rkv`（每日）、`trig_011Nd3V6ANET3xfxvEhqtyR2`（每週），原綁舊對話 `session_01JrEEmdeMmbdXWNmHqz45Ep` | — | — | — | `enabled=false`，保留當歷史，不要重新啟用 |
| — | 更早已停用：`trig_01P8toMCwxC8oqAhFiSS27tp`、`trig_015iTBWsQ3HRo3CfsdP7Djom`、`trig_01GKTYGpLeqWRS2Nrv75CoTv` | — | — | — | 同上 |

**11/19 已完成轉移**：使用者要求「舊對話停用、改用最新對話執行全部功能」，已在同一回合建好 #1、#2（綁本對話）並停用舊的兩個；提示詞與舊的逐字相同（已用 `get_trigger` 比對）。舊對話 `session_01JrEEmdeMmbdXWNmHqz45Ep` 不再有任何啟用排程。
**下次換對話**：照 §D 再轉一次（新 id 要更新本表與 HANDOFF.md §7）。
**驗證待辦**：11/20 16:40 之後確認新排程有跑（`list_triggers` 的 `last_run`、`virtual-etf: 20261120 收盤更新` 提交、`dual-veto.json`）；沒跑就 `fire_trigger`。
**風險**：#1 每天更新 `stock-app/virtual/dual-veto.json`（雙引擎＋新聞否決），雙引擎實單的買賣清單會用它。
**未驗證**：綁定的對話被封存或刪除後排程會怎樣；本對話上下文已用掉約 86%，若逼近上限會需要再轉移一次，改用 §D 第 8 點（每次新開對話）可根治。

## B. 本對話（`session_01JrEEmaZvY5uHpZ3UCVJ3ip`，標題「金雷達工作交接-1117」）
- 11/19 起**承接**每日與每週兩個排程（見 §A）；舊對話 `session_01JrEEmdeMmbdXWNmHqz45Ep` 已停用。
- 它做的事與結論都寫在 `HANDOFF.md` §9c、`stock-app/LONGBT.md`、`stock-app/longbt/*`。

## C. GitHub Actions（全部在 `.github/workflows/`；公開 repo，不計費）
- **預設分支是 `claude/conversation-start-guide-ya0q8x`**，GitHub 的 `schedule` 只會從預設分支跑。`main` 分支是 10/21 的舊快照，**不要用**（它的 `stock-backtest-daily.yml` 只排 18:40、指向 main）。
- `stock-backtest-daily.yml`（預設分支）：`cron 40 8、10 9、40 9、40 10 * * 1-5`（UTC，＝台北 16:40、17:10、17:40、18:40）；每次先檢查「今天 16:30 之後」`stock-backtest.yml` 在 App 分支有沒有成功的 run，有就跳過；沒有就 `gh workflow run stock-backtest.yml --ref claude/ui-calculator-interface-t3x9kh`。`workflow_dispatch` 有 `force` 選項。**這是使用者同意的「可以手動觸發」的唯一 workflow**（每日排程 #1 推送後也會用 `mcp__github__actions_run_trigger` 觸發它，`ref claude/conversation-start-guide-ya0q8x`）。
- `stock-backtest.yml`（App 分支）：由上面叫起來，或推送到 `stock-app/src/engine/**`、`stock-app/src/data/**`、`tools/backtest.ts` 時自動跑（約 20 分鐘）。產出發布到 Releases `radar-data-vug13iw701`（`backtest.json`、`n5.json`、`dual.json`、`dualplus.json`、`quad.json`、`scorecompare.json`…）；推薦紀錄寫到 `stock-radar-log` 分支。`workflow_dispatch` 時另外呼叫 `stock-active-etf.yml`、`stock-index-hist.yml`。**不要手動觸發它**（用上面的 daily）。
- `stock-app.yml`（App 分支）：推送到 `stock-app/**`（除 `tools/probe/**`、`virtual/**`）時打包 APK＋模擬器 e2e＋發布到 Releases `radar-app-d43m21s655`（約 20～30 分鐘）。e2e 有一項不穩的檢查，見 `HANDOFF.md` §9c。
- 長期回測三支（11/16～11/17 新增，都用「推送特定檔案觸發」，因為 `workflow_dispatch` 對只存在於非預設分支的 workflow 會 404）：
  - `longbt-fetch.yml`：推送 `stock-app/longbt/RUN`（內容 `LBT_START`、`LBT_BUDGET_MIN`）；續跑用 REST `rerun_workflow_run`；快取 `longbt-cache-*`（約 105MB，**GitHub 快取 7 天沒被存取會清掉**）。
  - `longbt-run.yml`：推送 **`stock-app/tools/probe/longbt-run.env`**（放在 `tools/probe/` 才不會觸發 App 打包）。`LBT_OPEN_B=1` 才開封（B 已在 11/17 開過一次，**不得再開**）。
  - `longbt-probe.yml`：一次性可行性探測，已完成。
- `main.yml`（計算機／小畫家 Windows 打包）、`stock-probe.yml`、`stock-etf-backtest.yml`：只在推送相關檔案時跑，與排程無關。
- **推送坑**：GitHub 的 path 篩選是看「整個推送範圍的所有提交」，不是只看最後一個；中間提交加 `[skip ci]` 沒用，只要最後一個提交沒有且整個範圍含 `stock-app/src` 就會觸發 App 打包與回測。要觸發 longbt 時，先把程式碼推完，**之後再單獨推 env 檔**。

## D. 換對話時的排程轉移程序（新對話第一輪就做，使用者已同意「完整轉移、舊對話停用」）
1. ToolSearch 載入：`select:mcp__claude-code-remote__list_triggers,mcp__claude-code-remote__create_trigger,mcp__claude-code-remote__update_trigger,mcp__claude-code-remote__get_session`。
2. `list_triggers`（limit 100）：確認 #1、#2 還在、`enabled=true`、`persistent_session_id` 是舊對話；`get_session`（不帶參數）取得**自己的** session id。
3. **每日排程（#1）**：`create_trigger`（`initiation: "human_request"`，預設綁定本對話）：
   - `name`：「Claude 虛擬自組ETF 每日操作（綁定本對話 M/D 換）」
   - `cron_expression`：`CRON_TZ=Asia/Taipei 40 16 * * 1-5`
   - `prompt`：下面 §E-1 的**整段原文**
   建好立刻在同一回合 `update_trigger`（`trigger_id: trig_01N2FNVWPGY5BLFzHRPR6rkv`，`enabled: false`）。
4. **每週檢視（#2）**：同上，`cron_expression`：`CRON_TZ=Asia/Taipei 50 9 * * 6`，`prompt` 用 §E-2；舊的 `trig_011Nd3V6ANET3xfxvEhqtyR2` 設 `enabled: false`。
5. `list_triggers` 再看一次：新兩個 `enabled=true`、舊兩個 `enabled=false`、沒有重複啟用；把新 id 記進 `HANDOFF.md` §9c 與本檔 §A（改表格）；不要刪舊的（保留執行歷史，方便回復）。
6. 當天 16:40 後確認新每日排程有跑（`last_run`、`stock-app/virtual/v-2wy3g7efad1c.json` 有當日提交 `virtual-etf: D 收盤更新`、`dual-veto.json` 是否更新）。沒跑就用 `fire_trigger` 手動補一次。
7. **不要**同時留兩份啟用（會重複操作、重複推送、重複通知）；也**不要**在建好新的之前先停舊的（會有空窗）。
8. 另一個選擇（需要使用者同意才做）：建成 `create_new_session_on_fire: true`（每次新開對話、不綁任何對話），之後換對話就不必再轉移；代價是每次從零開始、不能累積上下文（提示詞已寫成自給自足，會自己讀 `DAILY.md`）。

## E. 完整提示詞原文（建立新排程時整段複製；不含任何持股）

### E-1 每日操作（週一～五 16:40）
```
【排程：虛擬自組ETF 每日操作】現在是台股收盤後（台北約 16:40）。請照 stock-app/virtual/DAILY.md 的步驟完成今天的虛擬操作：先 git fetch origin claude/ui-calculator-interface-t3x9kh 並切到該分支（remote 已可用，不必再改網址；工作目錄若在別的分支，用 git checkout 或 worktree 切過去後 git pull）；用「台股官方」MCP 工具查價（get_stock_daily_trading 或 get_realtime_quote）、fill 昨天的委託、close 記帳、cash 資金水位、研究持股並決定明天委託、寫 note；狀態檔是 stock-app/virtual/v-2wy3g7efad1c.json（11/11 起改名，舊的 virtual-etf.json 已停用）。

**雙引擎＋新聞否決（使用者 11/15 同意，DAILY.md 6b）**：虛擬操作做完後，照 stock-app/virtual/VETO.md 檢查「雙引擎＋」名單（下載 dualplus.json 的 targets、pending 買進，加上 dual-veto.json 裡還有效的）每一檔的新聞、法人與重大訊息，只把有明確重大利空、寫得出日期與來源的列入否決，更新 stock-app/virtual/dual-veto.json（JSON 要能解析）。寧可少否決，不要亂否決。

提交：只提交 stock-app/virtual/v-2wy3g7efad1c.json 與 stock-app/virtual/dual-veto.json 這兩個檔案並推送到 claude/ui-calculator-interface-t3x9kh（commit 訊息「virtual-etf: D 收盤更新」；使用者 11/14 同意本排程推送到此分支）；**推送完成後、發推播之前，多做一步（使用者 10/29 同意，因為 GitHub 的定時工作常被拖延好幾小時）：用 GitHub 工具 mcp__github__actions_run_trigger（method run_workflow，owner ltotokkimo-spec，repo new-1016，workflow_id stock-backtest-daily.yml，ref claude/conversation-start-guide-ya0q8x）觸發「Stock Backtest Daily」。它會自己檢查今天是否已更新過，已更新就跳過，所以重複觸發不會多花錢；只觸發這一個 workflow，不要觸發其他 workflow。觸發失敗就在回覆與推播裡註明，不影響虛擬操作本身。**最後發手機推播，並多寫一句「雙引擎＋否決：新增 N 檔（名稱）、解除 M 檔、有效 K 檔」或「雙引擎＋否決：無變動」。今天休市就不改檔案、也不觸發 workflow，只推播「虛擬ETF：今天休市，未更新」。注意 CLI 參數順序是 `指令 <state> <日期> <quotes>`。三大法人若還查不到當天資料（約 15:00～16:00 公布），就用前一天的並在說明註明。回覆第一行寫 ✅ 完成 或 ❌ 失敗：原因。
```
> 注意（11/17～18 之後）：雙引擎＋已改成「候選限定選股頁買入」並從 11/17 乾淨重新起算（見 `HANDOFF.md` §9c）；`dualplus.json` 的 `targets`／`pending` 格式沒變，上面的否決檢查照舊可用。

### E-2 每週檢視（週六 09:50）
```
週六例行：檢視「Claude 虛擬自組 ETF」本週的選股績效，並優化下週的選股方向（使用者 10/21 要求，每週六做）。全部用繁體中文；漲紅跌綠。

準備：`git fetch origin claude/ui-calculator-interface-t3x9kh` 並切到該分支（remote 已可用，不必再改網址；用 checkout 或 worktree 後 git pull）；讀 `stock-app/virtual/DAILY.md`（目前規則）、`stock-app/virtual/WEEKLY.md`（之前的週檢視，若有）；在 `stock-app/` 跑 `node --experimental-strip-types tools/virtual-etf.ts show virtual/v-2wy3g7efad1c.json`（11/11 起狀態檔改名）。價格與技術指標用台股官方 MCP 工具；也可參考 App 回測 https://github.com/ltotokkimo-spec/new-1016/releases/download/radar-data-vug13iw701/backtest.json （11/11 起雲端資料改到這個位置）。

檢視（只看實際數字）：本週與累計組合 vs 0050（用 nav 歷史，注意 10/21 加碼到 50 萬的稀釋，加碼前分開看）；核心（台積電、鴻海、台達電等）與衛星各自貢獻與每檔損益；本週每筆買賣的事後表現、停損、沒成交原因、換股成本。**衛星要分兩組比較（使用者 10/22 把衛星新買進規則從「剛轉強」改成「外資連買≥3天＋成交金額≥3億」，見 DAILY.md）：舊規則持股（10/22 以前買進，例如大成鋼、中鋼、儒鴻、潤泰新）與新規則持股（10/22 起買進，`reason` 會寫「外資連買 N 天、成交金額 X 億」）各自的平均報酬、勝率與同期 0050；樣本很少就明說「樣本太少，不下結論」，累積到每組至少 8 筆已結束的交易再比較。**

【影子評分追蹤（使用者 10/22 同意加入）】App 評分的「影子版 C」（動能20、籌碼40、族群15、流動性25，權重 2026/10/22 凍結）正在做樣本外驗證，結果由每天 18:40 的回測產出。每週六下載 https://github.com/ltotokkimo-spec/new-1016/releases/download/radar-data-vug13iw701/scorecompare.json （curl -L），讀 `shadow` 欄位並在週報用一小段回報：(1) verdict.status 與 reasons（事先訂的標準：20 日報酬已成熟的評等日 ≥ 40 天後，C 的 IC、前5%超額、買入組超額都不輸現有，大盤下跌日 IC 不輸、買入檔數在 ±30% 內才通過）；(2) matured 的 5 日／20 日天數、old 與 shadow 的 IC／前5%／買入組超額（沒資料就寫「尚無」）；(3) liqSpread（成交金額最大五分之一減最小五分之一的報酬差，負的代表大型股效應反轉，要特別警示）；(4) latest 兩份買入名單的重疊檔數，以及本週虛擬 ETF 衛星持股有幾檔在影子名單、幾檔在現有名單。只讀不改：不要改評分權重、不要改 SHADOW 設定或 scoreCompare.ts／score.ts、不要因為單週數字提前宣布通過或失敗；status 變成「通過」或「未通過」時，在「給使用者的建議」明確寫出並說「需要你決定」。若下載失敗就寫「影子追蹤資料下載失敗」，不影響其他檢視。

【四因子名單追蹤（使用者 11/15 同意加入：和現有買入、影子 C 並列追蹤，到影子 C 判定時一起比）】選股頁的「四因子」名單（外資 60 日買超 30%、成交金額 25%、低波動 25%、營收年增 20%，規則 2026/11/15 定案，11/16 起追蹤）由每天的回測產出。每週六下載 https://github.com/ltotokkimo-spec/new-1016/releases/download/radar-data-vug13iw701/quad.json （curl -L），在週報用一小段回報 `track.stats` 裡 old（現有買入）、c（影子 C）、quad（四因子）、all（全部股票）三組加對照的：5 日與 20 日各自的 days（已有結果的評等日數）、win（勝率）、ex（比全部股票平均多多少）；沒資料就寫「尚無」。另外回報最新名單檔數與前 5 檔。只讀不改：不要改 quad.ts 的 QUAD 參數、不要因為單週數字下結論；20 日的 days 還不到 40 天時一律寫「資料不足，持續追蹤」。到 20 日 days ≥ 40 天後，若四因子的 20 日勝率與超額都不輸現有買入，在「給使用者的建議」寫出數字並說「需要你決定要不要取代現有買入評等」；否則照實寫沒有比較好。下載失敗就寫「四因子追蹤資料下載失敗」，不影響其他檢視。

優化：只在有數據支持時調整 DAILY.md 的選股／配置規則，並在規則旁標「（M/D 週檢視調整：原因）」。一週資料很少，不因單週輸贏大改；策略方向的大改變只寫建議、等使用者決定。使用者不要 0050，不要加進組合。不要下單、不要改 trades 或 nav（平日 16:40 排程負責）；不要改排程、不要觸發 workflow_dispatch。

記錄：`stock-app/virtual/WEEKLY.md` 最上面新增本週檢視（本週與累計 vs 0050、核心／衛星（新舊規則分開）貢獻、好與不好、影子評分追蹤進度、四因子追蹤進度、規則調整、給使用者的建議）；`note <今天YYYYMMDD> "週檢視：…"` 寫 2～4 句摘要；只 `git add stock-app/virtual/`，commit「virtual-etf: <日期> 週檢視 [skip ci]」並 push 到 claude/ui-calculator-interface-t3x9kh（使用者 11/14 同意本排程推送到此分支；衝突 `git pull --rebase` 重試最多 4 次）。

回報：回覆第一行「✅ 週檢視完成：…」或「❌ 週檢視失敗：原因」，並發手機推播一行：「✅ 虛擬ETF 週檢視：本週 X% vs 0050 Y%；影子評分：<資料不足 n/40／通過／未通過>；四因子：<資料不足 n/40／較好／沒有較好>；調整：…；需要你決定：…（沒有就寫無）」。
```

### E-3 貝爾威勒追蹤（週五 18:30，不綁對話，已啟用，**不需轉移**；僅留存定義）
`trig_01MHAM59HPmLsnWaH6vs6zaX`，`CRON_TZ=Asia/Taipei 30 18 * * 5`，模型 sonnet，連接器：台股官方、Claude_Docs、Bigdata_com、FMP、Claude_Code_Remote、Alpha_Vantage；通知：手機推播。提示詞：
```
請用繁體中文，查詢貝爾威勒（興櫃代號 7861）轉上市的最新進度，並用簡短的重點整理回報。背景：證交所上市審議委員會已在 2026/9/11 通過貝爾威勒初次申請上市案，輔導承銷商為元大證券，但仍須提報證交所董事會核議，媒體預期最快 2026 年底到 2027 年初掛牌。請用 WebSearch 查以下項目：(1) 證交所董事會是否已核議通過貝爾威勒上市案及日期；(2) 是否已公告承銷價、釋股張數、承銷方式（詢價圈購或競價拍賣）、掛牌日；(3) 最新興櫃收盤價與漲跌；(4) 其他重大訊息，例如月營收、財報更正、公司公告。這個排程已改為每週五查一次（2026/10/21 起），只回報自上一次查詢（約一週內）以來的新進展；如果沒有新消息，只回一句「目前沒有新進展」並附最新收盤價，不要重複已知內容。回覆最後附上來源連結，並註明這不是投資建議。
```
