// 探測：口袋證券（CMoney GetDtnoData）ETF 持股 API 的 DtNo 與參數，能不能查歷史持股
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "accept-language": "zh-TW,zh;q=0.9", referer: "https://www.pocket.tw/etf/tw/00981A/fundholding/" };
async function get(url) {
  try { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) }); return { status: r.status, text: await r.text() }; }
  catch (e) { return { status: 0, text: String(e) }; }
}
for (const f of ["033bc4d.js", "e433cb7.js"]) {
  const js = (await get(`https://www.pocket.tw/etf/_nuxt/${f}`)).text;
  for (const m of js.matchAll(/DtNo/g)) console.log(f, "@", m.index, js.slice(Math.max(0, m.index - 300), m.index + 300).replace(/\s+/g, " "));
  for (const m of js.matchAll(/fundholding|Holding|holding/g)) { if (m.index % 1 === 0) console.log(f, "H@", m.index, js.slice(Math.max(0, m.index - 200), m.index + 300).replace(/\s+/g, " ")); }
  const nums = [...new Set(js.match(/\b\d{7,9}\b/g) || [])];
  console.log(f, "NUMS", nums.slice(0, 60).join(","));
}
