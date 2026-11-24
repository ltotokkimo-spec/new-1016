// 當沖推薦規則回測（11/25 使用者要求）。沒有盤中歷史資料，只能用證交所每日開高低收（MI_INDEX）近似：
// 用「前一天」的成交值、振幅、量能放大與偏多偏空算出推薦分數（開盤前就知道的資訊，不偷看當天），
// 隔天開盤買、收盤賣（偏空則開盤賣、收盤買回），扣當沖成本：手續費 0.1425%×2＋當沖證交稅 0.15%。
// 比較對象：同一個候選池（前一天成交量前 200 名）全部、與只看成交值前 10 名。只抓上市（上櫃沒有一次全部的開高低收）。
// 跑完就把自己改名停用（tools/probe 底下的檔案每次推送都會跑）。
const H = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => { const n = parseFloat(String(s ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : NaN; };
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const COST = 0.001425 * 2 + 0.0015;

const days = [];
for (let d = new Date(Date.UTC(2026, 4, 25)); d <= new Date(Date.UTC(2026, 10, 24)); d = new Date(d.getTime() + 86400000)) {
  const w = d.getUTCDay(); if (w === 0 || w === 6) continue;
  const key = ymd(d);
  let json = null;
  for (let a = 0; a < 3 && !json; a++) {
    try { const r = await fetch(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${key}&type=ALLBUT0999&response=json`, { headers: H, signal: AbortSignal.timeout(30000) }); json = await r.json(); } catch { await sleep(5000); }
  }
  await sleep(3200);
  if (!json || json.stat !== "OK" || !Array.isArray(json.tables)) continue;
  const t = json.tables.find((x) => Array.isArray(x?.fields) && x.fields.includes("證券代號") && x.fields.includes("收盤價"));
  if (!t) continue;
  const f = (n) => t.fields.indexOf(n);
  const [iC, iN, iV, iVal, iO, iH, iL, iCl, iS, iD] = ["證券代號", "證券名稱", "成交股數", "成交金額", "開盤價", "最高價", "最低價", "收盤價", "漲跌(+/-)", "漲跌價差"].map(f);
  const m = new Map();
  for (const r of t.data || []) {
    const code = String(r[iC]).trim();
    if (!/^[1-9]\d{3}$/.test(code)) continue; // 普通股（排除 ETF、權證）
    const c = num(r[iCl]), o = num(r[iO]), h = num(r[iH]), l = num(r[iL]);
    if (![c, o, h, l].every((x) => x > 0)) continue;
    const sign = /-/.test(String(r[iS]).replace(/<[^>]*>/g, "")) ? -1 : 1;
    const prev = c - sign * (num(r[iD]) || 0);
    m.set(code, { name: String(r[iN]).trim(), o, h, l, c, v: num(r[iV]), val: num(r[iVal]), prev: prev > 0 ? prev : c });
  }
  days.push({ date: key, m });
}
console.log(`DTBT 抓到 ${days.length} 個交易日（${days[0]?.date}～${days.at(-1)?.date}）`);

const acc = {};
const add = (k, x) => { const a = (acc[k] ??= { n: 0, range: 0, oc: 0, dir: 0, dirN: 0, win: 0, mfe: 0 }); a.n++; a.range += x.range; a.oc += x.oc; a.mfe += x.mfe; if (x.dir !== undefined) { a.dir += x.dir; a.dirN++; if (x.dir > 0) a.win++; } };
for (let t = 6; t < days.length; t++) {
  const y = days[t - 1].m, today = days[t].m;
  const pool = [...y.entries()].sort((a, b) => b[1].v - a[1].v).slice(0, 200);
  const feats = pool.map(([code, q]) => {
    let avg = 0, k = 0; for (let j = t - 6; j <= t - 2; j++) { const z = days[j].m.get(code); if (z) { avg += z.v; k++; } }
    const range = (q.h - q.l) / q.prev, relVol = k ? q.v / (avg / k) : 1, pos = q.h > q.l ? (q.c - q.l) / (q.h - q.l) : 0.5, chg = q.c / q.prev - 1;
    const bias = chg > 0 && q.c >= q.o && pos >= 0.6 ? "多" : chg < 0 && q.c <= q.o && pos <= 0.4 ? "空" : "盤";
    const limit = Math.abs(chg) >= 0.095;
    return { code, val: q.val, range, relVol, bias, limit };
  }).filter((x) => !x.limit && x.val >= 1e8 && x.range >= 0.015);
  const byVal = [...feats].sort((a, b) => a.val - b.val), pct = new Map(byVal.map((x, i) => [x.code, i / Math.max(1, byVal.length - 1)]));
  for (const x of feats) x.score = 0.4 * pct.get(x.code) + 0.3 * Math.min(1, x.range / 0.06) + 0.3 * Math.min(1, x.relVol / 3);
  const outcome = (code, bias) => {
    const q = today.get(code); if (!q) return null;
    if (Math.abs(q.o / q.prev - 1) >= 0.095) return null; // 開盤就鎖漲跌停：買不到／賣不掉
    const oc = q.c / q.o - 1;
    return { range: (q.h - q.l) / q.prev, oc: oc - COST, mfe: q.h / q.o - 1, dir: bias === "多" ? oc - COST : bias === "空" ? -oc - COST : undefined };
  };
  const pick = [...feats].sort((a, b) => b.score - a.score).slice(0, 10);
  const top = [...feats].sort((a, b) => b.val - a.val).slice(0, 10);
  for (const x of pick) { const o = outcome(x.code, x.bias); if (o) add("推薦前10", o); }
  for (const x of top) { const o = outcome(x.code, x.bias); if (o) add("成交值前10", o); }
  for (const [code] of pool) { const z = feats.find((x) => x.code === code); const o = outcome(code, z?.bias ?? "盤"); if (o) add("候選池全部200", o); }
}
const pc = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
for (const [k, a] of Object.entries(acc)) {
  console.log(`DTBT ${k}｜${a.n} 筆｜隔天平均振幅 ${pc(a.range / a.n)}｜開盤買收盤賣（扣成本）${pc(a.oc / a.n)}｜照偏多做多、偏空放空 ${a.dirN} 筆 平均 ${pc(a.dirN ? a.dir / a.dirN : NaN)}、賺錢 ${a.dirN ? ((a.win / a.dirN) * 100).toFixed(0) : "—"}%｜開盤後最高可漲 ${pc(a.mfe / a.n)}`);
}
