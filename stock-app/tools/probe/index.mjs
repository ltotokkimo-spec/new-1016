// 用 App 同樣的方式（每個代號同時問 tse_ 與 otc_）一次問持股，看證交所到底回了哪些
const H = { "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/129.0 Mobile Safari/537.36", accept: "application/json, text/plain, */*" };
console.log("===== INDEX probe9 =====", new Date(Date.now() + 8 * 3600e3).toISOString(), "台北");
const codes = ["00406A", "0050", "2409", "6182", "6515", "7861", "2330", "2308"];
const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=${codes.flatMap((c) => [`tse_${c}.tw`, `otc_${c}.tw`]).join("|")}`;
console.log("url", url);
for (let k = 0; k < 3; k++) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(40000) });
    const txt = await r.text();
    console.log(`#${k} [${r.status}] ${Date.now() - t0}ms bytes=${txt.length}`);
    let j; try { j = JSON.parse(txt); } catch { console.log("非 JSON", txt.slice(0, 200)); continue; }
    console.log("rtmessage", j.rtmessage, "rtcode", j.rtcode, "筆數", (j.msgArray ?? []).length);
    for (const m of j.msgArray ?? []) console.log("  ", m.c, m.n, "z=", m.z, "pz=", m.pz, "b=", String(m.b).slice(0, 20), "y=", m.y, "t=", m.t, "d=", m.d, "u=", m.u, "w=", m.w, "v=", m.v);
  } catch (e) { console.log("ERR", e.message); }
  await new Promise((r) => setTimeout(r, 3000));
}
