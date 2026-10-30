// 每天累積指數歷史（App 數據頁點指數看日 K 用），輸出 index-hist.json：
//  ohlc：加權指數（證交所每月歷史）、櫃買指數（櫃買 openapi 只回當月，靠每天累積）的真實開高低收
//  closes：臺灣50／半導體／金融保險／電子 的每日收盤（證交所 MI_INDEX type=IND，每天約 22KB）
//  seen：已經檢查過的日期（休市日也算），不再重抓
// 用法：node .ih-build/indexHist.js <歷史檔 index-hist.json> <輸出 index-hist.json>（同一個檔：Releases 下載、補完傳回去）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseIndexDay, parseTaiexHist, parseTpexIndex, taiexHistUrl, tpexIndexUrl, twseIndexDayUrl, type RemoteIndexHist } from "../src/data/indexHistory";
import { taipeiHour, taipeiToday, weekdaysBack } from "../src/lib/dates";

const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", accept: "application/json,*/*" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastTwse = 0;
async function getJson(url: string): Promise<any> {
  for (let i = 0; i < 3; i++) {
    if (url.includes("www.twse.com.tw")) { const wait = lastTwse + 3300 - Date.now(); if (wait > 0) await sleep(wait); lastTwse = Date.now(); } // 證交所 5 秒內最多 3 次
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (r.ok) return await r.json();
    } catch { /* 重試 */ }
    await sleep(2000 * (i + 1));
  }
  throw new Error(`下載失敗 ${url}`);
}

const [histPath = "index-hist.json", outPath = "index-hist.json"] = process.argv.slice(2);
let hist: RemoteIndexHist = { version: 1, ohlc: {}, closes: {}, seen: [] };
if (existsSync(histPath)) {
  try { const h = JSON.parse(readFileSync(histPath, "utf8")); if (h?.version === 1 && h.ohlc && h.closes) hist = { ...h, seen: h.seen ?? [] }; } catch { /* 壞檔就重來 */ }
}
const now = Date.now();
const today = taipeiToday(now);
const final = (d: string) => d < today || (d === today && taipeiHour(now) >= 15); // 15 點後當天資料才齊
const KEEP = 400;

// 1) 加權指數：近 14 個月（沒有資料的月份＋最近兩個月都抓）
{
  const byDate = new Map((hist.ohlc["加權指數"] ?? []).map((r) => [r[0], r]));
  let y = +today.slice(0, 4), m = +today.slice(4, 6);
  for (let i = 0; i < 14; i++) {
    const ym = `${y}${String(m).padStart(2, "0")}`;
    const have = [...byDate.keys()].some((d) => d.startsWith(ym));
    if (i < 2 || !have) {
      try { for (const b of parseTaiexHist(await getJson(taiexHistUrl(ym)))) byDate.set(b.date, [b.date, b.open, b.high, b.low, b.close]); }
      catch (e) { console.log("加權 略過", ym, String(e)); }
    }
    m--; if (m === 0) { m = 12; y--; }
  }
  hist.ohlc["加權指數"] = [...byDate.values()].sort((a, b) => a[0].localeCompare(b[0])).slice(-KEEP);
  console.log("加權指數", hist.ohlc["加權指數"].length, "筆");
}

// 2) 櫃買指數：只回當月，和累積的合併
try {
  const byDate = new Map((hist.ohlc["櫃買指數"] ?? []).map((r) => [r[0], r]));
  for (const b of parseTpexIndex(await getJson(tpexIndexUrl()))) byDate.set(b.date, [b.date, b.open, b.high, b.low, b.close]);
  hist.ohlc["櫃買指數"] = [...byDate.values()].sort((a, b) => a[0].localeCompare(b[0])).slice(-KEEP);
  console.log("櫃買指數", hist.ohlc["櫃買指數"].length, "筆");
} catch (e) { console.log("櫃買 略過", String(e)); }

// 3) 其餘指數的每日收盤：近 260 個平日，沒檢查過的才抓（第一次約 15 分鐘，之後每天 1～2 個請求）
{
  const seen = new Set(hist.seen);
  const maps = new Map<string, Map<string, number>>();
  for (const [name, rows] of Object.entries(hist.closes)) maps.set(name, new Map(rows));
  const todo = weekdaysBack(today, 260).filter((d) => final(d) && !seen.has(d)); // 新→舊
  console.log("待抓交易日", todo.length);
  let failed = 0;
  for (const d of todo) {
    if (failed >= 5) { console.log("連續失敗太多，剩下的明天再補"); break; }
    try {
      const day = parseIndexDay(await getJson(twseIndexDayUrl(d)));
      if (day) for (const [name, c] of Object.entries(day)) { if (!maps.has(name)) maps.set(name, new Map()); maps.get(name)!.set(d, c); }
      seen.add(d); // 休市（day 為 null）也記，不再重抓
      failed = 0;
    } catch (e) { failed++; console.log("略過", d, String(e)); }
  }
  hist.closes = Object.fromEntries([...maps].map(([name, m]) => [name, [...m].sort((a, b) => a[0].localeCompare(b[0])).slice(-KEEP)]));
  hist.seen = [...seen].sort().slice(-KEEP);
  console.log("收盤", Object.entries(hist.closes).map(([n, r]) => `${n}:${r.length}`).join(" "));
}

hist.updated = new Date(now).toISOString();
writeFileSync(outPath, JSON.stringify(hist));
console.log("完成", outPath);
