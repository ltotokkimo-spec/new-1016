// 探測櫃買興櫃當日行情表在晚上（收盤後很久）的回應
const H = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36", accept: "application/json" };
console.log("===== INDEX probe7 =====", new Date().toISOString());
const u = "https://www.tpex.org.tw/www/zh-tw/emerging/latest?response=json";
for (let k = 0; k < 3; k++) {
  try {
    const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) });
    const txt = await r.text();
    console.log(`[${r.status}] bytes=${txt.length} head=${txt.slice(0, 200).replace(/\s+/g, " ")}`);
    let j; try { j = JSON.parse(txt); } catch { console.log("非 JSON"); continue; }
    console.log("keys", Object.keys(j).join(","), "stat", j.stat, "date", j.date);
    for (const t of j.tables ?? []) console.log("  table", JSON.stringify(t.title), "fields", JSON.stringify(t.fields)?.slice(0, 200), "rows", (t.data ?? []).length, "first", JSON.stringify((t.data ?? [])[0])?.slice(0, 200));
    const row = (j.tables ?? []).flatMap((t) => t.data ?? []).find((r) => String(r[0]) === "7861");
    console.log("7861", JSON.stringify(row));
  } catch (e) { console.log("ERR", e.message); }
  await new Promise((r) => setTimeout(r, 2000));
}
