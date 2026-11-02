// 探測：上市櫃每月營收 openapi 的欄位格式與下載時間（免費解析用）
const H = { "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36", Accept: "application/json" };
async function probe(name, url, codes) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: H });
    const text = await r.text();
    console.log(`\n### ${name} HTTP ${r.status} ${text.length} chars ${Date.now() - t0}ms\n${url}`);
    let j; try { j = JSON.parse(text); } catch { console.log("NOT JSON:", text.slice(0, 400)); return; }
    console.log("type", Array.isArray(j) ? `array(${j.length})` : typeof j);
    const rows = Array.isArray(j) ? j : [];
    console.log("keys", JSON.stringify(Object.keys(rows[0] || {})));
    console.log("row0", JSON.stringify(rows[0]));
    for (const c of codes) console.log("code", c, JSON.stringify(rows.find((r) => Object.values(r).some((v) => String(v).trim() === c))));
  } catch (e) { console.log(`\n### ${name} ERROR ${e.message} ${Date.now() - t0}ms`); }
}
await probe("twse_revenue", "https://openapi.twse.com.tw/v1/opendata/t187ap05_L", ["2330", "2033"]);
await probe("tpex_revenue", "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O", ["6488", "8069"]);
for (const [name, url] of [["TPEX", "https://www.tpex.org.tw/openapi/swagger.json"], ["TWSE", "https://openapi.twse.com.tw/v1/swagger.json"]]) {
  try {
    const sw = await (await fetch(url, { headers: H })).json();
    for (const [p, v] of Object.entries(sw.paths || {})) if (/營收|revenue|t187ap05/i.test(p + JSON.stringify(v))) console.log(name, "PATH", p, "|", (v.get?.summary || "").slice(0, 80));
  } catch (e) { console.log(name, "swagger fail", e.message); }
}
