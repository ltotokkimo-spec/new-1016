// 探測：主動式 ETF 歷史持股來源（MoneyDJ 是否可選日期、Pocket/CMoney API、etfinfo）
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "accept-language": "zh-TW,zh;q=0.9" };
async function get(url, headers = {}) {
  try {
    const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(20000) });
    return { status: r.status, ct: r.headers.get("content-type") || "", text: await r.text() };
  } catch (e) { return { status: 0, err: String(e), text: "" }; }
}
const date = (t) => (/資料日期[：:]\s*([\d/]+)/.exec(t) || [])[1];
// 1. MoneyDJ：頁面有沒有日期選單／參數
const md = await get("https://www.moneydj.com/ETF/X/Basic/Basic0007B.xdjhtm?etfid=00981A.TW");
console.log("MD forms", (md.text.match(/<(select|input|form)[^>]*>/g) || []).slice(0, 30).join("\n"));
console.log("MD options", (md.text.match(/<option[^>]*>[^<]*/g) || []).slice(0, 20).join(" | "));
for (const q of ["&date=2026/10/21", "&d=2026-10-21", "&dt=20261021", "&sdate=2026/10/21"]) {
  const r = await get("https://www.moneydj.com/ETF/X/Basic/Basic0007B.xdjhtm?etfid=00981A.TW" + q);
  console.log("MD", q, r.status, date(r.text));
}
// 2. Pocket（CMoney）：頁面裡的 API
const pk = await get("https://www.pocket.tw/etf/tw/00981A/fundholding/");
const scripts = [...new Set(pk.text.match(/src="[^"]+\.js"/g) || [])].slice(0, 15);
console.log("PK scripts", scripts.join(" "));
console.log("PK api", [...new Set(pk.text.match(/[A-Za-z0-9_\/.:-]*(ashx|DtNo|api)[A-Za-z0-9_\/.?=&-]*/g) || [])].slice(0, 30).join(" "));
for (const s of scripts) {
  const u = s.slice(5, -1); const full = u.startsWith("http") ? u : "https://www.pocket.tw" + u;
  const r = await get(full);
  const hits = [...new Set(r.text.match(/[A-Za-z0-9_\/.:-]*(GetDtnoData|DtNo|ashx|fundholding|Holding)[A-Za-z0-9_\/.?=&;:-]{0,120}/g) || [])].slice(0, 15);
  if (hits.length) console.log("PK js", full, hits.join("\n   "));
}
// 3. etfinfo：主動 ETF 頁裡的資料 API
const ei = await get("https://www.etfinfo.tw/active");
console.log("EI api", [...new Set(ei.text.match(/["'`](\/api\/[^"'`]+|https:\/\/[^"'`]*api[^"'`]*)["'`]/g) || [])].slice(0, 30).join(" "));
const ej = [...new Set(ei.text.match(/_next\/data\/[^"']+|\/_next\/static\/[^"']+\.js/g) || [])].slice(0, 5);
console.log("EI next", ej.join(" "));
