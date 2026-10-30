// 探測指數歷史（日 K）資料來源：加權、臺灣50、半導體、金融保險、電子、櫃買
const H = { "user-agent": "Mozilla/5.0", accept: "application/json,*/*" };
const get = async (url, n = 500) => {
  try {
    const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    console.log(`[${r.status}] ${url}\n   ${t.replace(/\s+/g, " ").slice(0, n)}`);
    return t;
  } catch (e) { console.log(`[ERR] ${url} ${e.message}`); return ""; }
};
console.log("===== INDEX probe =====");
// 官方 openapi 裡和指數有關的路徑
for (const [name, u] of [["TWSE", "https://openapi.twse.com.tw/v1/swagger.json"], ["TPEX", "https://www.tpex.org.tw/openapi/swagger.json"]]) {
  const t = await get(u, 0);
  try { const d = JSON.parse(t); for (const [p, v] of Object.entries(d.paths)) if (/index|指數|taiex|MI_5MINS|MI_INDEX|FMTQIK/i.test(p + (v.get?.summary ?? ""))) console.log(`  ${name} PATH ${p} | ${v.get?.summary}`); } catch (e) { console.log(name, "解析失敗", e.message); }
}
// 加權指數：每日開高低收（證交所）
await get("https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=20261001&response=json", 700);
// 證交所指數歷史（其他指數）候選
await get("https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=20261029&type=IND&response=json", 300);
await get("https://www.twse.com.tw/rwd/zh/indicesReport/MFI94U?date=20261001&response=json", 400);
await get("https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=20261001&response=json&stockNo=TW50", 200);
// 櫃買指數歷史（新版網站）候選
for (const u of [
  "https://www.tpex.org.tw/www/zh-tw/indexInfo/inxh?date=2026%2F10%2F01&id=&response=json",
  "https://www.tpex.org.tw/www/zh-tw/indexInfo/hist?date=2026%2F10%2F01&id=&response=json",
  "https://www.tpex.org.tw/www/zh-tw/afterTrading/otcIndex?date=2026%2F10%2F01&id=&response=json",
  "https://www.tpex.org.tw/www/zh-tw/index/hist?date=2026%2F10%2F01&id=&response=json",
]) await get(u, 500);
// Yahoo 圖表 API
for (const sym of ["%5ETWII", "%5ETWOII", "%5ETW50", "0050.TW", "%5ETWSEIDX"]) await get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=3mo&interval=1d`, 300);
// 證交所 MIS 日內 K（只有當天）
await get("https://mis.twse.com.tw/stock/api/getChartOhlcStatis.jsp?ex=tse&ch=t00.tw&fqy=1", 300);
