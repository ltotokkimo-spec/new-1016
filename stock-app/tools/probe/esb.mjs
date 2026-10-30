// 探測櫃買興櫃個股歷史行情：哪種日期格式能取到前幾個月
const H = { "user-agent": "Mozilla/5.0", accept: "application/json,*/*" };
console.log("===== ESB probe3 =====");
const tryIt = async (label, qs) => {
  try {
    const r = await fetch(`https://www.tpex.org.tw/www/zh-tw/emerging/historical?${qs}&response=json`, { headers: H, signal: AbortSignal.timeout(20000) });
    const x = await r.json(); const t = x.tables?.[0];
    console.log(label.padEnd(28), "stat", String(x.stat).slice(0, 30), "| title", t?.date, "| rows", t?.data?.length, "| first", t?.data?.[0]?.[0], "last", t?.data?.at(-1)?.[0]);
  } catch (e) { console.log(label, "ERR", e.message); }
};
for (const [l, d] of [["2026/09", "2026/09"], ["2026/09/01", "2026/09/01"], ["115/09", "115/09"], ["115/09/01", "115/09/01"], ["20260901", "20260901"], ["2026-09-01", "2026-09-01"], ["2026/09/30", "2026/09/30"], ["2026/08/15", "2026/08/15"]]) {
  await tryIt(`date=${l}`, `code=7861&date=${encodeURIComponent(d)}`);
  await tryIt(`date=${l}&id=`, `code=7861&date=${encodeURIComponent(d)}&id=`);
}
await tryIt("year=2026&month=9", "code=7861&year=2026&month=9");
await tryIt("code+d=115/09", "code=7861&d=115/09");
await tryIt("stkno", "stkno=7861&date=2026%2F09");
// 一個比較早就在興櫃的股票（貝爾威勒 10/20 才進度），再試一檔老興櫃（取最新行情表第一檔 1260 富味鄉）
await tryIt("1260 2026/09/01", "code=1260&date=2026%2F09%2F01");
await tryIt("1260 2026/10", "code=1260&date=2026%2F10");
