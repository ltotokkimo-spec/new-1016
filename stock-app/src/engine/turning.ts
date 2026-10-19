// 「剛轉強」：股價剛站上 20 日線（還沒漲遠）、MACD 最近幾天由負轉正、RSI 沒過熱、法人在買。
// 需要每檔約 3 個月以上的每日收盤，App 沒有這麼多資料，所以由 GitHub Actions 每天的回測一起算好（tools/backtest.ts），
// App 下載 backtest.json 裡的 turning 欄位顯示。純計算、可測試。
import type { BtDay } from "./backtest";
import { isEtf } from "../data/tw";
import { MIN_VALUE } from "./score";

export const TURN_RULES = {
  maxGap20: 0.05, // 離 20 日線最多 +5%
  ma60Slack: 0.02, // 收盤不低於 60 日線 −2%（在上方或剛站回）
  turnWithin: 5, // MACD 柱狀體在最近 5 個交易日內由負轉正
  maxRsi: 70,
} as const;

export interface TurnPick {
  code: string;
  name: string;
  close: number;
  ma20: number;
  ma60: number;
  gap20: number; // 收盤離 20 日線（小數）
  rsi: number;
  turnedAgo: number; // MACD 翻正幾天了（0 = 今天）
  flow5: number; // 外資＋投信近 5 日買賣超（股）
  stop: number; // 停損參考價
}

export interface Indicators { ma20: number[]; ma60: number[]; osc: number[]; rsi: number[]; upper: number[] }

const sma = (xs: number[], n: number) => xs.map((_, i) => {
  if (i < n - 1) return NaN;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += xs[k];
  return s / n;
});
const ema = (xs: number[], n: number) => {
  const a = 2 / (n + 1), out: number[] = [];
  xs.forEach((x, i) => out.push(i === 0 ? x : a * x + (1 - a) * out[i - 1]));
  return out;
};

/** closes：舊到新、已還原權息的收盤（沒有缺值） */
export function indicators(closes: number[]): Indicators {
  const ma20 = sma(closes, 20), ma60 = sma(closes, 60);
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const dif = closes.map((_, i) => e12[i] - e26[i]);
  const sig = ema(dif, 9);
  const osc = dif.map((d, i) => d - sig[i]);
  // RSI(14)：Wilder 平滑
  const rsi = closes.map(() => NaN);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= 14) { g += up / 14; l += dn / 14; } else { g = (g * 13 + up) / 14; l = (l * 13 + dn) / 14; }
    if (i >= 14) rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  const upper = closes.map((_, i) => {
    if (i < 19) return NaN;
    const w = closes.slice(i - 19, i + 1), m = ma20[i];
    return m + 2 * Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / 20);
  });
  return { ma20, ma60, osc, rsi, upper };
}

/**
 * days：新到舊。回傳每檔「舊到新」的還原收盤（用每天的漲跌連乘，除權息不會變成缺口），
 * 從該股第一次出現開始；停牌的日子沿用前一天。pos[j] 對應 days[N-1-j]。
 */
export function adjustedSeries(days: BtDay[]): Map<string, { start: number; adj: number[] }> {
  const N = days.length, out = new Map<string, { start: number; adj: number[] }>();
  for (let j = 0; j < N; j++) {
    for (const [code, , close, change] of days[N - 1 - j].quotes) {
      if (!(close > 0)) continue;
      const s = out.get(code);
      if (!s) { out.set(code, { start: j, adj: [close] }); continue; }
      while (s.start + s.adj.length < j) s.adj.push(s.adj[s.adj.length - 1]); // 停牌
      const ref = close - change, prev = s.adj[s.adj.length - 1];
      s.adj.push(Number.isFinite(change) && ref > 0 ? prev * (close / ref) : prev);
    }
  }
  return out;
}

/** 在 days[i]（新到舊的索引）那天找出「剛轉強」的股票 */
export function turningAt(days: BtDay[], i: number, series = adjustedSeries(days), ind = new Map<string, Indicators>()): TurnPick[] {
  const N = days.length, j = N - 1 - i;
  const flow = new Map<string, number>();
  for (const d of days.slice(i, i + 5)) for (const [code, f, t] of d.flows) flow.set(code, (flow.get(code) ?? 0) + (f || 0) + (t || 0));
  const picks: TurnPick[] = [];
  for (const [code, name, close, , value] of days[i].quotes) {
    if (isEtf(code) || !(close > 0) || !(value >= MIN_VALUE.TW)) continue;
    const s = series.get(code);
    if (!s) continue;
    const p = j - s.start;
    if (p < 80 || p >= s.adj.length) continue; // 至少 80 天資料，MACD 才穩定
    let x = ind.get(code);
    if (!x) { x = indicators(s.adj); ind.set(code, x); }
    const c = s.adj[p], f = close / c; // 還原價 → 實際價的比例
    const ma20 = x.ma20[p], ma60 = x.ma60[p], rsi = x.rsi[p];
    const gap20 = c / ma20 - 1;
    if (!(gap20 > 0 && gap20 <= TURN_RULES.maxGap20)) continue;
    if (!(c >= ma60 * (1 - TURN_RULES.ma60Slack))) continue;
    if (!(rsi < TURN_RULES.maxRsi) || !(c <= x.upper[p])) continue;
    if (!(x.osc[p] > 0)) continue;
    let k = 1;
    while (k <= TURN_RULES.turnWithin && x.osc[p - k] > 0) k++;
    if (k > TURN_RULES.turnWithin) continue; // 翻正太久了，不算「剛」
    const fl = flow.get(code) ?? 0;
    if (!(fl > 0)) continue;
    const base = Math.min(ma20, ma60) * 0.98 * f;
    const stop = Math.min(Math.max(base, close * 0.92), close * 0.97);
    picks.push({ code, name, close, ma20: ma20 * f, ma60: ma60 * f, gap20, rsi, turnedAgo: k - 1, flow5: fl, stop: Math.round(stop * 100) / 100 });
  }
  return picks.sort((a, b) => a.gap20 - b.gap20);
}
