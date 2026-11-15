# 雙引擎＋ 新聞否決：每日程序（使用者 2026/11/15 同意）

每個交易日 16:40 的排程，在虛擬 ETF 每日操作做完、**觸發 Stock Backtest Daily 之前**做這一段。
目的：讓「雙引擎＋」除了規則之外，也看新聞、法人與重大訊息；有明確重大利空的股票先不買、持有的賣出。
原版「雙引擎」不受影響，用來對照「看新聞」到底有沒有幫助，所以**寧可少否決，不要亂否決**。

## 1. 要檢查哪些股票

```bash
curl -sL https://github.com/ltotokkimo-spec/new-1016/releases/download/radar-data-vug13iw701/dualplus.json -o /tmp/dualplus.json
```

- `targets` 的代號（雙引擎＋最近一次判斷的目標名單，約 30 檔）。
- `pending` 裡要買的代號（明天要買的）。
- `virtual/dual-veto.json` 裡還有效（沒有 `until` 或 `until` ≥ 今天）的代號。

今天收盤後新選進來的股票，要等明天的排程才查得到（雲端回測在這之後才算），這是已知的一天落差。

## 2. 每一檔查什麼

- 台股官方 MCP：重大訊息（`get_company_major_news`）、三大法人（`get_twse_institutional_investors_by_stock`，上櫃用 `get_otc_institutional`）、處置股（`get_market_disposal_stocks`／`get_otc_disposal_stocks`）、注意股。
- 網路搜尋：近 7 天的新聞（股名＋代號）。
- 30 檔都要查，但每檔只看最近 7 天、標題層級；有疑慮再細看。

## 3. 什麼情況要否決（要寫得出日期與來源，否則不否決）

- 被列為處置股、全額交割、或停止交易。
- 公告重大虧損、財報大幅轉虧、大幅下修財測。
- 現金增資、私募、可轉債等大幅稀釋（相對股本 ≥ 10%）。
- 重大訴訟敗訴、違約、停工、重大災害、主要客戶或訂單確定流失。
- 大股東或董監大量申報轉讓（相對持股 ≥ 1%）。
- 法人：外資與投信同時連續大賣，近 5 日合計賣超佔成交量 ≥ 20%，而且有新聞說明原因。

**不要否決**：只是股價跌、一般分析師看法、沒有來源的傳言、整體大盤下跌、已經反映超過兩週的舊消息。

## 4. 寫進 `stock-app/virtual/dual-veto.json`

```json
{
  "version": 1,
  "note": "（保留原本的說明）",
  "updated": "20261116",
  "vetoes": [
    { "code": "2603", "name": "長榮", "from": "20261116", "reason": "公告 10 月營收年減 35%、法說下修全年運價展望", "source": "公開資訊觀測站重大訊息 11/16" }
  ]
}
```

- 新否決：`from` 寫今天（YYYYMMDD）。不要改舊紀錄的 `from`。
- 解除：利空已明確解決（例如處置期滿、增資取消），或否決滿 20 個交易日後重新檢查已無新利空，就在那筆加 `"until": "今天"`，不要刪除紀錄。
- `updated` 改成今天。只改這個檔案，JSON 要能被解析（`node -e 'JSON.parse(require("fs").readFileSync("virtual/dual-veto.json","utf8"))'`）。

## 5. 提交

和虛擬 ETF 的狀態檔一起提交：`git add stock-app/virtual/v-2wy3g7efad1c.json stock-app/virtual/dual-veto.json`，然後才觸發 Stock Backtest Daily（雲端回測讀這個檔案算雙引擎＋）。

回覆與推播多寫一句：「雙引擎＋否決：新增 N 檔（名稱）、解除 M 檔、有效 K 檔」，沒有變動就寫「雙引擎＋否決：無變動」。
