// 因子分析：每一個評等日，把每個因子（動能、外資籌碼、族群、一些候選新因子）跟之後 5 天、20 天的報酬比一比，
// 看這個因子有沒有預測力：每天算「排名相關係數（IC）」與「五等分組的報酬差」，再分大盤多空、前後半段看穩不穩。
// 純計算，資料由 GitHub Actions 的回測一起下載（tools/backtest.ts 會順便輸出 factors.json）；只做研究，不影響 App 的評分。
import { buildTwInputs } from "../data/twLoader";
import { isEtf, type Company } from "../data/tw";
import { addDays } from "../lib/dates";
import type { BtDay } from "./backtest";
import { percentiles, scoreStocks, type Scored } from "./score";

export const FACTOR_HORIZONS = [5, 20] as const;
export type FH = (typeof FACTOR_HORIZONS)[number];

export interface FactorDef { key: string; label: string; group: string; value: (s: Scored) => number }

const trustRatio = (s: Scored) => (s.trust5 !== undefined && s.value > 0 ? (s.trust5 * s.close) / (s.value * 5) : NaN);

/** 現有分數的每一項，加上幾個候選新因子（反轉、剔除最近一週的中期動能、流動性） */
export const FACTORS: FactorDef[] = [
  { key: "score", label: "總分", group: "現有分數", value: (s) => s.score },
  { key: "momentum", label: "動能分數", group: "現有分數", value: (s) => s.momentum },
  { key: "flow", label: "外資籌碼分數", group: "現有分數", value: (s) => s.flow },
  { key: "sector", label: "族群分數", group: "現有分數", value: (s) => s.sectorScore },
  { key: "ret1w", label: "近1週漲幅", group: "動能子項", value: (s) => s.ret1w },
  { key: "ret1m", label: "近1月漲幅", group: "動能子項", value: (s) => s.ret1m },
  { key: "ret3m", label: "近3月漲幅", group: "動能子項", value: (s) => s.ret3m },
  { key: "foreign", label: "外資5日買超佔成交比", group: "籌碼子項", value: (s) => s.foreignRatio5 ?? NaN },
  { key: "streak", label: "外資連續買超天數", group: "籌碼子項", value: (s) => s.foreignStreak ?? NaN },
  { key: "trust", label: "投信5日買超佔成交比", group: "籌碼子項", value: trustRatio },
  { key: "rev1w", label: "反轉：近1週跌幅（愈跌愈高分）", group: "候選新因子", value: (s) => -s.ret1w },
  { key: "rev1m", label: "反轉：近1月跌幅（愈跌愈高分）", group: "候選新因子", value: (s) => -s.ret1m },
  { key: "rev1d", label: "反轉：今日跌幅（愈跌愈高分）", group: "候選新因子", value: (s) => -(s.chg1d ?? NaN) },
  { key: "mid", label: "中期動能（近3月減近1月，剔除近期）", group: "候選新因子", value: (s) => s.ret3m - s.ret1m },
  { key: "liq", label: "流動性（當日成交金額）", group: "候選新因子", value: (s) => s.value },
];

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const std = (xs: number[]) => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

/** 排名相關係數（Spearman）：只用兩邊都有值的股票，少於 20 檔回傳 NaN */
export function rankIC(xs: number[], ys: number[]): number {
  const px: number[] = [], py: number[] = [];
  xs.forEach((x, i) => { if (Number.isFinite(x) && Number.isFinite(ys[i])) { px.push(x); py.push(ys[i]); } });
  if (px.length < 20) return NaN;
  const a = percentiles(px), b = percentiles(py);
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
}

/** 依因子值由低到高分成 5 等分，回傳每一組「平均報酬 − 當天全部平均」；某組沒有股票回傳 NaN */
export function quintileExcess(xs: number[], ys: number[]): number[] {
  const px: number[] = [], py: number[] = [];
  xs.forEach((x, i) => { if (Number.isFinite(x) && Number.isFinite(ys[i])) { px.push(x); py.push(ys[i]); } });
  if (px.length < 20) return [NaN, NaN, NaN, NaN, NaN];
  const p = percentiles(px), all = mean(py);
  const buckets: number[][] = [[], [], [], [], []];
  p.forEach((v, i) => buckets[Math.min(4, Math.floor(v * 5))].push(py[i]));
  return buckets.map((b) => (b.length ? mean(b) - all : NaN));
}

export interface FactorSlice { days: number; ic: number; icT: number; hit: number; q: number[]; spread: number }
export interface FactorStat extends FactorSlice {
  icStd: number;
  up?: FactorSlice; down?: FactorSlice; // 當天大盤近 1 月上漲／下跌
  first?: FactorSlice; second?: FactorSlice; // 期間前半段／後半段
}
export interface FactorRow { key: string; label: string; group: string; h: Partial<Record<FH, FactorStat>> }
export interface FactorResult {
  version: 1;
  generatedAt: number;
  from: string; to: string; // 第一個／最後一個評等日
  days: number; // 評等日數（每天都算，所以 20 日報酬彼此重疊）
  upDays: number; downDays: number; // 評等日當天大盤（全市場近 1 月漲幅中位數）上漲／下跌的天數
  factors: FactorRow[];
}

interface Daily { date: string; up: boolean; ic: number; q: number[] }

/** 把每天的 IC 與五等分彙總；步長 1 天時 h 日報酬互相重疊，t 值用「天數 ÷ h」當有效樣本數，避免高估 */
function slice(ds: Daily[], h: number): FactorSlice {
  const ics = ds.map((d) => d.ic).filter(Number.isFinite);
  const spreads = ds.map((d) => d.q[4] - d.q[0]).filter(Number.isFinite);
  const nEff = Math.max(1, ics.length / h);
  const sd = std(ics);
  return {
    days: ics.length,
    ic: mean(ics),
    icT: sd > 0 ? mean(ics) / (sd / Math.sqrt(nEff)) : NaN,
    hit: ics.length ? ics.filter((x) => x > 0).length / ics.length : NaN,
    q: [0, 1, 2, 3, 4].map((k) => mean(ds.map((d) => d.q[k]).filter(Number.isFinite))),
    spread: mean(spreads),
  };
}

/**
 * days：新到舊、連續的交易日（和 runBacktest 一樣）。每個交易日都當評等日（需要往前 28／88 天的價格，往後 h 天的報酬）。
 * 之後的報酬用每天的「漲跌」連乘，除權息不會被算成下跌。
 */
export function runFactors(days: BtDay[], companies: Company[], opts: { step?: number; now?: number } = {}): FactorResult {
  const step = opts.step ?? 1;
  const byDay = days.map((d) => new Map(d.quotes.map((r) => [r[0], r])));
  const dateIdx = new Map(days.map((d, i) => [d.date, i]));
  const idxOnOrBefore = (ymd: string) => {
    for (let k = 0; k < 10; k++) { const i = dateIdx.get(addDays(ymd, -k)); if (i !== undefined) return i; }
    return undefined;
  };
  const fwd = (code: string, i: number, h: number) => {
    if (i - h < 0) return NaN;
    let g = 1;
    for (let t = i - 1; t >= i - h; t--) {
      const r = byDay[t].get(code);
      if (!r) continue;
      const [, , close, change] = r;
      const ref = close - change;
      g *= Number.isFinite(change) && ref > 0 ? close / ref : 1;
    }
    return g - 1;
  };

  const acc = new Map<string, Partial<Record<FH, Daily[]>>>(FACTORS.map((f) => [f.key, {}]));
  const dates: string[] = [];
  let upDays = 0, downDays = 0;
  for (let i = FACTOR_HORIZONS[0]; i < days.length; i += step) {
    const s = days[i].date;
    const w = i + 5;
    const m1 = idxOnOrBefore(addDays(s, -28));
    const m3 = idxOnOrBefore(addDays(s, -88));
    if (w >= days.length || m1 === undefined || m3 === undefined || i + 10 > days.length) continue;
    const inputs = buildTwInputs({
      latest: days[i].quotes, week: days[w].quotes, month: days[m1].quotes, quarter: days[m3].quotes,
      flows: days.slice(i, i + 10).map((d) => d.flows), companies, tpexCodes: days[i].tpexCodes,
    });
    const { scored } = scoreStocks(inputs.filter((x) => !isEtf(x.code)));
    if (scored.length < 30) continue;
    const m1s = scored.map((x) => x.ret1m).filter(Number.isFinite).sort((a, b) => a - b);
    const up = m1s[m1s.length >> 1] > 0;
    dates.push(s);
    if (up) upDays++; else downDays++;
    for (const h of FACTOR_HORIZONS) {
      if (i - h < 0) continue;
      const rs = scored.map((x) => fwd(x.code, i, h));
      for (const f of FACTORS) {
        const xs = scored.map(f.value);
        ((acc.get(f.key)!)[h] ??= []).push({ date: s, up, ic: rankIC(xs, rs), q: quintileExcess(xs, rs) });
      }
    }
  }

  const sorted = [...dates].sort();
  const mid = sorted[sorted.length >> 1];
  const factors: FactorRow[] = FACTORS.map((f) => {
    const row: FactorRow = { key: f.key, label: f.label, group: f.group, h: {} };
    for (const h of FACTOR_HORIZONS) {
      const ds = acc.get(f.key)![h];
      if (!ds?.length) continue;
      const part = (pick: (d: Daily) => boolean) => { const x = ds.filter(pick); return x.length >= 3 ? slice(x, h) : undefined; };
      row.h[h] = {
        ...slice(ds, h), icStd: std(ds.map((d) => d.ic).filter(Number.isFinite)),
        up: part((d) => d.up), down: part((d) => !d.up),
        first: part((d) => d.date < mid), second: part((d) => d.date >= mid),
      };
    }
    return row;
  });
  return { version: 1, generatedAt: opts.now ?? Date.now(), from: sorted[0] ?? "", to: sorted[sorted.length - 1] ?? "", days: dates.length, upDays, downDays, factors };
}

const pc = (x: number | undefined, d = 1) => (x === undefined || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);
const nn = (x: number | undefined, d = 3) => (x === undefined || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}`);

/** 給 Actions 紀錄看的文字表：IC > 0 代表因子愈高、之後愈會漲；|t| ≥ 2 才算比較有把握 */
export function formatFactors(r: FactorResult): string[] {
  const out = [`因子分析：${r.from} ~ ${r.to}，${r.days} 個評等日（大盤近1月上漲 ${r.upDays} 天、下跌 ${r.downDays} 天）`];
  for (const h of FACTOR_HORIZONS) {
    out.push(`-- ${h} 日報酬（IC＝每天的排名相關係數平均；Q1~Q5＝由低到高五組相對全部平均的報酬；多空差＝Q5−Q1）`);
    for (const f of r.factors) {
      const x = f.h[h];
      if (!x) continue;
      out.push(`${f.group}｜${f.label}｜IC ${nn(x.ic)}（t ${nn(x.icT, 1)}，>0 的天數 ${Math.round(x.hit * 100)}%）｜Q1 ${pc(x.q[0])} Q3 ${pc(x.q[2])} Q5 ${pc(x.q[4])}｜多空差 ${pc(x.spread)}｜大盤漲 ${nn(x.up?.ic)} 跌 ${nn(x.down?.ic)}｜前半 ${nn(x.first?.ic)} 後半 ${nn(x.second?.ic)}`);
    }
  }
  return out;
}
