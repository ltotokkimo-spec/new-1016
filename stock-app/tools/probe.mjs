// 在 CI 上探測資料來源：印出狀態、欄位樣本，並把完整回應以 gzip+base64 印出供離線解析測試用。
import { gzipSync } from "node:zlib";

const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const pad = (n) => String(n).padStart(2, "0");
function weekdaysBack(n) {
  const out = []; const d = new Date(Date.now() + 8 * 3600e3); // 台灣時間
  while (out.length < n) { d.setUTCDate(d.getUTCDate() - 1); const w = d.getUTCDay(); if (w && w < 6) out.push(new Date(d)); }
  return out;
}
const days = weekdaysBack(3);
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const slash = (d) => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
const roc = (d) => `${d.getUTCFullYear() - 1911}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;

const targets = [];
for (const d of days) {
  targets.push([`twse_quotes_${ymd(d)}`, `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd(d)}&type=ALLBUT0999&response=json`]);
  targets.push([`twse_t86_${ymd(d)}`, `https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd(d)}&selectType=ALLBUT0999&response=json`]);
  targets.push([`tpex_quotes_new_${ymd(d)}`, `https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${encodeURIComponent(slash(d))}&id=&response=json`]);
  targets.push([`tpex_quotes_old_${ymd(d)}`, `https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?l=zh-tw&d=${roc(d)}&se=EW&o=json`]);
  targets.push([`tpex_insti_new_${ymd(d)}`, `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${encodeURIComponent(slash(d))}&response=json`]);
  targets.push([`tpex_insti_old_${ymd(d)}`, `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&se=EW&t=D&d=${roc(d)}&o=json`]);
  break; // 先只探最近一個交易日的格式
}
targets.push(["twse_companies", "https://openapi.twse.com.tw/v1/opendata/t187ap03_L"]);
targets.push(["tpex_companies", "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O"]);
targets.push(["twse_day_all", "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"]);
targets.push(["tpex_day_all", "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"]);
for (const s of ["2330.TW", "6488.TWO", "AAPL", "^TWII", "^SOX", "TWD=X"])
  targets.push([`yahoo_${s.replace(/[^A-Za-z0-9]/g, "_")}`, `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=6mo&interval=1d`]);
targets.push(["stooq_aapl", "https://stooq.com/q/d/l/?s=aapl.us&i=d"]);

const dump = process.argv.includes("--dump");
for (const [name, url] of targets) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json,text/plain,*/*" } });
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.toString("utf8");
    console.log(`\n### ${name}  HTTP ${r.status}  ${buf.length}B  ${Date.now() - t0}ms\n${url}`);
    console.log("sample:", text.slice(0, 700).replace(/\s+/g, " "));
    try {
      const j = JSON.parse(text);
      const keys = Array.isArray(j) ? Object.keys(j[0] || {}) : Object.keys(j);
      console.log("keys:", JSON.stringify(keys).slice(0, 600));
      if (j.tables) j.tables.forEach((t, i) => console.log(`table[${i}] ${t.title} fields=${JSON.stringify(t.fields)} rows=${t.data?.length}`));
      if (j.fields) console.log("fields:", JSON.stringify(j.fields), "rows:", j.data?.length);
    } catch {}
    if (dump && r.ok) {
      const b64 = gzipSync(buf).toString("base64");
      console.log(`=====BEGIN ${name}=====`);
      for (let i = 0; i < b64.length; i += 1000) console.log(b64.slice(i, i + 1000));
      console.log(`=====END ${name}=====`);
    }
  } catch (e) {
    console.log(`\n### ${name}  ERROR ${e.message} ${e.cause?.code || ""}\n${url}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
