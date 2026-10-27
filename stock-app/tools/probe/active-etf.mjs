// 探測：主動式 ETF 每日持股的資料來源（MoneyDJ、Pocket、各投信），印出狀態與表格片段
const UA = { "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36", "accept-language": "zh-TW" };
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
async function get(url) {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get("content-type") || "";
    let text = new TextDecoder(/big5/i.test(ct) ? "big5" : "utf-8").decode(buf);
    return { status: r.status, ct, len: buf.length, text };
  } catch (e) { return { status: 0, err: String(e) }; }
}
const urls = [
  "https://www.moneydj.com/etf/x/basic/basic0007.xdjhtm?etfid=00981a.tw",
  "https://www.moneydj.com/etf/x/basic/basic0007b.xdjhtm?etfid=00981a.tw",
  "https://www.pocket.tw/etf/tw/00981A/fundholding/",
  "https://www.etfinfo.tw/active",
  "https://active-etf.chicoo.co/",
  "https://www.ezmoney.com.tw/ETF/Fund/Info?fundCode=49YTW",
];
for (const u of urls) {
  const r = await get(u);
  console.log(`\n===== ${u}\nstatus=${r.status} ct=${r.ct} len=${r.len} ${r.err || ""}`);
  if (!r.text) continue;
  const t = strip(r.text);
  const i = Math.max(0, t.search(/台積電|2330/));
  console.log("TEXT@", i, t.slice(Math.max(0, i - 600), i + 1500));
  const apis = [...new Set((r.text.match(/["'](\/[^"']*(api|json|Holding|holding|Asset)[^"']*)["']/g) || []).slice(0, 30))];
  console.log("API-LIKE", JSON.stringify(apis));
}
