// 探測 Yahoo 日線（含配息）：候選 ETF 的資料長度、配息筆數
const H = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36", accept: "application/json" };
console.log("===== INDEX probe6 =====");
const codes = ["0050","006208","009816","0056","00878","00919","00929","00918","00713","0052","00881","00927","00891","00679B","00687B","00751B","00720B","00725B","00772B","00981A","00403A","00406A","00991A"];
const ymd = (t) => new Date(t * 1000 + 8 * 3600e3).toISOString().slice(0, 10);
for (const c of codes) {
  let done = false;
  for (const sfx of [".TW", ".TWO"]) {
    try {
      const u = `https://query1.finance.yahoo.com/v8/finance/chart/${c}${sfx}?range=3y&interval=1d&events=div%7Csplit`;
      const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) });
      if (!r.ok) continue;
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (!res?.timestamp?.length) continue;
      const ts = res.timestamp, q = res.indicators.quote[0], adj = res.indicators.adjclose?.[0]?.adjclose;
      const divs = Object.values(res.events?.dividends ?? {});
      const valid = q.close.filter((x) => x != null).length;
      console.log(`${c}${sfx} bars=${ts.length} valid=${valid} first=${ymd(ts[0])} last=${ymd(ts.at(-1))} lastClose=${q.close.filter((x)=>x!=null).at(-1)} adj=${adj ? "有" : "無"} divs=${divs.length} lastDiv=${JSON.stringify(divs.sort((a,b)=>a.date-b.date).slice(-2).map((d)=>[ymd(d.date), d.amount]))} name=${res.meta.shortName ?? ""}`);
      done = true; break;
    } catch (e) { /* 試下一個後綴 */ }
  }
  if (!done) console.log(`${c} 查不到`);
  await new Promise((r) => setTimeout(r, 400));
}
