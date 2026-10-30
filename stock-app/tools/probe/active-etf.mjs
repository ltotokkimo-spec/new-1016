// 探測：證交所 MIS 即時報價端點在盤中的更新頻率（有無 _= 參數、是否被快取）
const H = { "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36", accept: "application/json, text/plain, */*" };
const ex = ["2330", "2317", "0050", "2308"].flatMap((c) => [`tse_${c}.tw`, `otc_${c}.tw`]).join("|");
const base = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=${ex}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pull(label, url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    const m = Object.fromEntries((j.msgArray || []).map((x) => [x.c, `${x.t} z=${x.z} v=${x.v}`]));
    console.log(label, r.status, Date.now() - t0, "ms", JSON.stringify(m), "cache:", r.headers.get("age") || r.headers.get("x-cache") || "-");
  } catch (e) { console.log(label, "ERR", Date.now() - t0, "ms", String(e)); }
}
for (let i = 0; i < 8; i++) { await pull(`無_參數 #${i}`, base); await sleep(5000); }
for (let i = 0; i < 6; i++) { await pull(`有_參數 #${i}`, `${base}&_=${Date.now()}`); await sleep(5000); }
for (let i = 0; i < 4; i++) { await pull(`連續不等待 #${i}`, base); }
