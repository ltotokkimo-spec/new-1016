// 探測：MoneyDJ 電腦版 ETF 持股（要完整持股與股數）、Pocket 的資料 API
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "accept-language": "zh-TW,zh;q=0.9" };
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
async function get(url, headers = {}) {
  try {
    const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(20000) });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, ct: r.headers.get("content-type") || "", len: buf.length, text: new TextDecoder("utf-8").decode(buf) };
  } catch (e) { return { status: 0, err: String(e) }; }
}
const urls = [
  "https://www.moneydj.com/etf/x/basic/basic0007.xdjhtm?etfid=00981A.TW",
  "https://www.moneydj.com/ETF/X/Basic/Basic0007B.xdjhtm?etfid=00981A.TW",
  "https://www.moneydj.com/etf/x/basic/basic0007.xdjhtm?etfid=00406A.TW",
  "https://www.pocket.tw/etf/tw/00981A/fundholding?page&parent&source",
];
for (const u of urls) {
  const r = await get(u);
  console.log(`\n===== ${u}\nstatus=${r.status} ct=${r.ct} len=${r.len} ${r.err || ""}`);
  if (!r.text) continue;
  const t = strip(r.text);
  const i = Math.max(0, t.search(/持股明細/));
  console.log("TEXT@", i, t.slice(i, i + 3500));
  const tbl = r.text.match(/<table[\s\S]*?<\/table>/g) || [];
  console.log("TABLES", tbl.length, tbl.map((x) => x.length).join(","));
  const big = tbl.sort((a, b) => b.length - a.length)[0];
  if (big) console.log("BIGTABLE-HTML", big.slice(0, 1500));
  const urlsIn = [...new Set((r.text.match(/(https?:)?\/\/[^"' ]*(ashx|api|json|Dtno|DtNo)[^"' ]*/gi) || []))].slice(0, 20);
  console.log("URLS", JSON.stringify(urlsIn));
}
