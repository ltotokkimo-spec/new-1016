// 長期回測實驗：成長組加「走勢濾網」的變體（研究用，不動 steady.ts 的現行規則）。
// 現行成長組（growthPicks）完全沒有價格條件；這裡複製同一套排名，只在候選池多一條：站上且上彎 60 日線（和低波動組 A 同一個濾網）。
import { isCommonStock } from "../data/tw";
import { revFactors } from "./revHist";
import { GROWTH, aPicks, type Ctx, type Picker } from "./steady";

const px = (c: Ctx, code: string, j: number) => { const s = c.series.get(code); return s && j >= s.start && j - s.start < s.adj.length ? s.adj[j - s.start] : NaN; };
const ma = (c: Ctx, code: string, j: number, n: number) => { let t = 0; for (let k = j - n + 1; k <= j; k++) { const p = px(c, code, k); if (!(p > 0)) return NaN; t += p; } return t / n; };

function pctRank(codes: string[], vals: number[]): Map<string, number> {
  const idx = codes.map((_, i) => i).filter((i) => Number.isFinite(vals[i])).sort((a, b) => vals[a] - vals[b]);
  const out = new Map<string, number>();
  idx.forEach((i, r) => out.set(codes[i], idx.length > 1 ? r / (idx.length - 1) : 0.5));
  return out;
}
function capWeights(w: number[], maxW: number): number[] {
  const out = [...w], tot = w.reduce((a, x) => a + x, 0);
  for (let it = 0; it < out.length; it++) {
    const over = out.reduce((a, x) => a + Math.max(0, x - maxW * tot), 0);
    if (over <= 1e-12) break;
    const free = out.reduce((a, x) => a + (x < maxW * tot ? x : 0), 0);
    for (let i = 0; i < out.length; i++) out[i] = out[i] >= maxW * tot ? maxW * tot : out[i] + (free > 0 ? (over * out[i]) / free : 0);
  }
  return out;
}

/** 和 steady.ts 的 growthPicks 相同；trend＝true 時候選池只留「站上且上彎 60 日線」的（已持有的也要通過，等於跌破就換掉） */
export function growthPicksLB(c: Ctx, j: number, held: ReadonlySet<string>, trend: boolean): { code: string; weight: number }[] {
  if (!c.rev || j < GROWTH.minHistory) return [];
  const uni: string[] = [];
  for (const [code, row] of c.rows[j]) {
    if (!isCommonStock(code) || !(row[2] > 0)) continue;
    let t = 0, ok = true;
    for (let k = j - 19; k <= j; k++) { const r = c.rows[k]?.get(code); if (!r) { ok = false; break; } t += r[4]; }
    if (!ok || !(t / 20 >= GROWTH.minValue)) continue;
    if (!(px(c, code, j - GROWTH.minHistory) > 0)) continue;
    if (trend) { const p = px(c, code, j), m = ma(c, code, j, 60), mb = ma(c, code, j - 20, 60); if (!(p > m) || !(m > mb)) continue; }
    uni.push(code);
  }
  const rf = uni.map((code) => revFactors(c.rev!, code, c.dates[j]));
  const flow = uni.map((code) => {
    let f = 0, v = 0;
    for (let k = j - GROWTH.flowDays + 1; k <= j; k++) { f += c.flows[k]?.get(code)?.[1] ?? 0; v += c.rows[k]?.get(code)?.[5] ?? 0; }
    return v > 0 ? f / v : NaN;
  });
  const ranks = [pctRank(uni, rf.map((x) => x?.yoy3 ?? NaN)), pctRank(uni, rf.map((x) => x?.newHigh ?? NaN)), pctRank(uni, flow)];
  const scored: { code: string; score: number }[] = [];
  uni.forEach((code) => {
    const r = ranks.map((m) => m.get(code));
    if (r.every((x) => x !== undefined)) scored.push({ code, score: (r[0]! + r[1]! + r[2]!) / 3 });
  });
  scored.sort((a, b) => b.score - a.score || (a.code < b.code ? -1 : 1));
  const per = new Map<string, number>(), chosen: typeof scored = [];
  const take = (x: (typeof scored)[number]) => {
    const sec = c.sector.get(x.code) ?? "其他";
    if ((per.get(sec) ?? 0) >= GROWTH.perSector) return;
    per.set(sec, (per.get(sec) ?? 0) + 1); chosen.push(x);
  };
  scored.forEach((x, rank) => { if (chosen.length < GROWTH.top && held.has(x.code) && rank < GROWTH.keep) take(x); });
  for (const x of scored) { if (chosen.length >= GROWTH.top) break; if (!chosen.includes(x)) take(x); }
  if (!chosen.length) return [];
  const raw = chosen.map((x) => Math.sqrt(Math.max(0, (c.capital.get(x.code) ?? 0) * (c.rows[j].get(x.code)?.[2] ?? 0))));
  const tot = raw.reduce((a, b) => a + b, 0);
  const w = capWeights(tot > 0 ? raw.map((x) => x / tot) : raw.map(() => 1 / raw.length), GROWTH.maxWeight);
  return chosen.map((x, k) => ({ code: x.code, weight: w[k] }));
}

/** 成長 wG＋低波動 A wA；每 5 個交易日呼叫一次，成長組每 reselectEvery 次重選（4＝每 20 個交易日、1＝每週） */
export function growthLbPicker(c: Ctx, wG: number, wA: number, trend: boolean, reselectEvery: number): Picker {
  let last: { code: string; weight: number }[] | null = null, n = 0;
  return (j) => {
    if (!last || n % reselectEvery === 0) last = growthPicksLB(c, j, new Set((last ?? []).map((x) => x.code)), trend);
    n++;
    const m = new Map<string, number>();
    for (const x of last) m.set(x.code, (m.get(x.code) ?? 0) + x.weight * wG);
    if (wA) for (const [k, v] of aPicks(c, j)) m.set(k, (m.get(k) ?? 0) + v * wA);
    return m;
  };
}
