// 第三輪：把美股與指標、個股歷史的完整回應印出來做成測試樣本
import { gzipSync } from "node:zlib";
const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const H = { "User-Agent": UA, Accept: "application/json,text/plain,*/*" };
const T = [
  ["nasdaq_AAPL", "https://api.nasdaq.com/api/quote/AAPL/historical?assetclass=stocks&fromdate=2026-04-01&limit=200&todate=2026-10-15"],
  ["nasdaq_SPY", "https://api.nasdaq.com/api/quote/SPY/historical?assetclass=etf&fromdate=2026-04-01&limit=200&todate=2026-10-15"],
  ["nasdaq_XLK", "https://api.nasdaq.com/api/quote/XLK/historical?assetclass=etf&fromdate=2026-04-01&limit=200&todate=2026-10-15"],
  ["nasdaq_TSM", "https://api.nasdaq.com/api/quote/TSM/historical?assetclass=stocks&fromdate=2026-04-01&limit=200&todate=2026-10-15"],
  ["nasdaq_BRKB", "https://api.nasdaq.com/api/quote/BRK.B/historical?assetclass=stocks&fromdate=2026-09-01&limit=200&todate=2026-10-15"],
  ["cnbc_macro", "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=" + encodeURIComponent(".SPX|.IXIC|.SOX|.DJI|.VIX|US10Y|US2Y|.DXY|TWD=|JPY=|@CL.1|@GC.1|.TWII|.N225|BTC.CM=") + "&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1"],
  ["twse_stock_day", "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=20260901&stockNo=2330&response=json"],
  ["tpex_stock_hist", "https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=6488&date=2026%2F09%2F01&id=&response=json"],
];
for (const [name, url] of T) {
  try {
    const r = await fetch(url, { headers: H });
    const buf = Buffer.from(await r.arrayBuffer());
    console.log(`### ${name} HTTP ${r.status} ${buf.length}B`);
    if (r.ok) {
      const b64 = gzipSync(buf).toString("base64");
      console.log(`=====BEGIN ${name}=====`);
      for (let i = 0; i < b64.length; i += 1000) console.log(b64.slice(i, i + 1000));
      console.log(`=====END ${name}=====`);
    }
  } catch (e) { console.log(`### ${name} ERROR ${e.message}`); }
  await new Promise((r) => setTimeout(r, 1500));
}
// 讓紀錄超過工具的內嵌上限，改存成檔案方便離線解碼
for (let i = 0; i < 160; i++) console.log("#".repeat(1000));
