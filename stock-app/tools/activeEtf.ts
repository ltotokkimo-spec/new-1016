// 每天抓所有主動式 ETF 的完整持股，和上一份比對，輸出 active-etf.json（App 的「ETF排行」主動式 ETF 排名用）。
// 用法：node .ae-build/activeEtf.js <歷史檔 active-etf-hist.json> <輸出 active-etf.json>
// 歷史檔從 Releases 的 stock-radar-data 下載、跑完再傳回去，所以每天只要抓「最新一份」持股就能累積。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { addSnap, buildActiveData, parseMoneyDjHoldings, type ActiveHist } from "../src/lib/activeEtf";

// 已知的台股主動式股票 ETF（10/27 查證）；另外每次從證交所、櫃買的收盤行情補上新上市的（代號 00xxxA）
const SEED = ["00400A", "00401A", "00403A", "00404A", "00405A", "00406A", "00407A", "00408A", "00410A", "00411A", "00415A", "00980A", "00981A", "00982A", "00984A", "00985A", "00986A", "00987A", "00990A", "00991A", "00992A", "00993A", "00994A", "00995A", "00996A", "00998A", "00999A"];
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "accept-language": "zh-TW,zh;q=0.9" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function text(url: string): Promise<string> {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
      if (r.ok) return await r.text();
    } catch { /* 重試 */ }
    await sleep(2000 * (i + 1));
  }
  throw new Error(`下載失敗 ${url}`);
}

async function listCodes(): Promise<string[]> {
  const codes = new Set(SEED);
  for (const u of ["https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"]) {
    try {
      const rows = JSON.parse(await text(u)) as Record<string, string>[];
      for (const r of rows) { const c = String(r.Code ?? r.SecuritiesCompanyCode ?? "").trim(); if (/^00\d{3}A$/.test(c)) codes.add(c); }
    } catch (e) { console.log("代號清單略過", u, String(e)); }
  }
  return [...codes].sort();
}

const [histPath = "active-etf-hist.json", outPath = "active-etf.json"] = process.argv.slice(2);
let hist: ActiveHist = { version: 1, etfs: {} };
if (existsSync(histPath)) {
  try { const h = JSON.parse(readFileSync(histPath, "utf8")); if (h?.version === 1) hist = h; } catch { /* 壞檔就重來 */ }
}
const codes = await listCodes();
console.log("主動式 ETF 代號", codes.length, codes.join(","));
let ok = 0;
for (const code of codes) {
  try {
    const html = await text(`https://www.moneydj.com/ETF/X/Basic/Basic0007B.xdjhtm?etfid=${code}.TW`);
    const p = parseMoneyDjHoldings(html);
    const n = p ? Object.keys(p.shares).length : 0;
    if (!p || !n) { console.log(code, "沒有台股持股（可能是國外股票或債券 ETF），略過"); continue; }
    if (p.code !== code) { console.log(code, "頁面代號不符", p.code); continue; }
    const prev = hist.etfs[code]?.snaps.at(-1)?.date ?? "-";
    hist = addSnap(hist, code, p.name, { date: p.date, shares: p.shares });
    ok++;
    console.log(code, p.name, "資料日", p.date, "台股", n, "檔", "上一份", prev);
  } catch (e) { console.log(code, "失敗", String(e)); }
  await sleep(800);
}
if (ok < 10) throw new Error(`只抓到 ${ok} 檔主動式 ETF 持股，太少，不更新`);
const data = buildActiveData(hist, new Date().toISOString());
writeFileSync(histPath, JSON.stringify(hist));
writeFileSync(outPath, JSON.stringify(data));
console.log("輸出", outPath, "ETF", data.etfs.length, "天數", data.days.length, data.days.map((d) => `${d.date}(${Object.keys(d.prev).length}檔ETF,${Object.keys(d.flows).length}股)`).join(" "));
const d0 = data.days[0];
if (d0) {
  const top = Object.entries(d0.flows).sort((a, b) => b[1].s - a[1].s);
  console.log("最新一天買最多（股數）", top.slice(0, 5).map(([c, f]) => `${c}:${f.s}`).join(" "), "賣最多", top.slice(-5).map(([c, f]) => `${c}:${f.s}`).join(" "));
}
