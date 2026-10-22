// 評分引擎：動能、外資籌碼、族群強弱 → 0~100 分與「買入／觀望／離場」評等。
// 規則全部寫在這裡、可測試，App 顯示的理由也從這裡產生，不是黑箱。

export type Rating = "買入" | "觀望" | "離場";

export interface StockInput {
  code: string;
  name: string;
  market: "TWSE" | "TPEX" | "US";
  sector: string;
  close: number;
  value: number; // 當日成交金額（台幣或美元）
  ret1w: number; // 小數，0.05 = +5%
  ret1m: number;
  ret3m: number;
  chg1d?: number; // 最近一個交易日的漲跌幅（小數）
  // 台股才有（美股為 undefined）
  foreign5?: number; // 外資近 5 日買賣超（股）
  foreign10?: number;
  foreignStreak?: number; // 外資連續買超天數（負數＝連續賣超）
  trust5?: number; // 投信近 5 日買賣超（股）
  // 美股才有
  aboveMa50?: boolean;
  ma20AboveMa50?: boolean;
  rsVsIndex1m?: number; // 相對大盤 1 個月超額報酬
}

export interface SectorStat {
  sector: string;
  count: number;
  ret1w: number; // 中位數
  ret1m: number;
  breadth: number; // 近 1 月上漲家數比例
  foreignValue5: number; // 外資 5 日買賣超金額（元），美股為 NaN
  rank1w: number; // 1 = 最強
  rank1m: number;
  strength: number; // 0~1
  rotation: "轉強" | "轉弱" | "強勢延續" | "弱勢" | "持平";
}

export interface Scored extends StockInput {
  score: number;
  momentum: number; // 0~1
  flow: number; // 0~1（美股為趨勢分數）
  sectorScore: number; // 0~1
  rating: Rating;
  refOnly?: boolean; // ETF：分數只供參考，不顯示買入／觀望／離場
  reasons: string[];
  foreignRatio5?: number; // 外資 5 日買超金額 ÷ 5 日成交金額估計
}

export const MIN_VALUE = { TW: 50_000_000, US: 20_000_000 }; // 流動性門檻：台幣 5 千萬、美元 2 千萬

const median = (xs: number[]) => {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** 每個值在陣列中的百分位（0~1，NaN 視為 0.5） */
export function percentiles(values: number[]): number[] {
  const idx = values.map((v, i) => [v, i] as const).filter(([v]) => Number.isFinite(v)).sort((a, b) => a[0] - b[0]);
  const out = values.map(() => 0.5);
  const n = idx.length;
  if (n <= 1) return out;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
    const p = (i + j) / 2 / (n - 1); // 同值取平均名次
    for (let k = i; k <= j; k++) out[idx[k][1]] = p;
    i = j + 1;
  }
  return out;
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const lots = (shares: number) => `${shares >= 0 ? "+" : ""}${Math.round(shares / 1000).toLocaleString("zh-TW")} 張`;

export function sectorStats(stocks: StockInput[]): SectorStat[] {
  const groups = new Map<string, StockInput[]>();
  for (const s of stocks) {
    if (!groups.has(s.sector)) groups.set(s.sector, []);
    groups.get(s.sector)!.push(s);
  }
  const rows = [...groups.entries()]
    .filter(([, list]) => list.length >= 3)
    .map(([sector, list]) => ({
      sector,
      count: list.length,
      ret1w: median(list.map((s) => s.ret1w)),
      ret1m: median(list.map((s) => s.ret1m)),
      breadth: list.filter((s) => s.ret1m > 0).length / list.length,
      foreignValue5: list.some((s) => s.foreign5 !== undefined)
        ? list.reduce((a, s) => a + (Number.isFinite(s.foreign5!) ? s.foreign5! * s.close : 0), 0)
        : NaN,
    }));
  const rankBy = (key: "ret1w" | "ret1m") => {
    const sorted = [...rows].sort((a, b) => b[key] - a[key]);
    return new Map(sorted.map((r, i) => [r.sector, i + 1]));
  };
  const r1w = rankBy("ret1w"), r1m = rankBy("ret1m");
  const pW = percentiles(rows.map((r) => r.ret1w));
  const pM = percentiles(rows.map((r) => r.ret1m));
  const hasFlow = rows.some((r) => Number.isFinite(r.foreignValue5));
  const pF = percentiles(rows.map((r) => r.foreignValue5));
  const n = rows.length;
  return rows
    .map((r, i) => {
      const rank1w = r1w.get(r.sector)!, rank1m = r1m.get(r.sector)!;
      const strength = hasFlow ? 0.35 * pW[i] + 0.35 * pM[i] + 0.3 * pF[i] : 0.5 * pW[i] + 0.5 * pM[i];
      const top = n / 3, bottom = (2 * n) / 3;
      let rotation: SectorStat["rotation"] = "持平";
      if (rank1w <= top && rank1m > top) rotation = "轉強";
      else if (rank1w <= top && rank1m <= top) rotation = "強勢延續";
      else if (rank1w > bottom && rank1m <= top) rotation = "轉弱";
      else if (rank1w > bottom && rank1m > bottom) rotation = "弱勢";
      return { ...r, rank1w, rank1m, strength, rotation };
    })
    .sort((a, b) => b.strength - a.strength);
}

/** 評分權重。App 用的是 DEFAULT_WEIGHTS；其他組合只給回測比較用（tools/backtest.ts 的新舊評分對照） */
export interface ScoreWeights {
  momentum: number; flow: number; sector: number; liquidity: number; // 總分：動能、籌碼、族群、流動性（成交金額百分位）
  foreign: number; streak: number; trust: number; // 台股籌碼分數：外資買超佔比、外資連買天數、投信買超佔比
}
export const DEFAULT_WEIGHTS: ScoreWeights = { momentum: 0.4, flow: 0.4, sector: 0.2, liquidity: 0, foreign: 0.6, streak: 0.2, trust: 0.2 };

/** keep：一定要評分的代號（使用者自己加的股票），不受成交金額門檻限制 */
export function scoreStocks(stocks: StockInput[], keep?: Set<string>, w: ScoreWeights = DEFAULT_WEIGHTS): { scored: Scored[]; sectors: SectorStat[] } {
  const isUS = stocks[0]?.market === "US";
  const liquid = stocks.filter(
    (s) => Number.isFinite(s.close) && Number.isFinite(s.ret1m) && (s.value >= (isUS ? MIN_VALUE.US : MIN_VALUE.TW) || !!keep?.has(s.code)),
  );
  const sectors = sectorStats(liquid);
  const secMap = new Map(sectors.map((s) => [s.sector, s]));

  const p1w = percentiles(liquid.map((s) => s.ret1w));
  const p1m = percentiles(liquid.map((s) => s.ret1m));
  const p3m = percentiles(liquid.map((s) => s.ret3m));
  // 外資 5 日買超金額 ÷（當日成交金額 × 5）≈ 外資買超佔成交比重
  const fRatio = liquid.map((s) => (s.foreign5 !== undefined && s.value > 0 ? (s.foreign5 * s.close) / (s.value * 5) : NaN));
  const tRatio = liquid.map((s) => (s.trust5 !== undefined && s.value > 0 ? (s.trust5 * s.close) / (s.value * 5) : NaN));
  const pF = percentiles(fRatio);
  const pT = percentiles(tRatio);
  const pRS = percentiles(liquid.map((s) => s.rsVsIndex1m ?? NaN));
  const pL = w.liquidity > 0 ? percentiles(liquid.map((s) => s.value)) : [];

  const scored = liquid.map((s, i): Scored => {
    const momentum = 0.5 * p1m[i] + 0.3 * p3m[i] + 0.2 * p1w[i];
    let flow: number;
    if (isUS) {
      flow = 0.4 * (s.aboveMa50 ? 1 : 0) + 0.3 * (s.ma20AboveMa50 ? 1 : 0) + 0.3 * pRS[i];
    } else {
      const streak = Math.max(0, Math.min(s.foreignStreak ?? 0, 5)) / 5;
      flow = w.foreign * pF[i] + w.streak * streak + w.trust * pT[i];
    }
    const sec = secMap.get(s.sector);
    const sectorScore = sec ? sec.strength : 0.5;
    const score = Math.round(100 * (w.momentum * momentum + w.flow * flow + w.sector * sectorScore + (w.liquidity > 0 ? w.liquidity * pL[i] : 0)));

    const reasons: string[] = [];
    reasons.push(`近1週 ${pct(s.ret1w)}、近1月 ${pct(s.ret1m)}、近3月 ${pct(s.ret3m)}（動能贏過 ${Math.round(momentum * 100)}% 的股票）`);
    if (!isUS && s.foreign5 !== undefined) {
      const streak = s.foreignStreak ?? 0;
      const streakText = streak > 0 ? `，連續買超 ${streak} 天` : streak < 0 ? `，連續賣超 ${-streak} 天` : "";
      reasons.push(`外資近5日 ${lots(s.foreign5)}${streakText}`);
      if (s.trust5 !== undefined && Math.abs(s.trust5) >= 1000) reasons.push(`投信近5日 ${lots(s.trust5)}`);
    }
    if (isUS) {
      reasons.push(s.aboveMa50 ? "股價在 50 日均線之上" : "股價跌破 50 日均線");
      if (s.rsVsIndex1m !== undefined) reasons.push(`近1月相對 S&P 500 ${pct(s.rsVsIndex1m)}`);
    }
    if (sec) reasons.push(`${s.sector}族群：${sec.rotation}（近1週族群排名第 ${sec.rank1w}/${sectors.length}）`);

    const foreignOk = isUS ? !!s.aboveMa50 : (s.foreign5 ?? 0) > 0;
    const foreignBad = isUS ? !s.aboveMa50 : (s.foreign5 ?? 0) < 0;
    let rating: Rating = "觀望";
    if (score >= 70 && foreignOk && s.ret1w < 0.2) rating = "買入";
    else if (score < 40 || (s.ret1m < -0.1 && foreignBad)) rating = "離場";
    if (score >= 70 && s.ret1w >= 0.2) reasons.push("短線一週漲幅超過 20%，追高風險大，先觀望");
    if (rating === "離場" && s.ret1m < -0.1 && foreignBad) reasons.push(isUS ? "近1月跌逾 10% 且跌破均線" : "近1月跌逾 10% 且外資賣超");

    return { ...s, score, momentum, flow, sectorScore, rating, reasons, foreignRatio5: isUS ? undefined : fRatio[i] };
  });
  scored.sort((a, b) => b.score - a.score);
  return { scored, sectors };
}

export interface Holding {
  id: string;
  code: string;
  name: string;
  market: "TWSE" | "TPEX" | "US";
  shares: number;
  cost: number; // 平均成本（每股）
}

export interface HoldingView extends Holding {
  price: number;
  pnl: number;
  pnlPct: number;
  rating: Rating | "無資料" | "無評等" | "參考";
  advice: string[];
  scored?: Scored;
}

export const STOP_LOSS = -0.1;

export function reviewHolding(h: Holding, scored: Scored | undefined, lastPrice?: number, opts: { esb?: boolean } = {}): HoldingView {
  const price = scored?.close ?? lastPrice ?? NaN;
  const pnl = (price - h.cost) * h.shares;
  const pnlPct = h.cost > 0 ? price / h.cost - 1 : NaN;
  const advice: string[] = [];
  let rating: HoldingView["rating"] = scored?.refOnly ? "參考" : scored?.rating ?? (opts.esb && Number.isFinite(price) ? "無評等" : "無資料");
  if (!scored && opts.esb && Number.isFinite(price)) advice.push("興櫃股票沒有三大法人資料，只計算損益、不評分");
  else if (!scored) advice.push(Number.isFinite(price) ? "成交金額低於門檻，只計算損益、不評分" : "找不到這檔股票的行情，請確認代號");
  if (Number.isFinite(pnlPct) && pnlPct <= STOP_LOSS) {
    advice.push(`虧損 ${(pnlPct * 100).toFixed(1)}%，已達 10% 停損線`);
    if (rating === "觀望") rating = "離場";
  }
  if (scored?.refOnly) {
    advice.push(`ETF 只供參考：分數 ${scored.score}、近1月 ${pct(scored.ret1m)}`);
  } else if (scored) {
    if (rating === "買入") advice.push("動能與籌碼仍強，可續抱");
    else if (rating === "觀望") advice.push("訊號分歧，續抱但留意外資動向");
    else advice.push("訊號轉弱，考慮減碼或出場");
  }
  return { ...h, price, pnl, pnlPct, rating, advice, scored };
}
