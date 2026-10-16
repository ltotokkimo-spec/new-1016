// 探測：櫃買中心興櫃行情的 API，以及證交所/櫃買行情裡的 ETF 列
import { gzipSync } from "node:zlib";
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const H = { "User-Agent": UA, Accept: "application/json,text/plain,*/*" };
const dump = (name, buf) => {
  const b64 = gzipSync(buf).toString("base64");
  console.log(`=====BEGIN ${name}=====`);
  for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
  console.log(`=====END ${name}=====`);
};
async function get(name, url, keep = false) {
  try {
    const r = await fetch(url, { headers: H });
    const buf = Buffer.from(await r.arrayBuffer());
    const t = buf.toString("utf8");
    console.log(`\n### ${name} HTTP ${r.status} ${buf.length}B\n${url}\nsample: ${t.slice(0, 600).replace(/\s+/g, " ")}`);
    if (keep && r.ok) dump(name, buf);
    return t;
  } catch (e) { console.log(`\n### ${name} ERROR ${e.message}\n${url}`); return ""; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 1. 櫃買 OpenAPI 清單裡跟興櫃有關的端點
const sw = await get("tpex_swagger", "https://www.tpex.org.tw/openapi/swagger.json");
try {
  const j = JSON.parse(sw);
  for (const [p, v] of Object.entries(j.paths || {})) {
    const s = JSON.stringify(v);
    if (/esb|emerging|興櫃/i.test(p + s)) console.log("ESB PATH", p, "|", (v.get?.summary || v.get?.description || "").slice(0, 80));
  }
} catch (e) { console.log("swagger parse fail", e.message); }
await sleep(1000);
for (const p of ["tpex_esb_latest_statistics", "tpex_esb_capitals_rank", "tpex_esb_daily_quotes", "tpex_esb_warrant_quotes"]) {
  await get(p, `https://www.tpex.org.tw/openapi/v1/${p}`, true); await sleep(1200);
}
await get("esb_new_latest", "https://www.tpex.org.tw/www/zh-tw/emerging/latest?response=json", true); await sleep(1200);
await get("esb_new_historical", "https://www.tpex.org.tw/www/zh-tw/emerging/historical?code=7861&date=2026%2F10%2F01&response=json", true); await sleep(1200);
await get("esb_old_latest", "https://www.tpex.org.tw/web/emergingstock/lateststats/ESB_latest_stats_result.php?l=zh-tw&o=json"); await sleep(1200);
// 2. ETF：證交所行情表裡的 00 開頭列、櫃買行情裡的 ETF
const tw = await get("twse_quotes", "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=20261016&type=ALLBUT0999&response=json");
try {
  const t = JSON.parse(tw).tables.find((x) => x.fields?.includes("證券代號"));
  const etf = t.data.filter((r) => /^0/.test(r[0]));
  console.log("TWSE ETF rows", etf.length, JSON.stringify(etf.slice(0, 3).map((r) => r.slice(0, 9))), JSON.stringify(etf.filter((r) => ["0050", "00406A", "00632R"].includes(r[0].trim())).map((r) => r.slice(0, 9))));
} catch (e) { console.log("twse parse", e.message); }
await sleep(2200);
const t86 = await get("twse_t86", "https://www.twse.com.tw/rwd/zh/fund/T86?date=20261016&selectType=ALLBUT0999&response=json");
try { const j = JSON.parse(t86); console.log("T86 ETF rows", j.data.filter((r) => /^0/.test(r[0].trim())).length, JSON.stringify(j.data.filter((r) => ["0050", "00406A"].includes(r[0].trim())))); } catch {}
await sleep(1200);
const tp = await get("tpex_quotes", "https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=2026%2F10%2F16&id=&response=json");
try { const t = JSON.parse(tp).tables[0]; const etf = t.data.filter((r) => /^0\d{4,5}[A-Z]?$/.test(r[0])); console.log("TPEX ETF rows", etf.length, JSON.stringify(etf.slice(0, 4).map((r) => r.slice(0, 4)))); } catch (e) { console.log("tpex parse", e.message); }
for (let i = 0; i < 160; i++) console.log("#".repeat(1000));
