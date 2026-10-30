// 探測美股即時報價來源：CNBC restQuote、Nasdaq watchlist／info，印出原始欄位
const H = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };
async function show(label, url) {
  try {
    const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    console.log(`==== ${label} HTTP ${r.status} ${t.length} bytes\n${t.slice(0, 4000)}\n`);
  } catch (e) { console.log(`==== ${label} 失敗 ${e}`); }
}
await show("CNBC", "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=" + encodeURIComponent("AAPL|TSM|BRK.B|QQQ|NOSUCHX") + "&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1");
await show("Nasdaq watchlist", "https://api.nasdaq.com/api/quote/watchlist?symbol=aapl%7cstocks&symbol=qqq%7cetf");
await show("Nasdaq info", "https://api.nasdaq.com/api/quote/AAPL/info?assetclass=stocks");
