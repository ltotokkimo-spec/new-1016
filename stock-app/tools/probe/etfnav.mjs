// 探測證交所「ETF 即時預估淨值與折溢價」來源格式（App 要在 ETF 詳情頁顯示即時折溢價）
const H = { "User-Agent": "Mozilla/5.0", Accept: "application/json, text/plain, */*", Referer: "https://mis.twse.com.tw/stock/etf_nav.jsp?lang=zh_tw" };
for (const url of [
  "https://mis.twse.com.tw/stock/data/all_etf.txt",
  "https://mis.twse.com.tw/stock/data/all_etf.txt?" + Date.now(),
]) {
  try {
    const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(30000) });
    const t = await r.text();
    console.log(`ETFNAV ${url} HTTP ${r.status} ${t.length}B`);
    console.log(t.slice(0, 900));
    try {
      const j = JSON.parse(t);
      const arr = j.a1 ?? j.msgArray ?? j.data ?? [];
      console.log("top keys", Object.keys(j).join(","), "n", arr.length);
      const hit = JSON.stringify(j).match(/\{[^{}]*00406A[^{}]*\}/g);
      console.log("00406A", hit ? hit.slice(0, 2).join("\n") : "沒找到");
      const first = (j.a1 ?? j.msgArray ?? [])[0];
      if (first) console.log("first", JSON.stringify(first).slice(0, 700));
    } catch (e) { console.log("非 JSON", String(e).slice(0, 80)); }
    break;
  } catch (e) { console.log(`ETFNAV ${url} 失敗`, String(e)); }
}
