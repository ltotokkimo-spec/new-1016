// 探測 MI_INDEX type=IND（只含指數，檔案小）：有沒有各類股指數、欄位、大小
const H = { "user-agent": "Mozilla/5.0", accept: "application/json,*/*" };
console.log("===== INDEX probe3 =====");
for (const d of ["20261029", "20261028"]) {
  for (const type of ["IND", "MS"]) {
    const u = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${d}&type=${type}&response=json`;
    try {
      const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) });
      const txt = await r.text();
      let j; try { j = JSON.parse(txt); } catch { console.log(`[${r.status}] ${u} 非 JSON ${txt.slice(0, 80)}`); continue; }
      console.log(`[${r.status}] ${u} bytes=${txt.length} stat=${j.stat} tables=${(j.tables || []).length} keys=${Object.keys(j).join(",")}`);
      for (const t of j.tables || []) console.log("  table", JSON.stringify(t.title), JSON.stringify(t.fields), "rows", (t.data || []).length, JSON.stringify((t.data || []).slice(0, 2)));
      if (Array.isArray(j.data)) console.log("  data", j.data.length, JSON.stringify(j.data.slice(0, 2)), JSON.stringify(j.fields));
      const hit = txt.match(/半導體類指數[^\]]*\]/); if (hit) console.log("  半導體 row", hit[0]);
    } catch (e) { console.log("ERR", u, e.message); }
  }
}
