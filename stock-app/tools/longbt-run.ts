// 長期回測第三段：用 longbt-fetch 存好的快取，把各組合包成統一介面跑 2018 起的歷史（成本全扣、漲跌停限制），
// 含對照組（0050、等權重、隨機選股）。規則與判定標準見 stock-app/longbt/PREREG.md（事先寫死）。
// 階段 B、C 預設封存：沒設 LBT_OPEN_B=1 時連資料都不載入。
// 執行：npx vite build --ssr tools/longbt-run.ts --outDir .lbt-build && node .lbt-build/longbt-run.js .lbt-cache
import fs from "node:fs";
import path from "node:path";
import { TwLoader, buildTwInputs } from "../src/data/twLoader";
import { isCommonStock, isEtf } from "../src/data/tw";
import type { BtDay } from "../src/engine/backtest";
import { DEFAULT_WEIGHTS, scoreStocks, type Scored } from "../src/engine/score";
import { quadPicks } from "../src/engine/quad";
import { revTable, type RevEntry } from "../src/engine/revHist";
import { AI_GROUPS, DUAL, GROWTH, LEAD, REAL, STEADY, aPicks, aiTargets, buildCtx, dualPicker, leadTargets, realTargets, regimeStep, stats, turnPicker, wideTargets, type Ctx, type Picker, type StrategyStats } from "../src/engine/steady";
import { WATCH } from "../src/engine/watch";
import { growthLbPicker } from "../src/engine/longbtGrowth";
import { LB, cagr, ddBetween, maxDd, mulberry32, percentileOf, randomPicker, rollingWin, simulateLB, type LbSim } from "../src/engine/longbt";
import { addDays, taipeiToday, weekdaysBack } from "../src/lib/dates";
import { cnbcBarsUrl, parseCnbcBars } from "../src/data/indexHistory";
import type { KV } from "../src/lib/kv";

const cacheDir = process.argv[2] ?? ".lbt-cache";
const START = process.env.LBT_START ?? "20180102";
const A_END = process.env.LBT_A_END ?? "20211231";
const B_END = process.env.LBT_B_END ?? "20250131";
const B_START = process.env.LBT_B_START ?? "20220103"; // 預設為事前登記的 B 起點；只在本機合成資料測試時才覆寫
const REV_FROM = process.env.LBT_REV_FROM ?? "20190102"; // 營收類組合的起算日
const DRAWS = Number(process.env.LBT_DRAWS ?? 1000);
const openB = process.env.LBT_OPEN_B === "1";
const exp2 = process.env.LBT_EXP2 === "1"; // 雙引擎候選限定在選股頁名單（PREREG 第 10 節）
const exp = process.env.LBT_EXP === "1"; // 成長組走勢濾網實驗（PREREG 第 9 節）
const exp5 = process.env.LBT_EXP5 === "1"; // 前一晚美股（那斯達克、費半）大跌／大漲時，隔天照「買入」名單買的表現（11/24 使用者要求）
const exp4 = process.env.LBT_EXP4 === "1"; // 推薦（每天「買入」名單）停損與大盤弱勢暫停的事件研究（11/24 使用者要求）
const exp6 = process.env.LBT_EXP6 === "1"; // 雙引擎＋現金偏多：低波動組不限名單（DB4S）、空出的權重補給成長組（DB4F）的影響（11/26 使用者要求，只看階段 A；需同時 LBT_EXP2=1）
const exp3 = process.env.LBT_EXP3 === "1"; // 達標離場（獲利 ≥10% 且跌破 5 日線，不等判斷日先賣）對雙引擎的影響（11/24 使用者要求）
const diag = process.env.LBT_DIAG === "1"; // 成本對照診斷：同一批組合分別用零成本、低滑價（0.05%）再跑一次，只印出來比較，不改判定
const BENCH = "0050";
const fileKV = (dir: string): KV => {
  const f = (k: string) => path.join(dir, encodeURIComponent(k) + ".json");
  return {
    async get(k) { try { return JSON.parse(fs.readFileSync(f(k), "utf8")); } catch { return undefined; } },
    async set() { /* 唯讀：不寫回快取（TwLoader.companies 會想存公司資料，丟掉即可） */ },
    async del() { /* 唯讀 */ },
    async keys() { return fs.readdirSync(dir).map((x) => decodeURIComponent(x.replace(/\.json$/, ""))); },
  };
};
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...a);
const pc = (x: number, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "—");

async function main() {
  const kv = fileKV(cacheDir);
  const end = openB ? B_END : A_END;
  const weekdays = weekdaysBack(taipeiToday(), 3000).filter((d) => d >= START).reverse();

  // ---- 載入快取（診斷用的完整資料只在 openB 時才讀超過 A_END 的部分）----
  const loadEnd = openB ? "99999999" : A_END;
  const days: BtDay[] = []; // 舊到新，之後反轉
  const miss = { twseF: [] as string[], tpexQ: [] as string[], tpexF: [] as string[], no50: [] as string[] };
  for (const d of weekdays) {
    if (d > loadEnd) break;
    const qa = await kv.get<any>(`tw2:q:twse:${d}`);
    if (!qa || qa.holiday) continue;
    const [qb, fa, fb] = await Promise.all([kv.get<any>(`tw2:q:tpex:${d}`), kv.get<any>(`tw2:f:twse:${d}`), kv.get<any>(`tw2:f:tpex:${d}`)]);
    if (!fa) miss.twseF.push(d);
    if (!qb) miss.tpexQ.push(d);
    if (!fb) miss.tpexF.push(d);
    const quotes = [...qa.rows, ...(qb?.rows ?? [])];
    if (!quotes.some((r: any) => r[0] === BENCH)) miss.no50.push(d);
    days.push({ date: d, quotes, tpexCodes: new Set((qb?.rows ?? []).map((r: any) => r[0])), flows: [...(fa ?? []), ...(fb ?? [])] });
  }
  log(`載入 ${days.length} 個交易日（${days[0]?.date}～${days.at(-1)?.date}）｜${openB ? "已開封 B、C" : "B、C 封存，未載入"}`);
  if (days.length < 200) throw new Error("交易日太少，快取是不是沒還原？");

  // ---- 診斷：缺口與無法解釋的跳動（只用已載入的日期，不涉及績效）----
  log(`缺口：上市法人缺 ${miss.twseF.length} 天 ${miss.twseF.slice(0, 6).join(",")}｜上櫃行情缺 ${miss.tpexQ.length}｜上櫃法人缺 ${miss.tpexF.length} 天 ${miss.tpexF.slice(0, 3).join(",")}…${miss.tpexF.slice(-1)}｜0050 缺 ${miss.no50.length} 天 ${miss.no50.join(",")}`);
  {
    const first = new Map<string, number>();
    const closes: Map<string, number>[] = days.map((d) => new Map(d.quotes.map((r) => [r[0], r[2]])));
    const kinds: Record<string, number> = { 新上市五日內: 0, 停牌後復牌: 0, 隔天反轉過半: 0, 其他: 0 };
    const sample: string[] = [];
    days.forEach((d, i) => { for (const r of d.quotes) if (!first.has(r[0])) first.set(r[0], i); });
    let total = 0;
    for (let i = 1; i < days.length; i++) {
      for (const [code, p1] of closes[i]) {
        const p0 = closes[i - 1].get(code);
        if (!p0) continue;
        const ch = p1 / p0 - 1;
        if (Math.abs(ch) <= 0.11) continue;
        // 若漲跌欄的參考價解釋得通（收盤−漲跌 ≈ 前收×(1±0.1)以內），表示是交易所已公布的調整，不算異常
        const row = days[i].quotes.find((r) => r[0] === code)!;
        const ref = row[2] - row[3];
        if (Number.isFinite(ref) && ref > 0 && Math.abs(row[2] / ref - 1) <= 0.1001) continue;
        total++;
        let k = "其他";
        if (i - (first.get(code) ?? 0) <= 5) k = "新上市五日內";
        else if (i >= 3 && !closes[i - 2].has(code)) k = "停牌後復牌";
        else { const p2 = closes[i + 1]?.get(code); if (p2 && Math.abs(p2 - p1) >= 0.5 * Math.abs(p1 - p0)) k = "隔天反轉過半"; }
        kinds[k]++;
        if (k === "其他" && sample.length < 5) sample.push(`${days[i].date} ${code} ${p0}→${p1}`);
      }
    }
    log(`跳動分類（漲跌欄參考價也解釋不了的 ${total} 次）：${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join("、")}｜其他例：${sample.join("；")}`);
  }

  // ---- 準備 Ctx（只用到 end 為止；B 封存時 end = A_END）----
  const use = days.filter((d) => d.date <= end).reverse(); // 新到舊
  const loader = new TwLoader(async (u: string) => { const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(60_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }, kv);
  const companies = await loader.companies();
  const months = new Map<string, RevEntry[]>();
  for (const f of fs.readdirSync(cacheDir)) {
    const m = /^rev-(sii|otc)-(\d{6})\.json$/.exec(f);
    if (m) months.set(m[2], [...(months.get(m[2]) ?? []), ...(JSON.parse(fs.readFileSync(path.join(cacheDir, f), "utf8")) as RevEntry[])]);
  }
  const rev = revTable([...months].map(([ym, rows]) => ({ ym, rows })));
  log(`公司 ${companies.length}、月營收 ${months.size} 個月（含上市＋上櫃）`);
  const c = buildCtx(use, companies, rev), N = c.N;
  const j0 = Math.max(STEADY.lookback + 25, 100);
  const jRev = Math.max(j0, c.dates.findIndex((d) => d >= REV_FROM));
  log(`Ctx ${N} 天，模擬起點 ${c.dates[j0]}（營收類 ${c.dates[jRev]}）終點 ${c.dates[N - 1]}`);
  const px = (code: string, j: number) => { const s = c.series.get(code); return s && j >= s.start && j - s.start < s.adj.length ? s.adj[j - s.start] : NaN; };
  const aboveMa60 = (j: number) => { let t = 0; for (let k = j - 59; k <= j; k++) { const p = px(BENCH, k); if (!(p > 0)) return true; t += p; } return !(px(BENCH, j) < t / 60); };

  // ---- 各組合（照 11/16 的 App 規則，每個 run 重新建立有狀態的選股器）----
  const dateIdx = new Map(use.map((d, i) => [d.date, i]));
  const onOrBefore = (ymd: string) => { for (let k = 0; k < 10; k++) { const i = dateIdx.get(addDays(ymd, -k)); if (i !== undefined) return i; } return undefined; };
  const scoredAt = (j: number): Scored[] => {
    const i = N - 1 - j, s = use[i].date, m1 = onOrBefore(addDays(s, -28)), m3 = onOrBefore(addDays(s, -88));
    if (i + 5 >= N || m1 === undefined || m3 === undefined) return [];
    const inputs = buildTwInputs({ latest: use[i].quotes, week: use[i + 5].quotes, month: use[m1].quotes, quarter: use[m3].quotes, flows: use.slice(i, i + 10).map((d) => d.flows), companies, tpexCodes: use[i].tpexCodes });
    return scoreStocks(inputs.filter((x) => !isEtf(x.code))).scored;
  };
  if (exp4) {
    // 每個交易日收盤記下「買入」名單（和 App 推薦績效同一套）：推薦價＝當日收盤，持有 5／10／20 天，扣買賣手續費與證交稅
    const COST = 0.001425 * 2 + 0.003;
    const maN = (code: string, j: number, n: number) => { let t = 0; for (let k = j - n + 1; k <= j; k++) { const p = px(code, k); if (!(p > 0)) return NaN; t += p; } return t / n; };
    const stops: Record<string, (code: string, entry: number, k: number) => boolean> = {
      "無停損": () => false,
      "−8%（現行）": (code, e, k) => px(code, k) <= e * 0.92,
      "−10%": (code, e, k) => px(code, k) <= e * 0.90,
      "−12%": (code, e, k) => px(code, k) <= e * 0.88,
      "跌破20日線3%": (code, e, k) => px(code, k) < maN(code, k, 20) * 0.97 || px(code, k) <= e * 0.85,
    };
    const weak20 = (j: number) => px(BENCH, j) < maN(BENCH, j, 20);
    const weak60 = (j: number) => !aboveMa60(j);
    const dd5 = (j: number) => { let hi = 0; for (let k = j - 19; k <= j; k++) hi = Math.max(hi, px(BENCH, k) || 0); return px(BENCH, j) < hi * 0.95; };
    type Acc = { n: number; ret: number; ex: number; win: number; beat: number; rets: number[] };
    const acc = new Map<string, Acc>();
    const add = (key: string, r: number, ex: number) => { let a = acc.get(key); if (!a) acc.set(key, (a = { n: 0, ret: 0, ex: 0, win: 0, beat: 0, rets: [] })); a.n++; a.ret += r; a.ex += ex; if (r > 0) a.win++; if (ex > 0) a.beat++; a.rets.push(r); };
    const endA = c.dates.findLastIndex((d) => d <= A_END);
    let days = 0, picks = 0;
    for (let j = j0; j <= endA - 20; j++) {
      const buys = scoredAt(j).filter((x) => x.rating === "買入");
      if (!buys.length) continue;
      days++; picks += buys.length;
      const regimes: [string, boolean][] = [["全部", true], ["大盤強（0050 在 20 日線上）", !weak20(j)], ["大盤弱（0050 跌破 20 日線）", weak20(j)], ["0050 在 60 日線上", !weak60(j)], ["0050 跌破 60 日線", weak60(j)], ["0050 距 20 日高點 <5%", !dd5(j)], ["0050 距 20 日高點 ≥5%", dd5(j)]];
      for (const h of [5, 10, 20]) {
        const b0 = px(BENCH, j), bh = px(BENCH, j + h), bret = b0 > 0 && bh > 0 ? bh / b0 - 1 : NaN;
        if (!Number.isFinite(bret)) continue;
        for (const x of buys) {
          const e = px(x.code, j);
          if (!(e > 0) || !(px(x.code, j + h) > 0)) continue;
          for (const [sk, hit] of Object.entries(stops)) {
            let exitP = px(x.code, j + h);
            for (let k = j + 1; k <= j + h; k++) { const p = px(x.code, k); if (p > 0 && hit(x.code, e, k)) { exitP = p; break; } }
            const r = exitP / e - 1 - COST;
            for (const [rk, on] of regimes) if (on) add(`${h}|${sk}|${rk}`, r, r - bret);
          }
        }
      }
    }
    log(`LBT_EXP4 推薦事件研究：${days} 個推薦日、${picks} 筆推薦（${c.dates[j0]}～${c.dates[endA - 20]}）`);
    const pc2 = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
    for (const h of [5, 10, 20]) for (const rk of ["全部", "大盤強（0050 在 20 日線上）", "大盤弱（0050 跌破 20 日線）", "0050 在 60 日線上", "0050 跌破 60 日線", "0050 距 20 日高點 <5%", "0050 距 20 日高點 ≥5%"]) for (const sk of Object.keys(stops)) {
      const a = acc.get(`${h}|${sk}|${rk}`); if (!a) continue;
      const med = a.rets.sort((x, y) => x - y)[Math.floor(a.rets.length / 2)];
      console.log(`LBT_EXP4 ${h}日｜${rk}｜停損 ${sk}｜筆數 ${a.n}｜平均淨報酬 ${pc2(a.ret / a.n)}｜中位 ${pc2(med)}｜賺錢 ${((a.win / a.n) * 100).toFixed(0)}%｜平均超額(對0050) ${pc2(a.ex / a.n)}｜贏0050 ${((a.beat / a.n) * 100).toFixed(0)}%`);
    }
  }
  if (exp5) {
    // 美股日 K（CNBC，和 App 的國際指標同一個來源）：美股 D 日（美國日期）收盤，就是台北 D+1 早上看到的「前一晚美股」
    const usRet = new Map<string, Map<string, number>>();
    for (const sym of [".IXIC", ".SOX"]) {
      const bars: { date: string; close: number }[] = [];
      for (const y of [2018, 2019, 2020, 2021]) {
        try { const r = await fetch(cnbcBarsUrl(sym, `${y - 1}1220`, `${y}1231`), { headers: { "User-Agent": "Mozilla/5.0" } }); bars.push(...parseCnbcBars(await r.json())); } catch (e) { log(`LBT_EXP5 ${sym} ${y} 下載失敗`, String(e)); }
      }
      const byDate = new Map(bars.map((b) => [b.date, b.close]));
      const ds = [...byDate.keys()].sort(), m = new Map<string, number>();
      for (let i = 1; i < ds.length; i++) m.set(ds[i], byDate.get(ds[i])! / byDate.get(ds[i - 1])! - 1);
      usRet.set(sym, m);
      log(`LBT_EXP5 ${sym} 日 K ${ds.length} 天（${ds[0]}～${ds.at(-1)}）`);
    }
    const COST = 0.001425 * 2 + 0.003;
    const bucket = (r: number | undefined) => r === undefined ? "美股休市" : r <= -0.02 ? "跌 ≥2%" : r <= -0.01 ? "跌 1～2%" : r < 0.01 ? "±1% 內" : r < 0.02 ? "漲 1～2%" : "漲 ≥2%";
    type Acc = { n: number; ret: number; ex: number; win: number; days: Set<string> };
    const acc = new Map<string, Acc>();
    const add = (k: string, r: number, ex: number, d: string) => { let a = acc.get(k); if (!a) acc.set(k, (a = { n: 0, ret: 0, ex: 0, win: 0, days: new Set() })); a.n++; a.ret += r; a.ex += ex; if (r > 0) a.win++; a.days.add(d); };
    const endA = c.dates.findLastIndex((d) => d <= A_END);
    for (let j = j0; j <= endA - 21; j++) {
      const buys = scoredAt(j).filter((x) => x.rating === "買入");
      if (!buys.length) continue;
      const D = c.dates[j], e0 = j + 1; // D 收盤出名單；台北 D+1 早上看到美股 D 日收盤，D+1 收盤買進
      for (const sym of [".IXIC", ".SOX"]) {
        const b = bucket(usRet.get(sym)!.get(D));
        for (const h of [5, 10, 20]) {
          const b0 = px(BENCH, e0), bh = px(BENCH, e0 + h); if (!(b0 > 0 && bh > 0)) continue;
          const bret = bh / b0 - 1;
          for (const x of buys) {
            const e = px(x.code, e0); if (!(e > 0) || !(px(x.code, e0 + h) > 0)) continue;
            let exitP = px(x.code, e0 + h);
            for (let k = e0 + 1; k <= e0 + h; k++) { const p = px(x.code, k); if (p > 0 && p <= e * 0.92) { exitP = p; break; } }
            const r = exitP / e - 1 - COST;
            add(`${sym}|${h}|${b}`, r, r - bret, D);
            add(`${sym}|${h}|全部`, r, r - bret, D);
          }
          // 同一天的台股（D+1）本身怎麼走：開盤跳空後收盤，0050 當天漲跌
        }
        const tw = px(BENCH, e0) / px(BENCH, j) - 1;
        if (Number.isFinite(tw)) add(`${sym}|0050隔天|${b}`, tw, 0, D);
      }
    }
    const pc2 = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
    for (const sym of [".IXIC", ".SOX"]) {
      for (const b of ["全部", "跌 ≥2%", "跌 1～2%", "±1% 內", "漲 1～2%", "漲 ≥2%", "美股休市"]) {
        const t = acc.get(`${sym}|0050隔天|${b}`);
        const parts = [5, 10, 20].map((h) => { const a = acc.get(`${sym}|${h}|${b}`); return a ? `${h}日 平均 ${pc2(a.ret / a.n)}・超額 ${pc2(a.ex / a.n)}・賺錢 ${((a.win / a.n) * 100).toFixed(0)}%` : `${h}日 —`; });
        const a5 = acc.get(`${sym}|5|${b}`);
        console.log(`LBT_EXP5 ${sym === ".IXIC" ? "那斯達克" : "費城半導體"} 前一晚 ${b}｜${a5 ? a5.days.size : 0} 天 ${a5?.n ?? 0} 筆｜${parts.join("｜")}${t ? `｜0050 隔天平均 ${pc2(t.ret / t.n)}` : ""}`);
      }
    }
  }
  const hold0050: Picker = () => new Map([[BENCH, 1]]);
  const mixP = (a: Picker, wa: number, b: Picker): Picker => (j) => {
    const m = new Map<string, number>();
    for (const [code, w] of a(j)) m.set(code, (m.get(code) ?? 0) + w * wa);
    for (const [code, w] of b(j)) m.set(code, (m.get(code) ?? 0) + w * (1 - wa));
    return m;
  };
  type Def = { key: string; label: string; start: "base" | "rev"; opts?: Parameters<typeof simulateLB>[3]; make: () => Picker; bias?: string };
  const defs: Def[] = [
    { key: "N5", label: "N5 觀察（0050 五成＋低波動 A 五成）", start: "base", opts: { every: 1, band: WATCH.minTrade }, make: () => mixP(hold0050, 0.5, (j) => aPicks(c, j)) },
    { key: "A", label: "A 低波動為主＋趨勢為輔", start: "base", make: () => (j) => aPicks(c, j) },
    { key: "W1", label: "W1 全個股（每天局部修正）", start: "base", opts: { every: 1, band: STEADY.wideBand }, make: () => { let held = new Set<string>(); return (j) => { const t = wideTargets(c, j, held); held = new Set(t.keys()); return t; }; } },
    { key: "W2", label: "W2 全個股（每週修正）", start: "base", opts: { every: 5, band: STEADY.wideBand }, make: () => { let held = new Set<string>(); return (j) => { const t = wideTargets(c, j, held); held = new Set(t.keys()); return t; }; } },
    { key: "R1", label: "R1 攻守輪動", start: "base", opts: { every: WATCH.every, band: WATCH.minTrade }, make: () => { let on: boolean | undefined; return (j) => { const r = regimeStep(c, j, on); on = r.on; return r.targets; }; } },
    { key: "Q5", label: "Q5 權值強化（市值前 50）", start: "base", opts: { every: 1, band: LEAD.band }, make: () => (j) => leadTargets(c, j).targets, bias: "資本額為現值" },
    { key: "AI2", label: "AI2 AI 供應鏈依市值（月調）", start: "base", opts: { every: 20, band: LEAD.band }, make: () => (j) => aiTargets(c, j, { weight: "cap" }), bias: "名單事後挑、資本額為現值" },
    { key: "U1", label: "U1 實單規則（買入前 8 檔、成本 -10% 停損）", start: "base", opts: { every: REAL.every, band: WATCH.minTrade, costStop: REAL.stop }, make: () => (j) => realTargets(use, companies, c, j) },
    { key: "BUY", label: "BUY 現行 App「買入」前 10 檔等權", start: "base", make: () => (j) => { const b = scoredAt(j).filter((x) => x.rating === "買入").sort((x, y) => y.score - x.score).slice(0, STEADY.top); return new Map(b.map((x) => [x.code, 1 / STEADY.top])); } },
    { key: "T2", label: "T2 轉強精選", start: "base", opts: { every: 1, band: 0.03 }, make: () => turnPicker(c, { strict: true, regime: true }) },
    { key: "QUAD", label: "QUAD 四因子（等權，最多 20 檔）", start: "rev", make: () => (j) => { const base = scoredAt(j); const k = Math.min(20, base.filter((x) => x.rating === "買入").length); const p = quadPicks(c, j, base, k); return new Map(p.map((x) => [x.code, 1 / Math.max(1, p.length)])); } },
    { key: "G1", label: "G1 成長組單獨", start: "rev", opts: { every: DUAL.every, band: DUAL.band }, make: () => dualPicker(c, 1, 0) },
    { key: "D1", label: "D1 雙引擎（成長五成＋低波動五成）", start: "rev", opts: { every: DUAL.every, band: DUAL.band }, make: () => dualPicker(c, DUAL.growth, DUAL.steady) },
    { key: "D4", label: "D4 雙引擎＋外資條件", start: "rev", opts: { every: DUAL.every, band: DUAL.band }, make: () => dualPicker(c, DUAL.growth, DUAL.steady, 0, { foreignOk: true }) },
  ];

  if (exp) {
    const o = { every: DUAL.every, band: DUAL.band };
    defs.push(
      { key: "G0", label: "G0 驗證：複製版成長組（無濾網，應與 G1 完全一樣）", start: "rev", opts: o, make: () => growthLbPicker(c, 1, 0, false, 4) },
      { key: "G2", label: "G2 成長組＋站上且上彎 60 日線（20 日重選）", start: "rev", opts: o, make: () => growthLbPicker(c, 1, 0, true, 4) },
      { key: "G3", label: "G3 成長組＋走勢濾網，每週重選（跌破 60 日線就換）", start: "rev", opts: o, make: () => growthLbPicker(c, 1, 0, true, 1) },
      { key: "DG2", label: "DG2 雙引擎（成長用 G2）", start: "rev", opts: o, make: () => growthLbPicker(c, 0.5, 0.5, true, 4) },
      { key: "DG3", label: "DG3 雙引擎（成長用 G3）", start: "rev", opts: o, make: () => growthLbPicker(c, 0.5, 0.5, true, 1) },
    );
  }

  if (exp2) {
    const o = { every: DUAL.every, band: DUAL.band };
    const cache = new Map<number, { buy: ReadonlySet<string>; quad: ReadonlySet<string> }>();
    const lists = (j: number) => {
      let x = cache.get(j);
      if (!x) {
        const base = scoredAt(j), buys = base.filter((v) => v.rating === "買入");
        x = { buy: new Set(buys.map((v) => v.code)), quad: new Set(quadPicks(c, j, base, buys.length).map((v) => v.code)) };
        cache.set(j, x);
      }
      return x;
    };
    defs.push(
      { key: "DG0", label: "DG0 驗證：複製版雙引擎（無限定，應與 D1 完全一樣）", start: "rev", opts: o, make: () => growthLbPicker(c, 0.5, 0.5, false, 4) },
      { key: "DB", label: "DB 雙引擎，候選限定當天選股頁「買入」", start: "rev", opts: o, make: () => growthLbPicker(c, 0.5, 0.5, false, 4, (j) => lists(j).buy) },
      { key: "DB4", label: "DB4 雙引擎＋的外資條件加上候選限定「買入」（實際上線的組合，B 已用掉，只看階段 A）", start: "rev", opts: o, make: () => growthLbPicker(c, 0.5, 0.5, false, 4, (j) => lists(j).buy, true) },
      { key: "DQ", label: "DQ 雙引擎，候選限定當天四因子名單", start: "rev", opts: o, make: () => growthLbPicker(c, 0.5, 0.5, false, 4, (j) => lists(j).quad) },
    );
    if (exp6) defs.push(
      { key: "DB4S", label: "DB4S 雙引擎＋（實際上線），低波動組候選不限「買入」（成長組照舊限定）", start: "rev", opts: o, make: () => growthLbPicker(c, 0.5, 0.5, false, 4, (j) => lists(j).buy, true, { steadyAll: true }) },
      { key: "DB4F", label: "DB4F 雙引擎＋（實際上線），低波動組沒用完的權重補給成長組", start: "rev", opts: o, make: () => growthLbPicker(c, 0.5, 0.5, false, 4, (j) => lists(j).buy, true, { fillGrowth: true }) },
      { key: "DB4SF", label: "DB4SF 兩者都做（低波動不限名單＋沒用完的補給成長組）", start: "rev", opts: o, make: () => growthLbPicker(c, 0.5, 0.5, false, 4, (j) => lists(j).buy, true, { steadyAll: true, fillGrowth: true }) },
    );
    if (exp3) defs.push(
      { key: "DB4R", label: "DB4R 雙引擎＋（實際上線）＋達標離場（可買回）", start: "rev", opts: { ...o, takeProfit: { gain: 0.1 } }, make: () => growthLbPicker(c, 0.5, 0.5, false, 4, (j) => lists(j).buy, true) },
      { key: "DB4N", label: "DB4N 雙引擎＋（實際上線）＋達標離場（不買回）", start: "rev", opts: { ...o, takeProfit: { gain: 0.1, noRebuy: true } }, make: () => growthLbPicker(c, 0.5, 0.5, false, 4, (j) => lists(j).buy, true) },
    );
  }

  if (exp3) {
    const o = { every: DUAL.every, band: DUAL.band };
    const r = { ...o, takeProfit: { gain: 0.1 } }, n = { ...o, takeProfit: { gain: 0.1, noRebuy: true } };
    defs.push(
      { key: "D1R", label: "D1R 雙引擎＋達標離場（賣後判斷日名單還有就買回）", start: "rev", opts: r, make: () => dualPicker(c, DUAL.growth, DUAL.steady) },
      { key: "D1N", label: "D1N 雙引擎＋達標離場（賣後不買回，直到名單不含它）", start: "rev", opts: n, make: () => dualPicker(c, DUAL.growth, DUAL.steady) },
    );
  }

  // ---- 對照組 ----
  const eligCache = new Map<number, string[]>();
  const eligible = (j: number) => {
    let x = eligCache.get(j);
    if (!x) { x = [...c.rows[j]].filter(([code, r]) => isCommonStock(code) && r[4] >= 5e8 && (c.series.get(code)?.start ?? 1e9) <= j - 60).map(([code]) => code); eligCache.set(j, x); }
    return x;
  };
  const sims = (start: number) => ({ bench: simulateLB(c, start, hold0050) });
  const benchBy = new Map<number, LbSim>([[j0, sims(j0).bench], [jRev, sims(jRev).bench]]);

  type Row = { key: string; label: string; s: StrategyStats; sim: LbSim; bench: LbSim; start: number; bias?: string };
  const rows: Row[] = [];
  for (const d of defs) {
    const start = d.start === "rev" ? jRev : j0, bench = benchBy.get(start)!;
    const sim = simulateLB(c, start, d.make(), d.opts);
    rows.push({ key: d.key, label: d.label, s: stats(d.key, d.label, c, start, sim, bench.eq), sim, bench, start, bias: d.bias });
    log(`${d.key} 完成`);
  }
  // 等權重（成交金額 ≥5 億普通股，每月調整）
  {
    const eqW: Picker = (j) => { const p = eligible(j); return new Map(p.map((x) => [x, 1 / p.length])); };
    for (const [start, tag] of [[j0, "base"], [jRev, "rev"]] as const) {
      const sim = simulateLB(c, start, eqW, { every: 20, band: 0.002 });
      rows.push({ key: `EW_${tag}`, label: `對照 等權重（成交金額≥5億普通股，月調）起點 ${c.dates[start]}`, s: stats("EW", "EW", c, start, sim, benchBy.get(start)!.eq), sim, bench: benchBy.get(start)!, start });
    }
  }
  rows.push({ key: "0050", label: "0050 買進持有", s: stats("0050", "0050", c, j0, benchBy.get(j0)!, benchBy.get(j0)!.eq), sim: benchBy.get(j0)!, bench: benchBy.get(j0)!, start: j0 });

  if (diag) {
    console.log("LBT_DIAG 階段 A 成本對照（年化；括號為對 0050 超額）：零成本＝毛報酬（只扣不了的：無）／低滑價＝手續費＋稅＋單邊 0.05%／基準＝事前登記的單邊 0.15%");
    for (const r of rows) {
      if (r.key === "0050" || r.key.startsWith("EW")) continue;
      const d = defs.find((x) => x.key === r.key)!;
      const cut = (e: number[]) => { const idx: number[] = []; for (let i = 0; i < e.length; i++) if (c.dates[r.start + i] <= A_END) idx.push(i); return idx.map((i) => e[i]); };
      const b0 = cagr(cut(r.bench.eq));
      const g = simulateLB(c, r.start, d.make(), { ...d.opts, costs: false }), l = simulateLB(c, r.start, d.make(), { ...d.opts, slip: 0.0005 });
      const [cg, cl, cb] = [cagr(cut(g.eq)), cagr(cut(l.eq)), cagr(cut(r.sim.eq))];
      console.log(`LBT_DIAG ${r.key.padEnd(5)} 零成本 ${pc(cg)} (${pc(cg - b0)})｜低滑價 ${pc(cl)} (${pc(cl - b0)})｜基準 ${pc(cb)} (${pc(cb - b0)})｜0050 ${pc(b0)}｜換手 ${r.s.turnover.toFixed(1)}x｜零成本最大回撤 ${pc(maxDd(cut(g.eq)))} (0050 ${pc(maxDd(cut(r.bench.eq)))})`);
    }
  }

  // ---- 隨機選股（每個組合各抽一組：檔數＝該組合平均持股、換股頻率與換手率都配合該組合，才不會因為換手率不同而不公平）----
  const randomFor = (r: Row, every: number) => {
    const k = Math.max(3, Math.min(60, Math.round(r.sim.avgHold))), p = Math.max(0.02, Math.min(1, r.s.turnover / (250 / every)));
    const cagrs: number[] = [], dds: number[] = [];
    for (let s = 0; s < DRAWS; s++) { const e = simulateLB(c, r.start, randomPicker(eligible, k, mulberry32(1000 + s), p), { every }).eq; cagrs.push(cagr(e)); dds.push(maxDd(e)); }
    cagrs.sort((a, b) => a - b); dds.sort((a, b) => a - b);
    return { k, p, cagrs, dds };
  };

  if (exp) {
    const by = new Map(rows.map((r) => [r.key, r]));
    const g0 = by.get("G0"), g1 = by.get("G1");
    console.log(`LBT_EXP 驗證：G0 年化 ${pc(g0!.s.cagr)} 回撤 ${pc(g0!.s.maxDd)}｜G1 年化 ${pc(g1!.s.cagr)} 回撤 ${pc(g1!.s.maxDd)}｜${Math.abs(g0!.s.cagr - g1!.s.cagr) < 1e-9 ? "一致" : "⚠不一致，複製版有差異"}`);
    for (const [k, base] of [["G2", "G1"], ["G3", "G1"], ["DG2", "D1"], ["DG3", "D1"]] as const) {
      const r = by.get(k)!, b = by.get(base)!, d = defs.find((x) => x.key === k)!;
      const g = simulateLB(c, r.start, d.make(), { ...d.opts, costs: false });
      const better = r.s.cagr > b.s.cagr && r.s.maxDd > b.s.maxDd; // maxDd 為負數，越大（越接近 0）越淺
      console.log(`LBT_EXP ${k.padEnd(3)} vs ${base}：成本後年化 ${pc(r.s.cagr)}（${base} ${pc(b.s.cagr)}）｜最大回撤 ${pc(r.s.maxDd)}（${pc(b.s.maxDd)}）｜零成本年化 ${pc(cagr(g.eq))}｜換手 ${r.s.turnover.toFixed(1)}x（${b.s.turnover.toFixed(1)}x）｜平均持股 ${r.sim.avgHold.toFixed(1)}（${b.sim.avgHold.toFixed(1)}）｜事前登記判定（年化較高且回撤較淺）：${better ? "改善" : "沒有改善"}`);
    }
  }

  if (exp2) {
    const by = new Map(rows.map((r) => [r.key, r]));
    const g0 = by.get("DG0"), d1 = by.get("D1");
    console.log(`LBT_EXP2 驗證：DG0 年化 ${pc(g0!.s.cagr)} 回撤 ${pc(g0!.s.maxDd)}｜D1 年化 ${pc(d1!.s.cagr)} 回撤 ${pc(d1!.s.maxDd)}｜${Math.abs(g0!.s.cagr - d1!.s.cagr) < 1e-9 ? "一致" : "⚠不一致，複製版有差異"}`);
    for (const k of ["DB", "DB4", "DQ"] as const) {
      const r = by.get(k)!, b = by.get(k === "DB4" ? "D4" : "D1")!, d = defs.find((x) => x.key === k)!;
      const g = simulateLB(c, r.start, d.make(), { ...d.opts, costs: false });
      const better = r.s.cagr > b.s.cagr && r.s.maxDd > b.s.maxDd;
      console.log(`LBT_EXP2 ${k} vs D1：成本後年化 ${pc(r.s.cagr)}（D1 ${pc(b.s.cagr)}）｜最大回撤 ${pc(r.s.maxDd)}（${pc(b.s.maxDd)}）｜零成本年化 ${pc(cagr(g.eq))}｜換手 ${r.s.turnover.toFixed(1)}x（${b.s.turnover.toFixed(1)}x）｜平均持股 ${r.sim.avgHold.toFixed(1)}（${b.sim.avgHold.toFixed(1)}）｜曝險 ${pc(r.sim.exposure, 0)}（${pc(b.sim.exposure, 0)}）｜事前登記判定（年化較高且回撤較淺）：${better ? "改善" : "沒有改善"}`);
    }
  }

  if (exp3) {
    const by = new Map(rows.map((r) => [r.key, r]));
    const cutA = (r: Row, e: number[]) => e.filter((_, i) => c.dates[r.start + i] <= A_END);
    for (const [k, base] of [["D1R", "D1"], ["D1N", "D1"], ["DB4R", "DB4"], ["DB4N", "DB4"]] as const) {
      const r = by.get(k), b = by.get(base);
      if (!r || !b) continue;
      const [ra, ba] = [cutA(r, r.sim.eq), cutA(b, b.sim.eq)];
      console.log(`LBT_EXP3 ${k.padEnd(4)} vs ${base}：成本後年化 ${pc(cagr(ra))}（${pc(cagr(ba))}）｜最大回撤 ${pc(maxDd(ra))}（${pc(maxDd(ba))}）｜全期間年化 ${pc(r.s.cagr)}（${pc(b.s.cagr)}）｜換手 ${r.s.turnover.toFixed(1)}x（${b.s.turnover.toFixed(1)}x）｜曝險 ${pc(r.sim.exposure, 0)}（${pc(b.sim.exposure, 0)}）｜達標離場賣出 ${(r.sim as any).tpSells} 次｜${cagr(ra) > cagr(ba) && maxDd(ra) > maxDd(ba) ? "年化較高且回撤較淺" : cagr(ra) > cagr(ba) ? "年化較高但回撤沒有較淺" : maxDd(ra) > maxDd(ba) ? "回撤較淺但年化較低" : "年化較低、回撤也沒有較淺"}`);
    }
  }

  if (exp6) {
    const by = new Map(rows.map((r) => [r.key, r]));
    const cutA = (r: Row, e: number[]) => e.filter((_, i) => c.dates[r.start + i] <= A_END);
    const b0 = by.get("0050");
    for (const k of ["DB4", "DB4S", "DB4F", "DB4SF", "D1"] as const) {
      const r = by.get(k), b = by.get("DB4");
      if (!r || !b) continue;
      const [ra, ba, za] = [cutA(r, r.sim.eq), cutA(b, b.sim.eq), cutA(r, r.bench.eq)];
      // 年度報酬（階段 A）：逐年看，避免只看平均
      const years: string[] = [];
      for (let y = Number(c.dates[r.start].slice(0, 4)); y <= Number(A_END.slice(0, 4)); y++) {
        const idx = r.sim.eq.map((_, i) => i).filter((i) => c.dates[r.start + i].startsWith(String(y)));
        if (idx.length < 20) continue;
        const ry = r.sim.eq[idx.at(-1)!] / r.sim.eq[Math.max(0, idx[0] - 1)] - 1, by0 = r.bench.eq[idx.at(-1)!] / r.bench.eq[Math.max(0, idx[0] - 1)] - 1;
        years.push(`${y} ${pc(ry)}(0050 ${pc(by0)})`);
      }
      console.log(`LBT_EXP6 ${k.padEnd(5)}：成本後年化 ${pc(cagr(ra))}（DB4 ${pc(cagr(ba))}，0050 ${pc(cagr(za))}）｜最大回撤 ${pc(maxDd(ra))}（DB4 ${pc(maxDd(ba))}，0050 ${pc(maxDd(za))}）｜平均曝險 ${pc(r.sim.exposure, 0)}（DB4 ${pc(b.sim.exposure, 0)}）｜平均持股 ${r.sim.avgHold.toFixed(1)}｜換手 ${r.s.turnover.toFixed(1)}x｜${k === "DB4" ? "基準" : cagr(ra) > cagr(ba) && maxDd(ra) > maxDd(ba) ? "年化較高且回撤較淺" : cagr(ra) > cagr(ba) ? "年化較高但回撤較深" : maxDd(ra) > maxDd(ba) ? "回撤較淺但年化較低" : "年化較低、回撤也較深"}｜逐年 ${years.join("、")}`);
    }
    if (b0) log("LBT_EXP6 備註：只看階段 A（2019～2021，B 已在 11/17 開封過一次不再開）；樣本只有 3 年，結果只當參考");
  }

  // ---- 判定 ----
  const slice = (r: Row, from: string, to: string) => {
    const idx: number[] = [];
    for (let i = 0; i < r.sim.eq.length; i++) { const d = c.dates[r.start + i]; if (d >= from && d <= to) idx.push(i); }
    return { eq: idx.map((i) => r.sim.eq[i]), bench: idx.map((i) => r.bench.eq[i]), dates: idx.map((i) => c.dates[r.start + i]) };
  };
  const judge = (r: Row, from: string, to: string, windows: [string, string][]) => {
    const x = slice(r, from, to);
    if (x.eq.length < 120) return null;
    const ex = cagr(x.eq) - cagr(x.bench), roll = rollingWin(x.eq, x.bench, 250);
    const ddOk = maxDd(x.eq) >= maxDd(x.bench) - 1e-9;
    const winOk = windows.every(([a, b]) => { const s = ddBetween(x.eq, x.dates, a, b), t = ddBetween(x.bench, x.dates, a, b); return !Number.isFinite(s) || s >= t - 1e-9; });
    const passes = [ex >= 0.03, ddOk, roll.win >= 0.7, winOk];
    return { ex, cg: cagr(x.eq), bcg: cagr(x.bench), dd: maxDd(x.eq), bdd: maxDd(x.bench), roll, passes, ok: passes.every(Boolean) };
  };
  const winA: [string, string][] = [["20181001", "20190104"], ["20200120", "20200331"]];
  const lines: string[] = [];
  for (const r of rows) {
    if (r.key === "0050") continue;
    const j = judge(r, c.dates[r.start], A_END, winA);
    if (!j) { lines.push(`${r.key} 期間太短`); continue; }
    const every = Math.max(5, defs.find((d) => d.key === r.key)?.opts?.every ?? 5);
    const rr = r.key.startsWith("EW") ? null : randomFor(r, every);
    const pct = rr ? percentileOf(rr.cagrs, j.cg) : NaN;
    const rq = (a: number[], q: number) => a[Math.floor(q * (a.length - 1))];
    const cost = r.sim.costPaid / (r.sim.eq.length / 250);
    lines.push(`${r.key.padEnd(7)} 年化 ${pc(j.cg)} (0050 ${pc(j.bcg)}) 超額 ${pc(j.ex)}｜回撤 ${pc(j.dd)} (0050 ${pc(j.bdd)})｜12月滾動勝率 ${pc(j.roll.win, 0)} (${j.roll.n})｜判定 ${j.passes.map((p) => (p ? "✓" : "✗")).join("")} ${j.ok ? "候選" : "淘汰"}｜隨機（${rr ? `${rr.k}檔 換${(rr.p * 100).toFixed(0)}%` : "—"}）中位 ${rr ? pc(rq(rr.cagrs, 0.5)) : "—"} p95 ${rr ? pc(rq(rr.cagrs, 0.95)) : "—"} 策略百分位 ${pc(pct, 0)}｜換手 ${r.s.turnover.toFixed(1)}x/年 成本 ${pc(cost, 2)}/年 漲停買不到 ${r.sim.blockedBuys} 跌停賣不掉 ${r.sim.blockedSells}${r.bias ? "｜⚠" + r.bias : ""}`);
  }
  console.log(`LBT_RUN_SUMMARY 階段 A（${c.dates[j0]}～${A_END}）判定欄依序：超額≥3%／回撤不深於0050／12月滾動≥70%／2018Q4與2020疫情不深於0050`);
  for (const l of lines) console.log(`LBT_RUN ${l}`);

  if (openB) {
    console.log("LBT_RUN_B 階段 B（開封）：只看階段 A 判定為候選者的後續；以下為全部組合的 B 與 C 數字，供完整報告（非候選者已淘汰，不因 B 好看而復活）");
    const winB: [string, string][] = [["20220103", "20221031"]];
    for (const r of rows) {
      if (r.key === "0050") continue;
      const b = judge(r, B_START, B_END, winB), cc = judge(r, "20250203", "99999999", [["20260901", "20261116"]]);
      lines.length = 0;
      console.log(`LBT_RUN_B ${r.key.padEnd(7)} B：${b ? `年化 ${pc(b.cg)} (0050 ${pc(b.bcg)}) 超額 ${pc(b.ex)} 回撤 ${pc(b.dd)} (${pc(b.bdd)}) 滾動勝率 ${pc(b.roll.win, 0)} ${b.passes.map((p) => (p ? "✓" : "✗")).join("")}` : "—"}｜C（參考）：${cc ? `年化 ${pc(cc.cg)} (0050 ${pc(cc.bcg)}) 回撤 ${pc(cc.dd)} (${pc(cc.bdd)})` : "—"}`);
    }
  }
  if (openB && (exp || exp2)) {
    console.log("LBT_B 實驗變體在階段 B（2022/1/3～2025/1/31）對各自基準（事前登記：成本後年化較高且最大回撤較淺，兩項同時成立；只有 G2、DB 有資格）");
    const by = new Map(rows.map((r) => [r.key, r]));
    for (const [k, base, eligible] of [["G2", "G1", true], ["DB", "D1", true], ["G3", "G1", false], ["DG2", "D1", false], ["DG3", "D1", false], ["DQ", "D1", false]] as const) {
      const r = by.get(k), b = by.get(base);
      if (!r || !b) continue;
      const x = slice(r, B_START, B_END), y = slice(b, B_START, B_END);
      const cv = cagr(x.eq), cb = cagr(y.eq), dv = maxDd(x.eq), dbb = maxDd(y.eq);
      const ok = cv > cb && dv > dbb;
      const bear = ddBetween(x.eq, x.dates, "20220103", "20221031"), bearB = ddBetween(x.bench, x.dates, "20220103", "20221031");
      const ab = slice(r, c.dates[r.start], B_END), r3 = rollingWin(ab.eq, ab.bench, 750);
      console.log(`LBT_B ${k} vs ${base}${eligible ? "" : "（階段 A 已淘汰，僅供完整報告）"}｜B 成本後年化 ${pc(cv)}（${base} ${pc(cb)}）｜B 最大回撤 ${pc(dv)}（${pc(dbb)}）｜對基準：${ok ? "驗證通過" : "沒有改善"}｜對 0050：B 年化 ${pc(cagr(x.bench))}、2022 空頭回撤 ${pc(bear)}（0050 ${pc(bearB)}）、A+B 滾動 3 年勝率 ${pc(r3.win, 0)}（${r3.n} 個區間）`);
    }
  }
  fs.writeFileSync("longbt-result.json", JSON.stringify({ stage: openB ? "A+B+C" : "A", rows: rows.map((r) => ({ key: r.key, label: r.label, stats: r.s })) }));
  log("完成");
}
main().catch((e) => { console.error("LBT_FATAL", e); process.exit(1); });
