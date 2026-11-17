// 長期回測引擎（研究用，不影響 App 與每日回測）：沿用 steady.ts 的 Ctx 與各組合選股規則，
// 但模擬改成「全扣成本」：手續費＋證交稅＋滑價（保守估），漲停買不到、跌停賣不掉（隔天再試）。
// 規則與驗收標準事先寫在 stock-app/longbt/PREREG.md，跑結果之後不得調整。
import { isEtf } from "../data/tw";
import type { Ctx, Picker, SimOpts } from "./steady";

export const LB = {
  fee: 0.001425, taxStock: 0.003, taxEtf: 0.001,
  slipStock: 0.0015, slipEtf: 0.0005, // 單邊滑價（零股折讓、買賣價差；保守估）
  limit: 0.094, // 單日漲跌超過 9.4% 視為漲停／跌停：漲停買不到、跌停賣不掉
} as const;

const px = (c: Ctx, code: string, j: number) => {
  const s = c.series.get(code);
  return s && j >= s.start && j - s.start < s.adj.length ? s.adj[j - s.start] : NaN;
};
const ret = (c: Ctx, code: string, j: number) => { const a = px(c, code, j), b = px(c, code, j - 1); return a > 0 && b > 0 ? a / b - 1 : NaN; };
const ma = (c: Ctx, code: string, j: number, n: number) => {
  let t = 0;
  for (let k = j - n + 1; k <= j; k++) { const p = px(c, code, k); if (!(p > 0)) return NaN; t += p; }
  return t / n;
};

export interface LbSim { eq: number[]; traded: number; costPaid: number; blockedBuys: number; blockedSells: number; avgHold: number; exposure: number }

/** 逐日模擬：第 j 天收盤決定，第 j+1 天收盤成交（從 j+2 起承擔漲跌）。含手續費、證交稅、滑價；漲停買不到、跌停賣不掉 */
export function simulateLB(c: Ctx, j0: number, pick: Picker, opts: SimOpts & { costs?: boolean; slip?: number } = {}): LbSim {
  const costs = opts.costs !== false;
  const slipS = opts.slip ?? LB.slipStock, slipE = opts.slip === undefined ? LB.slipEtf : opts.slip / 3; // slip：對照診斷用的股票單邊滑價（ETF 取三分之一）
  const buyCost = (code: string) => (costs ? LB.fee + (isEtf(code) ? slipE : slipS) : 0);
  const sellCost = (code: string) => (costs ? LB.fee + (isEtf(code) ? LB.taxEtf + slipE : LB.taxStock + slipS) : 0);
  const hold = new Map<string, { v: number; peak: number; atr: number; entry?: number }>();
  let cash = 1, traded = 0, costPaid = 0, holdN = 0, expo = 0, blockedBuys = 0, blockedSells = 0;
  let pending: Map<string, number> | null = null;
  const stopOut = new Set<string>();
  const eq: number[] = [];
  const total0 = () => cash + [...hold.values()].reduce((a, h) => a + h.v, 0);
  for (let j = j0; j < c.N; j++) {
    for (const [code, h] of hold) {
      const r = ret(c, code, j);
      if (Number.isFinite(r)) h.v *= 1 + r;
      h.peak = Math.max(h.peak, px(c, code, j));
    }
    // 執行昨天決定的交易（今天收盤價）
    for (const code of [...stopOut]) {
      const h = hold.get(code); if (!h) { stopOut.delete(code); continue; }
      if (ret(c, code, j) <= -LB.limit) { blockedSells++; continue; } // 跌停賣不掉，明天再試
      cash += h.v * (1 - sellCost(code)); costPaid += h.v * sellCost(code); traded += h.v; hold.delete(code); stopOut.delete(code);
    }
    if (pending) {
      const total = total0();
      const keep = new Map<string, number>(); // 賣不掉的，明天再試
      for (const [code, h] of [...hold]) {
        const want = (pending.get(code) ?? 0) * total;
        if (want < h.v) {
          if (opts.band && want > 1e-12 && h.v - want < opts.band * total) continue;
          if (ret(c, code, j) <= -LB.limit) { blockedSells++; keep.set(code, pending.get(code) ?? 0); continue; }
          const sell = h.v - want; cash += sell * (1 - sellCost(code)); costPaid += sell * sellCost(code); traded += sell; h.v = want;
          if (want <= 1e-12) hold.delete(code);
        }
      }
      for (const [code, w] of pending) {
        const want = w * total, have = hold.get(code)?.v ?? 0;
        if (want > have + 1e-12) {
          if (opts.band && want - have < opts.band * total) continue;
          if (ret(c, code, j) >= LB.limit) { blockedBuys++; continue; } // 漲停買不到，這次放棄（下次判斷日再說）
          const buy = Math.min(want - have, cash / (1 + buyCost(code)));
          if (buy <= 0) continue;
          cash -= buy * (1 + buyCost(code)); costPaid += buy * buyCost(code); traded += buy;
          const r20: number[] = [];
          for (let k = j - 19; k <= j; k++) { const r = ret(c, code, k); if (Number.isFinite(r)) r20.push(Math.abs(r)); }
          const h = hold.get(code) ?? { v: 0, peak: px(c, code, j), atr: r20.length ? r20.reduce((a, b) => a + b, 0) / r20.length : 0.02, entry: px(c, code, j) };
          h.v += buy; hold.set(code, h);
        }
      }
      pending = keep.size ? keep : null;
    }
    const total = total0();
    eq.push(total);
    holdN += hold.size; expo += total > 0 ? 1 - cash / total : 0;
    if (opts.stops) for (const [code, h] of hold) {
      const p = px(c, code, j);
      if (p < ma(c, code, j, 60) || p < h.peak * (1 - 2.5 * h.atr)) stopOut.add(code);
    }
    if (opts.costStop) for (const [code, h] of hold) {
      if (h.entry && px(c, code, j) < h.entry * (1 - opts.costStop)) stopOut.add(code);
    }
    if ((j - j0) % (opts.every ?? 5) === 0 && j < c.N - 1) pending = pick(j);
  }
  return { eq, traded, costPaid, blockedBuys, blockedSells, avgHold: holdN / eq.length, exposure: expo / eq.length };
}

// ---------- 指標 ----------
export const maxDd = (xs: number[]) => { let pk = xs[0], m = 0; for (const x of xs) { pk = Math.max(pk, x); m = Math.min(m, x / pk - 1); } return m; };
export const cagr = (xs: number[]) => (xs.length > 1 ? (xs[xs.length - 1] / xs[0]) ** (250 / (xs.length - 1)) - 1 : NaN);

/** 滾動區間：每 step 天一個、長 len 天；回傳策略贏過基準的比例與區間數 */
export function rollingWin(eq: number[], bench: number[], len: number, step = 20): { win: number; n: number } {
  let w = 0, n = 0;
  for (let i = 0; i + len < eq.length; i += step) { n++; if (eq[i + len] / eq[i] > bench[i + len] / bench[i]) w++; }
  return { win: n ? w / n : NaN, n };
}

/** 某段日期內的最大回撤（含該段第一天） */
export function ddBetween(eq: number[], dates: string[], from: string, to: string): number {
  const xs = eq.filter((_, i) => dates[i] >= from && dates[i] <= to);
  return xs.length > 1 ? maxDd(xs) : NaN;
}

// ---------- 隨機選股對照 ----------
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** 隨機選股：每個判斷日從「成交金額夠大的普通股」抽 k 檔等權。replaceP＝每次判斷日每檔被換掉的機率（用來讓換手率和被比較的策略一樣；1＝全部重抽） */
export function randomPicker(eligible: (j: number) => string[], k: number, rnd: () => number, replaceP = 1): Picker {
  let held: string[] = [];
  return (j) => {
    const pool = eligible(j), ok = new Set(pool);
    const set = new Set(held.filter((x) => ok.has(x) && rnd() >= replaceP));
    const want = Math.min(k, pool.length);
    while (set.size < want) set.add(pool[Math.floor(rnd() * pool.length)]);
    held = [...set];
    return new Map(held.map((x) => [x, 1 / k]));
  };
}

export function percentileOf(sorted: number[], x: number): number {
  let n = 0;
  for (const v of sorted) if (v < x) n++;
  return sorted.length ? n / sorted.length : NaN;
}
