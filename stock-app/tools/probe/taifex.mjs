// 探測期交所 MIS 台指期即時報價（日盤 MarketType 0、夜盤 MarketType 1）：看回應格式，App 才能照著解析
const url = "https://mis.taifex.com.tw/futures/api/getQuoteList";
for (const mt of ["0", "1"]) {
  for (const body of [
    { MarketType: mt, SymbolType: "F", KindID: "1", CID: "TXF", ExpireMonth: "", RowSize: "全部", PageNo: "", SortColumn: "", AscDesc: "A" },
  ]) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json;charset=UTF-8", "User-Agent": "Mozilla/5.0", Accept: "application/json", Origin: "https://mis.taifex.com.tw", Referer: "https://mis.taifex.com.tw/futures/" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const t = await r.text();
      console.log(`TAIFEX MarketType=${mt} HTTP ${r.status} ${t.length} bytes`);
      console.log(t.slice(0, 2500));
      try {
        const j = JSON.parse(t);
        const list = j?.RtData?.QuoteList ?? [];
        console.log("QuoteList", list.length, "keys", Object.keys(list[0] ?? {}).join(","));
        for (const q of list.slice(0, 4)) console.log(JSON.stringify(q));
      } catch (e) { console.log("非 JSON", String(e)); }
    } catch (e) { console.log(`TAIFEX MarketType=${mt} 失敗`, String(e)); }
  }
}
