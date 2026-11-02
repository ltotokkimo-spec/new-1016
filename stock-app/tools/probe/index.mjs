// 探測證交所 MIS 開盤前（試搓時段）回傳的欄位
const H = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36", accept: "application/json", referer: "https://mis.twse.com.tw/stock/fibest.jsp" };
console.log("===== INDEX probe8 =====", new Date().toISOString(), "台北", new Date(Date.now() + 8 * 3600e3).toISOString());
const chs = ["tse_2409.tw", "otc_6182.tw", "otc_6515.tw", "tse_00406A.tw", "tse_0050.tw", "tse_2330.tw", "tse_2308.tw", "tse_t00.tw"];
for (let k = 0; k < 3; k++) {
  try {
    const u = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=${chs.join("|")}`;
    const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    console.log(`#${k} [${r.status}] queryTime=${JSON.stringify(j.queryTime)}`);
    for (const m of j.msgArray ?? []) console.log("  ", JSON.stringify(m));
  } catch (e) { console.log("ERR", e.message); }
  await new Promise((r) => setTimeout(r, 4000));
}
