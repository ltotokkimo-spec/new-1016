// 探測 MI_INDEX type=IND 裡各指數的實際名稱（找出追蹤的 5 個指數少了哪一個）
const H = { "user-agent": "Mozilla/5.0", accept: "application/json,*/*" };
console.log("===== INDEX probe4 =====");
const u = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=20261029&type=IND&response=json";
const j = await (await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) })).json();
for (const t of j.tables || []) {
  if (!t?.fields) continue;
  const hits = (t.data || []).filter((r) => /電子|半導體|金融|臺灣50|台灣50|加權/.test(String(r[0])));
  console.log(`table ${JSON.stringify(t.title)} fields0=${JSON.stringify(t.fields[0])} rows=${(t.data || []).length}`);
  for (const r of hits) console.log("   ", JSON.stringify(String(r[0])), r[1]);
}
