// 探測證交所盤中「成交量/成交金額」與「漲跌家數」的來源
const H = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };
async function get(label, url) {
  try {
    const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    console.log(`\n==== ${label}  HTTP ${r.status}  ${t.length}B\n${t.slice(0, 2500)}`);
  } catch (e) { console.log(`\n==== ${label} 失敗 ${e}`); }
}
// 1) 加權/櫃買指數完整欄位（找 v 累積量、tv 當盤量等）
await get("MIS 加權/櫃買指數(完整欄位)", "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=" + encodeURIComponent("tse_t00.tw|otc_o00.tw"));
// 2) MIS 大盤成交統計（每5秒）
await new Promise(r => setTimeout(r, 1200));
await get("MIS getStatis", "https://mis.twse.com.tw/stock/api/getStatis.jsp?json=1");
// 3) MIS 指數委託成交統計
await new Promise(r => setTimeout(r, 1200));
await get("MIS getMarketTotal", "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=" + encodeURIComponent("tse_htime.tw"));
// 4) 證交所大盤即時統計頁 BWIBBU/FMTQIK 類（EOD 參考）
await new Promise(r => setTimeout(r, 1200));
await get("OpenAPI 漲跌家數(EOD參考)", "https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX20");
