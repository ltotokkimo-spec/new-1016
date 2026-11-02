// 探測證交所 MIS 盤中指數代號：一次問一批 ex_ch，印出有回應的 代號/名稱/現值/昨收
const base = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=";
const cand = [];
for (let i = 0; i <= 40; i++) cand.push(`tse_t${String(i).padStart(2, "0")}.tw`);
cand.push("otc_o00.tw", "tse_FRMSA.tw", "tse_t050.tw", "tse_TW50.tw");
async function run(list) {
  const url = base + encodeURIComponent(list.join("|"));
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  for (const m of j?.msgArray ?? []) {
    if (m.z === "-" && m.y === "-" && !m.n) continue;
    console.log(`${m.ex}_${m.ch}`.padEnd(16), "名稱:", (m.n || "?").padEnd(14), "現值 z=", m.z, "昨收 y=", m.y, "時間", m.t);
  }
}
// 分兩批，避免一次太多被拒
await run(cand.slice(0, 22));
await new Promise((r) => setTimeout(r, 1500));
await run(cand.slice(22));
