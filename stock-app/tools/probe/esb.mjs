// 探測櫃買中心「興櫃」資料來源：官方 OpenAPI 有哪些興櫃路徑、7861 最新資料、個股歷史行情與即時報價有沒有可用的 JSON
const H = { "user-agent": "Mozilla/5.0", accept: "application/json,text/html,*/*" };
const get = async (url, n = 600) => {
  try {
    const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    console.log(`[${r.status}] ${url}\n   ${t.replace(/\s+/g, " ").slice(0, n)}`);
    return t;
  } catch (e) { console.log(`[ERR] ${url} ${e.message}`); return ""; }
};
console.log("===== ESB probe =====");
const sw = await get("https://www.tpex.org.tw/openapi/swagger.json", 0);
try {
  const d = JSON.parse(sw);
  for (const [p, v] of Object.entries(d.paths)) {
    if (!/esb|emerg|興櫃/i.test(p + JSON.stringify(v.get?.summary ?? ""))) continue;
    const sch = v.get?.responses?.["200"]?.content?.["application/json"]?.schema?.items;
    const ref = sch?.$ref?.split("/").pop();
    const props = ref ? Object.keys(d.components.schemas[ref]?.properties ?? {}) : [];
    console.log(`PATH ${p} | ${v.get?.summary} | ${props.join(",")}`);
  }
} catch (e) { console.log("swagger 解析失敗", e.message); }
const latest = await get("https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics", 0);
try { const rows = JSON.parse(latest); console.log("latest 筆數", rows.length, "7861:", JSON.stringify(rows.find((r) => r.SecuritiesCompanyCode === "7861"))); } catch (e) { console.log("latest 解析失敗", e.message); }
// 候選：個股歷史行情、即時行情（新版網站 www/zh-tw 路徑）
const ym = "2026/10/30", ymm = "2026/10";
for (const u of [
  `https://www.tpex.org.tw/www/zh-tw/emerging/historical?code=7861&date=${encodeURIComponent(ymm)}&response=json`,
  `https://www.tpex.org.tw/www/zh-tw/emerging/historical?code=7861&date=${encodeURIComponent(ym)}&id=&response=json`,
  `https://www.tpex.org.tw/www/zh-tw/emerging/tradingStock?code=7861&date=${encodeURIComponent(ym)}&id=&response=json`,
  `https://www.tpex.org.tw/www/zh-tw/emerging/daily?date=${encodeURIComponent(ym)}&id=&response=json`,
  `https://www.tpex.org.tw/www/zh-tw/emerging/latest?response=json`,
  `https://www.tpex.org.tw/www/zh-tw/emerging/realtime?response=json`,
  `https://www.tpex.org.tw/www/zh-tw/emerging/real-time?response=json`,
  `https://www.tpex.org.tw/web/emergingstock/historical/historical_result.php?l=zh-tw&d=115/10&stkno=7861&o=json`,
  `https://www.tpex.org.tw/web/emergingstock/aftertrading/daily_trading_info/st42_result.php?l=zh-tw&d=115/10/29&o=json`,
  `https://www.tpex.org.tw/web/emergingstock/lateststat/latest_stat_result.php?l=zh-tw&o=json`,
]) await get(u);
// 從網頁找實際呼叫的資料網址
for (const page of [
  "https://www.tpex.org.tw/zh-tw/emerging/trading/info/history.html",
  "https://www.tpex.org.tw/zh-tw/emerging/trading/info/real-time.html",
  "https://www.tpex.org.tw/zh-tw/emerging/trading/info/latest.html",
]) {
  const html = await get(page, 200);
  const scripts = [...html.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => m[1]).slice(0, 8);
  console.log("   scripts:", scripts.join(" "));
  const hits = [...html.matchAll(/(?:\/www\/zh-tw\/|\/web\/|\/openapi\/)[A-Za-z0-9_\/\-\.]*(?:emerg|esb)[A-Za-z0-9_\/\-\.\?=&]*/gi)].map((m) => m[0]);
  console.log("   data urls in html:", [...new Set(hits)].join(" "));
  for (const sc of scripts) {
    const u = sc.startsWith("http") ? sc : "https://www.tpex.org.tw" + sc;
    const js = await get(u, 0);
    const hs = [...js.matchAll(/["'`]([^"'`]*(?:emerg|esb)[^"'`]*(?:json|php|\.html)?[^"'`]*)["'`]/gi)].map((m) => m[1]).filter((x) => x.length < 140);
    if (hs.length) console.log("   in", sc, [...new Set(hs)].slice(0, 15).join(" | "));
  }
}
