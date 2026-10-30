// 探測證交所「每日市場成交資訊」FMTQIK（大盤成交金額官方數字）的回應格式
const url = "https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=20261022&response=json";
try {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const t = await r.text();
  console.log(`FMTQIK HTTP ${r.status} ${t.length}B`);
  console.log(t.slice(0, 700));
  const j = JSON.parse(t);
  console.log("keys", Object.keys(j).join(","), "fields", JSON.stringify(j.fields), "rows", (j.data ?? []).length);
  console.log("last2", JSON.stringify((j.data ?? []).slice(-2)));
} catch (e) { console.log("FMTQIK 失敗", String(e)); }
