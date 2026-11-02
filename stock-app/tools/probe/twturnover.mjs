// 探測證交所盤中「每5秒委託成交統計」成交金額端點（可能需要先取得 session cookie）
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
async function getCookie() {
  const r = await fetch("https://mis.twse.com.tw/stock/index.jsp?lang=zh_tw", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  const c = (r.headers.getSetCookie?.() ?? [r.headers.get("set-cookie")].filter(Boolean)).map((s) => String(s).split(";")[0]).join("; ");
  return c;
}
async function tryUrl(label, url, cookie) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://mis.twse.com.tw/stock/index.jsp?lang=zh_tw", ...(cookie ? { Cookie: cookie } : {}) }, signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    console.log(`\n== ${label} HTTP ${r.status} ${t.length}B\n${t.slice(0, 900)}`);
  } catch (e) { console.log(`\n== ${label} 失敗 ${e}`); }
}
const ck = await getCookie().catch(() => "");
console.log("cookie:", ck ? "有" : "無");
await tryUrl("getStatis(帶cookie)", "https://mis.twse.com.tw/stock/api/getStatis.jsp?json=1&delay=0", ck);
await new Promise(r => setTimeout(r, 1000));
await tryUrl("getStatis(ex=tse)", "https://mis.twse.com.tw/stock/api/getStatis.jsp?response=json&ex=tse", ck);
await new Promise(r => setTimeout(r, 1000));
await tryUrl("getDispatch", "https://mis.twse.com.tw/stock/api/getDispatch.jsp?response=json", ck);
