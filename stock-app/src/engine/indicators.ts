// 技術指標（給詳情頁 K 線圖用）：均線、KD(9,3,3)、MACD(12,26,9)、RSI(14，Wilder)。
// 都回傳和輸入等長的陣列，資料不足的位置是 NaN。
export interface Ohlc { high: number; low: number; close: number }

export function smaSeries(values: number[], n: number): number[] {
  const out = values.map(() => NaN);
  let sum = 0;
  values.forEach((v, i) => {
    sum += v;
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  });
  return out;
}

function emaSeries(values: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out = values.map(() => NaN);
  let prev = NaN;
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    prev = Number.isFinite(prev) ? prev + k * (v - prev) : v;
    out[i] = prev;
  });
  return out;
}

/** 台灣常用的 KD：RSV 取 9 根，K、D 各以 1/3 權重平滑，起始值 50 */
export function kdSeries(bars: Ohlc[], n = 9): { k: number[]; d: number[] } {
  const k: number[] = [], d: number[] = [];
  let pk = 50, pd = 50;
  bars.forEach((_, i) => {
    if (i < n - 1) { k.push(NaN); d.push(NaN); return; }
    const win = bars.slice(i - n + 1, i + 1);
    const hi = Math.max(...win.map((b) => b.high)), lo = Math.min(...win.map((b) => b.low));
    const rsv = hi > lo ? ((bars[i].close - lo) / (hi - lo)) * 100 : 50;
    pk = (2 / 3) * pk + rsv / 3;
    pd = (2 / 3) * pd + pk / 3;
    k.push(pk); d.push(pd);
  });
  return { k, d };
}

export function macdSeries(closes: number[], fast = 12, slow = 26, sig = 9): { dif: number[]; macd: number[]; osc: number[] } {
  const ef = emaSeries(closes, fast), es = emaSeries(closes, slow);
  const dif = closes.map((_, i) => (i >= slow - 1 ? ef[i] - es[i] : NaN));
  // 訊號線只用 DIF 有值的部分
  const first = dif.findIndex(Number.isFinite);
  const macd = closes.map(() => NaN);
  if (first >= 0) emaSeries(dif.slice(first), sig).forEach((v, j) => { if (j >= sig - 1) macd[first + j] = v; });
  const osc = dif.map((v, i) => (Number.isFinite(v) && Number.isFinite(macd[i]) ? v - macd[i] : NaN));
  return { dif, macd, osc };
}

export function rsiSeries(closes: number[], n = 14): number[] {
  const out = closes.map(() => NaN);
  if (closes.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const c = closes[i] - closes[i - 1]; if (c >= 0) gain += c; else loss -= c; }
  gain /= n; loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < closes.length; i++) {
    const c = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(c, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-c, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}
