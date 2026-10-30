// 探測櫃買興櫃：當日行情表（每分鐘更新）與個股歷史行情的欄位順序
const H = { "user-agent": "Mozilla/5.0", accept: "application/json,*/*" };
const j = async (u) => { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(20000) }); return r.json(); };
console.log("===== ESB probe2 =====");
const L = await j("https://www.tpex.org.tw/www/zh-tw/emerging/latest?response=json");
const t = L.tables?.[0];
console.log("latest keys", Object.keys(L), "table keys", Object.keys(t ?? {}));
console.log("latest fields", JSON.stringify(t?.fields));
console.log("latest date", t?.date, "rows", t?.data?.length);
console.log("latest 7861", JSON.stringify(t?.data?.find((r) => String(r[0]) === "7861")));
console.log("latest first", JSON.stringify(t?.data?.[0]));
const H2 = await j("https://www.tpex.org.tw/www/zh-tw/emerging/historical?code=7861&date=2026%2F10&response=json");
const h = H2.tables?.[0];
console.log("hist keys", Object.keys(H2), "table keys", Object.keys(h ?? {}));
console.log("hist fields", JSON.stringify(h?.fields));
console.log("hist rows", h?.data?.length, "first", JSON.stringify(h?.data?.[0]), "last", JSON.stringify(h?.data?.at(-1)));
console.log("hist date/summary", JSON.stringify(h?.date), JSON.stringify(h?.summary ?? h?.totalCount));
// 前一個月、不存在的代號、非興櫃代號（上櫃）的回應長什麼樣
for (const [code, d] of [["7861", "2026/09"], ["7861", "2025/01"], ["2330", "2026/10"], ["9999", "2026/10"]]) {
  const x = await j(`https://www.tpex.org.tw/www/zh-tw/emerging/historical?code=${code}&date=${encodeURIComponent(d)}&response=json`).catch((e) => ({ err: e.message }));
  const tb = x.tables?.[0];
  console.log(code, d, "stat", x.stat, "rows", tb?.data?.length, "first", JSON.stringify(tb?.data?.[0]), x.err ?? "");
}
