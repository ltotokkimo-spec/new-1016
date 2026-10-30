// 探測櫃買指數歷史（openapi tpex_index）格式
const H = { "user-agent": "Mozilla/5.0", accept: "application/json,*/*" };
console.log("===== INDEX probe2 =====");
for (const u of ["https://www.tpex.org.tw/openapi/v1/tpex_index", "https://openapi.twse.com.tw/v1/indicesReport/TAI50I"]) {
  try {
    const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    console.log(`[${r.status}] ${u} 筆數 ${Array.isArray(j) ? j.length : typeof j}`);
    if (Array.isArray(j)) { console.log("  first", JSON.stringify(j[0])); console.log("  second", JSON.stringify(j[1])); console.log("  last", JSON.stringify(j.at(-1))); }
  } catch (e) { console.log("ERR", u, e.message); }
}
