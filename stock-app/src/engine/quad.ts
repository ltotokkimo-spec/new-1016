// 「四因子」選股名單（使用者 11/15 選「並列顯示＋一起追蹤」）：現有「買入」評等不動，另外多一份名單，
// 由每天的回測流程算好、App 下載顯示；同時和現有「買入」、影子 C 並排追蹤，到影子 C 判定時（約 2027 年 1 月中）再決定要不要取代。
//
// 規則（11/15 定案，改了就等於重新開始追蹤，要先跟使用者說）：
//   候選＝App 當天有評分的個股（成交金額 ≥ 5 千萬、非 ETF）裡，近 1 週漲幅 < 20%、股價站上 60 日線且 60 日線比 20 個交易日前高的；
//   分數＝外資近 60 日買超佔成交量 30%＋近 20 日平均成交金額 25%＋近 60 日波動小 25%＋近 3 個月營收年增率 20%（都用候選裡的排名百分位，四項都要有資料）；
//   取分數最高的 k 檔，k＝當天現有「買入」的檔數（檔數相同才公平比較）。
//
// 為什麼是這四個：2025/6～2026/11 的檢驗（本機用同一份回測資料）裡，現有「買入」20 日勝率 53%（全部股票 50%），
// 而且四段期間裡最後一段只有 47.5%、大盤下跌日 33%；外資 60 日買超＋成交金額把勝率拉到 62%，但其中大部分是「大型股效應」
// （只挑成交金額最大的就有 61%），行情一換可能反轉；加上低波動（下跌時撐住）與營收年增（成長）後，四段與下跌日都贏現有買入
// （勝率 66／55／68／59%，下跌日 50%），是風格最分散的一組。
// ⚠️ 這份資料在定案前已經全部看過，沒有獨立的驗證期，回測數字偏樂觀；10/15 之後大盤急跌的 3 個評等日裡，現有買入反而比較好。
// 所以只當「追蹤中的候選」，看 QUAD.start 之後的實際表現。
import { buildTwInputs } from "../data/twLoader";
import { isEtf, type Company } from "../data/tw";
import { addDays } from "../lib/dates";
import type { BtDay } from "./backtest";
import { revFactors, type RevTable } from "./revHist";
import { DEFAULT_WEIGHTS, scoreStocks, type Scored, type ScoreWeights } from "./score";
import { SHADOW_KEY, VARIANTS } from "./scoreCompare";
import { buildCtx, type Ctx } from "./steady";

export const QUAD = {
  wFlow: 0.3, wLiq: 0.25, wVol: 0.25, wRev: 0.2,
  flowDays: 60, liqDays: 20, volDays: 60, maDays: 60, maLag: 20, maxRet1w: 0.2,
  start: "20261116", // 定案後第一個評等日；之前的都算「回測」（定案前看過的資料）
  histFrom: 130, histStep: 5, // 回測：從第 130 個交易日起、每 5 個交易日一個評等日（和定案時的檢驗一致）
  horizons: [5, 20] as const,
} as const;
type H = (typeof QUAD.horizons)[number];

export interface QuadPick { code: string; name: string; rank: number; score: number; flow60: number; value20: number; vol60: number; yoy3: number }
export interface QuadStat { days: number; n: number; win: number; beat: number; avg: number; ex: number } // n：平均每天幾檔；ex：比當天全部股票的平均多多少
export type QuadGroup = "old" | "c" | "quad" | "all";
export interface QuadResult {
  version: 1; generatedAt: number;
  asOf: string; k: number; picks: QuadPick[];
  hist: { from: string; to: string; stats: Record<QuadGroup, Partial<Record<H, QuadStat>>> }; // 定案前的回測（偏樂觀）
  track: { start: string; stats: Record<QuadGroup, Partial<Record<H, QuadStat>>> }; // 定案後的實際追蹤
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
function pctRank(codes: string[], vals: number[]): Map<string, number> {
  const idx = codes.map((_, i) => i).filter((i) => Number.isFinite(vals[i])).sort((a, b) => vals[a] - vals[b]);
  const out = new Map<string, number>();
  idx.forEach((i, r) => out.set(codes[i], idx.length > 1 ? r / (idx.length - 1) : 0.5));
  return out;
}

/** 四因子需要的原始數字；資料不夠的回傳 NaN */
export function quadFactors(c: Ctx, code: string, j: number) {
  const s = c.series.get(code);
  const px = (k: number) => (s && k >= s.start && k - s.start < s.adj.length ? s.adj[k - s.start] : NaN);
  const ma = (k: number) => { let t = 0; for (let i = k - QUAD.maDays + 1; i <= k; i++) { const p = px(i); if (!(p > 0)) return NaN; t += p; } return t / QUAD.maDays; };
  let f = 0, v = 0;
  for (let k = j - QUAD.flowDays + 1; k <= j; k++) { f += c.flows[k]?.get(code)?.[1] ?? 0; v += c.rows[k]?.get(code)?.[5] ?? 0; }
  let val = 0, okVal = true;
  for (let k = j - QUAD.liqDays + 1; k <= j; k++) { const r = c.rows[k]?.get(code); if (!r) { okVal = false; break; } val += r[4]; }
  const rets: number[] = [];
  for (let k = j - QUAD.volDays + 1; k <= j; k++) { const a = px(k), b = px(k - 1); if (!(a > 0 && b > 0)) { rets.length = 0; break; } rets.push(a / b - 1); }
  const m = mean(rets), vol = rets.length > 1 ? Math.sqrt(rets.reduce((t, x) => t + (x - m) ** 2, 0) / (rets.length - 1)) : NaN;
  const ma0 = ma(j), ma1 = ma(j - QUAD.maLag);
  return {
    flow60: v > 0 ? f / v : NaN, value20: okVal ? val / QUAD.liqDays : NaN, vol60: vol,
    yoy3: (c.rev ? revFactors(c.rev, code, c.dates[j])?.yoy3 : undefined) ?? NaN,
    trendOk: px(j) > ma0 && ma0 > ma1,
  };
}

/** 第 j 天收盤後的四因子名單：base＝當天 App 的評分結果（現有權重），k＝要取幾檔 */
export function quadPicks(c: Ctx, j: number, base: Scored[], k: number): QuadPick[] {
  if (k <= 0 || !c.rev) return [];
  const cand = base.filter((x) => x.ret1w < QUAD.maxRet1w).map((x) => ({ x, f: quadFactors(c, x.code, j) })).filter((o) => o.f.trendOk);
  const codes = cand.map((o) => o.x.code);
  const ranks = [
    pctRank(codes, cand.map((o) => o.f.flow60)), pctRank(codes, cand.map((o) => o.f.value20)),
    pctRank(codes, cand.map((o) => -o.f.vol60)), pctRank(codes, cand.map((o) => o.f.yoy3)),
  ];
  const w = [QUAD.wFlow, QUAD.wLiq, QUAD.wVol, QUAD.wRev];
  const out: QuadPick[] = [];
  for (const o of cand) {
    const r = ranks.map((m) => m.get(o.x.code));
    if (r.some((v) => v === undefined)) continue; // 四項都要有資料
    out.push({ code: o.x.code, name: o.x.name, rank: 0, score: r.reduce((t: number, v, i) => t + w[i] * v!, 0), flow60: o.f.flow60, value20: o.f.value20, vol60: o.f.vol60, yoy3: o.f.yoy3 });
  }
  out.sort((a, b) => b.score - a.score || (a.code < b.code ? -1 : 1));
  return out.slice(0, k).map((p, i) => ({ ...p, rank: i + 1 }));
}

/** days：新到舊。算出最新名單、定案前的回測與定案後的追蹤（三組並排：現有買入、影子 C、四因子） */
export function runQuad(days: BtDay[], companies: Company[], rev: RevTable | undefined, opts: { now?: number; start?: string } = {}): QuadResult {
  const c = buildCtx(days, companies, rev), N = c.N, start = opts.start ?? QUAD.start;
  const cW: ScoreWeights = VARIANTS.find((v) => v.key === SHADOW_KEY)!.w;
  const dateIdx = new Map(days.map((d, k) => [d.date, k]));
  const onOrBefore = (ymd: string) => { for (let k = 0; k < 10; k++) { const x = dateIdx.get(addDays(ymd, -k)); if (x !== undefined) return x; } return undefined; };
  const scoredAt = (j: number, w: ScoreWeights): Scored[] => {
    const i = N - 1 - j, s = days[i].date, m1 = onOrBefore(addDays(s, -28)), m3 = onOrBefore(addDays(s, -88));
    if (i + 5 >= N || m1 === undefined || m3 === undefined) return [];
    const inputs = buildTwInputs({ latest: days[i].quotes, week: days[i + 5].quotes, month: days[m1].quotes, quarter: days[m3].quotes, flows: days.slice(i, i + 10).map((d) => d.flows), companies, tpexCodes: days[i].tpexCodes });
    return scoreStocks(inputs.filter((x) => !isEtf(x.code)), undefined, w).scored;
  };
  const px = (code: string, k: number) => { const s = c.series.get(code); return s && k >= s.start && k - s.start < s.adj.length ? s.adj[k - s.start] : NaN; };
  const groups: QuadGroup[] = ["old", "c", "quad", "all"];
  type Acc = Record<QuadGroup, Record<number, { rets: number[]; beat: number[]; ex: number[]; n: number[] }>>;
  const mk = (): Acc => Object.fromEntries(groups.map((g) => [g, Object.fromEntries(QUAD.horizons.map((h) => [h, { rets: [], beat: [], ex: [], n: [] }]))])) as unknown as Acc;
  const hist = mk(), track = mk();
  // 評等日：回測每 5 個交易日一次（到定案前），追蹤期每個交易日都算
  const ratingDays: number[] = [];
  for (let j = QUAD.histFrom; j < N; j++) { const d = c.dates[j]; if (d >= start || (d < start && (j - QUAD.histFrom) % QUAD.histStep === 0)) ratingDays.push(j); }
  let histFrom = "", histTo = "";
  for (const j of ratingDays) {
    if (j + 1 + QUAD.horizons[0] >= N) continue; // 連最短的報酬都還沒有
    const base = scoredAt(j, DEFAULT_WEIGHTS);
    if (!base.length) continue;
    const isTrack = c.dates[j] >= start, acc = isTrack ? track : hist;
    if (!isTrack) { if (!histFrom) histFrom = c.dates[j]; histTo = c.dates[j]; }
    const old = base.filter((x) => x.rating === "買入").map((x) => x.code);
    const picks: Record<QuadGroup, string[]> = {
      old, c: scoredAt(j, cW).filter((x) => x.rating === "買入").map((x) => x.code),
      quad: quadPicks(c, j, base, old.length).map((p) => p.code), all: base.map((x) => x.code),
    };
    for (const h of QUAD.horizons) {
      if (j + 1 + h >= N) continue;
      const fwd = (code: string) => px(code, j + 1 + h) / px(code, j + 1) - 1; // 隔天收盤買進，持有 h 個交易日
      const uni = picks.all.map(fwd).filter(Number.isFinite), uMean = mean(uni), uMed = median(uni);
      for (const g of groups) {
        const rs = picks[g].map(fwd).filter(Number.isFinite), a = acc[g][h];
        a.n.push(rs.length);
        if (!rs.length) continue;
        a.rets.push(...rs); a.beat.push(...rs.map((r) => (r > uMed ? 1 : 0))); a.ex.push(mean(rs) - uMean);
      }
    }
  }
  const fin = (acc: Acc) => Object.fromEntries(groups.map((g) => [g, Object.fromEntries(QUAD.horizons.filter((h) => acc[g][h].n.length > 0).map((h) => {
    const a = acc[g][h];
    return [h, { days: a.n.length, n: mean(a.n), win: a.rets.length ? a.rets.filter((r) => r > 0).length / a.rets.length : NaN, beat: mean(a.beat), avg: mean(a.rets), ex: mean(a.ex) }];
  }))])) as Record<QuadGroup, Partial<Record<H, QuadStat>>>;
  const last = N - 1, baseL = scoredAt(last, DEFAULT_WEIGHTS), k = baseL.filter((x) => x.rating === "買入").length;
  return {
    version: 1, generatedAt: opts.now ?? Date.now(), asOf: c.dates[last], k, picks: quadPicks(c, last, baseL, k),
    hist: { from: histFrom, to: histTo, stats: fin(hist) }, track: { start, stats: fin(track) },
  };
}
