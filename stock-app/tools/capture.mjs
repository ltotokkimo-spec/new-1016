// 抓一整套真實資料（10 個交易日法人＋4 個日期行情＋產業別），給本機開發 UI 用
import { gzipSync } from "node:zlib";
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const slash = (d) => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  return Buffer.from(await r.arrayBuffer());
}
function dump(name, buf) {
  const b64 = gzipSync(buf).toString("base64");
  console.log(`=====BEGIN ${name}=====`);
  for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
  console.log(`=====END ${name}=====`);
}
const days = [];
let d = new Date(Date.now() + 8 * 3600e3);
d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
while (days.length < 10) {
  const w = d.getUTCDay();
  if (w && w < 6) {
    const buf = await get(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd(d)}&selectType=ALLBUT0999&response=json`);
    const ok = JSON.parse(buf.toString()).stat === "OK";
    console.log("t86", ymd(d), ok);
    if (ok) { days.push(new Date(d)); dump(`t86_${ymd(d)}`, buf); }
    await sleep(2200);
  }
  d = new Date(d.getTime() - 86400e3);
}
for (const x of days) {
  dump(`tpexf_${ymd(x)}`, await get(`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${encodeURIComponent(slash(x))}&response=json`));
  await sleep(1200);
}
async function quotesOnOrBefore(target) {
  let t = new Date(target);
  for (let i = 0; i < 10; i++) {
    const w = t.getUTCDay();
    if (w && w < 6) {
      const buf = await get(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd(t)}&type=ALLBUT0999&response=json`);
      await sleep(2200);
      if (JSON.parse(buf.toString()).stat === "OK") {
        dump(`twseq_${ymd(t)}`, buf);
        dump(`tpexq_${ymd(t)}`, await get(`https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${encodeURIComponent(slash(t))}&id=&response=json`));
        await sleep(1200);
        return;
      }
    }
    t = new Date(t.getTime() - 86400e3);
  }
}
await quotesOnOrBefore(days[0]);
await quotesOnOrBefore(days[5]);
await quotesOnOrBefore(new Date(days[0].getTime() - 28 * 86400e3));
await quotesOnOrBefore(new Date(days[0].getTime() - 88 * 86400e3));
dump("companies_twse", await get("https://openapi.twse.com.tw/v1/opendata/t187ap03_L"));
dump("companies_tpex", await get("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O"));
