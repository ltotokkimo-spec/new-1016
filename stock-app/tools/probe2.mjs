// 第二輪探測：美股替代來源、個股歷史、上櫃篩選參數
const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const H = { "User-Agent": UA, Accept: "application/json,text/plain,*/*", "Accept-Language": "en-US,en;q=0.9" };
async function show(name, url, opts = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { ...H, ...(opts.headers || {}) }, redirect: "follow" });
    const text = await r.text();
    console.log(`\n### ${name} HTTP ${r.status} ${text.length}B ${Date.now() - t0}ms\n${url}\nsample: ${text.slice(0, 500).replace(/\s+/g, " ")}`);
    return { r, text };
  } catch (e) { console.log(`\n### ${name} ERROR ${e.message} ${e.cause?.code || ""}\n${url}`); return {}; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Yahoo with cookie + crumb
{
  const a = await fetch("https://fc.yahoo.com", { headers: H, redirect: "manual" }).catch((e) => ({ headers: new Headers(), status: e.message }));
  const cookie = (a.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  console.log("\n### yahoo fc cookie status", a.status, cookie ? "got cookie" : "no cookie");
  const c = await show("yahoo_crumb", "https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { Cookie: cookie } });
  await show("yahoo_chart_crumb", `https://query2.finance.yahoo.com/v8/finance/chart/AAPL?range=6mo&interval=1d&crumb=${encodeURIComponent(c.text || "")}`, { headers: { Cookie: cookie } });
  await show("yahoo_spark", "https://query1.finance.yahoo.com/v7/finance/spark?symbols=AAPL,MSFT,%5EGSPC&range=1mo&interval=1d", { headers: { Cookie: cookie } });
}
await sleep(1000);
await show("nasdaq_hist", "https://api.nasdaq.com/api/quote/AAPL/historical?assetclass=stocks&fromdate=2026-04-01&limit=200&todate=2026-10-15");
await sleep(1000);
await show("nasdaq_etf_hist", "https://api.nasdaq.com/api/quote/SPY/historical?assetclass=etf&fromdate=2026-04-01&limit=200&todate=2026-10-15");
await sleep(1000);
await show("nasdaq_index", "https://api.nasdaq.com/api/quote/SPX/historical?assetclass=index&fromdate=2026-07-01&limit=100&todate=2026-10-15");
await sleep(1000);
await show("cnbc_quote", "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=AAPL%7C.SPX%7C.VIX%7CUS10Y&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1");
await sleep(1000);
await show("cnbc_hist", "https://ts-api.cnbc.com/harmony/app/charts/6M.json?symbol=AAPL");
await sleep(1000);
await show("google_fin", "https://www.google.com/finance/quote/AAPL:NASDAQ");
await sleep(1000);
await show("twse_stock_day", "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=20260901&stockNo=2330&response=json");
await sleep(2000);
await show("twse_quotes_old", "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=20260716&type=ALLBUT0999&response=json");
await sleep(2000);
await show("twse_holiday", "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=20261010&type=ALLBUT0999&response=json");
await sleep(2000);
await show("tpex_stock_hist", "https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=6488&date=2026%2F09%2F01&id=&response=json");
await sleep(2000);
for (const t of ["EW", "02", "AL"]) {
  await show(`tpex_quotes_type_${t}`, `https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=2026%2F10%2F15&type=${t}&id=&response=json`);
  await sleep(2000);
}
await show("tpex_holiday", "https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=2026%2F10%2F10&id=&response=json");
await sleep(2000);
await show("twse_t86_holiday", "https://www.twse.com.tw/rwd/zh/fund/T86?date=20261010&selectType=ALLBUT0999&response=json");
