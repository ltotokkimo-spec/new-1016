// 探測美股指數日 K 來源
const H = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36", accept: "application/json,text/csv,*/*" };
console.log("===== INDEX probe5 =====");
const urls = [
  "https://ts-api.cnbc.com/harmony/app/bars/.SPX/1D/20260801000000/20261030000000/adjusted/EXTENDED.json",
  "https://ts-api.cnbc.com/harmony/app/bars/.VIX/1D/20260801000000/20261030000000/adjusted/EXTENDED.json",
  "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=3mo&interval=1d",
  "https://query2.finance.yahoo.com/v8/finance/chart/%5ESOX?range=3mo&interval=1d",
  "https://stooq.com/q/d/l/?s=%5Espx&i=d&d1=20260801&d2=20261030",
];
for (const u of urls) {
  try {
    const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) });
    const txt = await r.text();
    console.log(`[${r.status}] ${u} bytes=${txt.length}`);
    console.log("   head:", txt.slice(0, 420).replace(/\s+/g, " "));
    console.log("   tail:", txt.slice(-220).replace(/\s+/g, " "));
  } catch (e) { console.log("ERR", u, e.message); }
}
