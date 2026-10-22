// 新舊評分對照：用同一批資料、同樣的流程，比較幾組評分權重在「之後 5 天、20 天」的預測力。
// 只是研究（tools/backtest.ts 會輸出 scorecompare.json），不影響 App 目前使用的評分（DEFAULT_WEIGHTS）。
// 因子分析（factors.ts）的結論：投信買超是穩定的反向訊號、外資連買與成交金額大有正向，動能與族群沒預測力。
import { buildTwInputs } from "../data/twLoader";
import { isEtf, type Company } from "../data/tw";
import { addDays } from "../lib/dates";
import type { BtDay } from "./backtest";
import { quintileExcess, rankIC } from "./factors";
import { DEFAULT_WEIGHTS, scoreStocks, type ScoreWeights } from "./score";

export const VARIANTS: { key: string; label: string; w: ScoreWeights }[] = [
  { key: "old", label: "現有（動能40 籌碼40 族群20；投信占籌碼20%）", w: DEFAULT_WEIGHTS },
  { key: "A", label: "A 去投信（籌碼＝外資佔比70＋連買30）", w: { ...DEFAULT_WEIGHTS, foreign: 0.7, streak: 0.3, trust: 0 } },
  { key: "B", label: "B 去投信＋流動性15（動能35 籌碼35 族群15 流動15）", w: { momentum: 0.35, flow: 0.35, sector: 0.15, liquidity: 0.15, foreign: 0.7, streak: 0.3, trust: 0 } },
  { key: "C", label: "C 動能降權（動能20 籌碼40 族群15 流動25）", w: { momentum: 0.2, flow: 0.4, sector: 0.15, liquidity: 0.25, foreign: 0.7, streak: 0.3, trust: 0 } },
  { key: "D", label: "D 只看外資與流動性（籌碼60 流動40）", w: { momentum: 0, flow: 0.6, sector: 0, liquidity: 0.4, foreign: 0.7, streak: 0.3, trust: 0 } },
];

/**
 * 影子追蹤：C 的權重在 2026/10/22 凍結（之後不改），只算「凍結之後」的評等日，這些日子的報酬在凍結時還沒發生，
 * 所以是真正的樣本外驗證。凍結前的 2 年資料已經被拿來挑 C，不算。
 * 通過標準也事先訂在這裡：20 日報酬已經算得出來的評等日 ≥ 40 天後，C 的 IC、前 5%、買入組超額都不輸現有，
 * 大盤下跌日（≥ 10 天）的 IC 也不輸，且買入檔數在現有的 ±30% 內，才算通過；否則維持現有評分。
 */
export const SHADOW_START = "20261015"; // 第一個還沒有任何報酬資料的評等日（因子分析最後一個評等日是 20261014）
export const SHADOW_KEY = "C";
export const SHADOW_MIN_DAYS = 40;

export const CMP_HORIZONS = [5, 20] as const;
type H = (typeof CMP_HORIZONS)[number];

export interface CmpSlice {
  days: number;
  ic: number; // 每天「分數 vs 之後報酬」排名相關係數的平均
  spread: number; // 分數最高五分之一 − 最低五分之一 的平均報酬差
  top: number; // 每天分數最高的 5%（至少 10 檔）平均報酬 − 當天全部平均
  buy: number; // 評為「買入」的股票平均報酬 − 當天全部平均（當天沒有買入就不算）
  buyN: number; // 「買入」平均每天幾檔
  buyBeat: number; // 「買入」股票贏過當天全部中位數的比例
}
export interface CmpStat extends CmpSlice { first?: CmpSlice; second?: CmpSlice; up?: CmpSlice; down?: CmpSlice }
export interface ShadowPick { code: string; name: string; score: number; close: number }
export interface ShadowResult {
  start: string; // 影子追蹤開始日（含）
  matured: Partial<Record<H, number>>; // 已經算得出報酬的評等日數
  old: Partial<Record<H, CmpSlice>>; shadow: Partial<Record<H, CmpSlice>>; // 現有評分 vs 影子評分（C），只算影子期間
  oldDown: Partial<Record<H, CmpSlice>>; shadowDown: Partial<Record<H, CmpSlice>>; // 其中大盤下跌的日子
  liqSpread: Partial<Record<H, number>>; // 影子期間「成交金額最大五分之一 − 最小五分之一」的平均報酬差（負的＝大型股效應反轉）
  verdict: { status: "資料不足" | "通過" | "未通過"; reasons: string[] };
  latest?: { date: string; old: ShadowPick[]; shadow: ShadowPick[] }; // 最新一個資料日兩種評分各自的買入名單（依分數前 15 檔）
}
export interface CmpResult {
  version: 1; generatedAt: number; from: string; to: string; days: number; split: string; // split：前半期／後半期的分界日
  variants: { key: string; label: string; h: Partial<Record<H, CmpStat>> }[];
  shadow?: ShadowResult;
}

interface Row { date: string; up: boolean; ic: number; spread: number; top: number; buy: number; buyN: number; buyWin: number; buyCnt: number }

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };
const fin = (xs: number[]) => xs.filter(Number.isFinite);

function slice(rows: Row[]): CmpSlice {
  const buys = rows.filter((r) => Number.isFinite(r.buy));
  const cnt = buys.reduce((a, r) => a + r.buyCnt, 0);
  return {
    days: rows.length, ic: mean(fin(rows.map((r) => r.ic))), spread: mean(fin(rows.map((r) => r.spread))), top: mean(fin(rows.map((r) => r.top))),
    buy: mean(buys.map((r) => r.buy)), buyN: mean(rows.map((r) => r.buyN)),
    buyBeat: cnt ? buys.reduce((a, r) => a + r.buyWin * r.buyCnt, 0) / cnt : NaN,
  };
}

/** days：新到舊、連續的交易日。每個交易日都當評等日（和 runFactors 相同的取樣方式）。 */
export function runScoreCompare(days: BtDay[], companies: Company[], opts: { now?: number; shadowStart?: string } = {}): CmpResult {
  const shadowStart = opts.shadowStart ?? SHADOW_START;
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

  const acc = new Map<string, Partial<Record<H, Row[]>>>(VARIANTS.map((v) => [v.key, {}]));
  const dates: string[] = [];
  const liq: Partial<Record<H, { date: string; v: number }[]>> = {};
  for (let i = CMP_HORIZONS[0]; i < days.length; i++) {
    const s = days[i].date;
    const w = i + 5;
    const m1 = idxOnOrBefore(addDays(s, -28)), m3 = idxOnOrBefore(addDays(s, -88));
    if (w >= days.length || m1 === undefined || m3 === undefined || i + 10 > days.length) continue;
    const inputs = buildTwInputs({
      latest: days[i].quotes, week: days[w].quotes, month: days[m1].quotes, quarter: days[m3].quotes,
      flows: days.slice(i, i + 10).map((d) => d.flows), companies, tpexCodes: days[i].tpexCodes,
    }).filter((x) => !isEtf(x.code));
    const base = scoreStocks(inputs).scored;
    if (base.length < 30) continue;
    const m1s = fin(base.map((x) => x.ret1m)).sort((a, b) => a - b);
    const up = m1s[m1s.length >> 1] > 0;
    dates.push(s);
    for (const h of CMP_HORIZONS) {
      if (i - h < 0) continue;
      {
        const rs0 = base.map((x) => fwd(x.code, i, h));
        const q0 = quintileExcess(base.map((x) => x.value), rs0);
        (liq[h] ??= []).push({ date: s, v: q0[4] - q0[0] });
      }
      for (const v of VARIANTS) {
        const { scored } = scoreStocks(inputs, undefined, v.w);
        const rs = scored.map((x) => fwd(x.code, i, h));
        const all = fin(rs), allAvg = mean(all), allMed = median(all);
        const sc = scored.map((x) => x.score);
        const q = quintileExcess(sc, rs);
        const order = scored.map((x, j) => j).filter((j) => Number.isFinite(rs[j])).sort((a, b) => sc[b] - sc[a] || a - b);
        const nTop = Math.max(10, Math.round(order.length * 0.05));
        const topAvg = mean(order.slice(0, nTop).map((j) => rs[j]));
        const buys = order.filter((j) => scored[j].rating === "買入").map((j) => rs[j]);
        ((acc.get(v.key)!)[h] ??= []).push({
          date: s, up, ic: rankIC(sc, rs), spread: q[4] - q[0], top: topAvg - allAvg,
          buy: buys.length ? mean(buys) - allAvg : NaN, buyN: buys.length, buyCnt: buys.length, buyWin: buys.length ? buys.filter((x) => x > allMed).length / buys.length : NaN,
        });
      }
    }
  }
  const sorted = [...dates].sort();
  const split = sorted[sorted.length >> 1] ?? "";
  // 影子追蹤（只看 shadowStart 之後的評等日）
  const sw = VARIANTS.find((v) => v.key === SHADOW_KEY)!.w;
  const shadow: ShadowResult = { start: shadowStart, matured: {}, old: {}, shadow: {}, oldDown: {}, shadowDown: {}, liqSpread: {}, verdict: { status: "資料不足", reasons: [] } };
  for (const h of CMP_HORIZONS) {
    const o = (acc.get("old")![h] ?? []).filter((r) => r.date >= shadowStart);
    const c = (acc.get(SHADOW_KEY)![h] ?? []).filter((r) => r.date >= shadowStart);
    shadow.matured[h] = o.length;
    if (o.length) { shadow.old[h] = slice(o); shadow.shadow[h] = slice(c); }
    if (o.filter((r) => !r.up).length >= 3) { shadow.oldDown[h] = slice(o.filter((r) => !r.up)); shadow.shadowDown[h] = slice(c.filter((r) => !r.up)); }
    const lq = (liq[h] ?? []).filter((x) => x.date >= shadowStart).map((x) => x.v);
    if (lq.length) shadow.liqSpread[h] = mean(fin(lq));
  }
  shadow.verdict = shadowVerdict(shadow);
  if (days.length > 15) {
    const w5 = 5, m1 = idxOnOrBefore(addDays(days[0].date, -28)), m3 = idxOnOrBefore(addDays(days[0].date, -88));
    if (m1 !== undefined && m3 !== undefined) {
      const inputs = buildTwInputs({ latest: days[0].quotes, week: days[w5].quotes, month: days[m1].quotes, quarter: days[m3].quotes, flows: days.slice(0, 10).map((d) => d.flows), companies, tpexCodes: days[0].tpexCodes }).filter((x) => !isEtf(x.code));
      const top = (w: ScoreWeights): ShadowPick[] => scoreStocks(inputs, undefined, w).scored.filter((x) => x.rating === "買入").slice(0, 15).map((x) => ({ code: x.code, name: x.name, score: x.score, close: x.close }));
      shadow.latest = { date: days[0].date, old: top(DEFAULT_WEIGHTS), shadow: top(sw) };
    }
  }
  return {
    shadow,
    version: 1, generatedAt: opts.now ?? Date.now(), from: sorted[0] ?? "", to: sorted[sorted.length - 1] ?? "", days: dates.length, split,
    variants: VARIANTS.map((v) => {
      const out: CmpResult["variants"][number] = { key: v.key, label: v.label, h: {} };
      for (const h of CMP_HORIZONS) {
        const rows = acc.get(v.key)![h];
        if (!rows?.length) continue;
        const part = (f: (r: Row) => boolean) => { const x = rows.filter(f); return x.length >= 3 ? slice(x) : undefined; };
        out.h[h] = { ...slice(rows), first: part((r) => r.date < split), second: part((r) => r.date >= split), up: part((r) => r.up), down: part((r) => !r.up) };
      }
      return out;
    }),
  };
}

const pc = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "—");
const nn = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(3)}` : "—");

/** 事先訂好的通過標準（見 SHADOW_START 的說明）；20 日已成熟的評等日不到 SHADOW_MIN_DAYS 就是資料不足 */
export function shadowVerdict(sh: ShadowResult): ShadowResult["verdict"] {
  const n = sh.matured[20] ?? 0;
  const o = sh.old[20], c = sh.shadow[20];
  if (n < SHADOW_MIN_DAYS || !o || !c) return { status: "資料不足", reasons: [`20 日報酬已經算得出來的評等日 ${n}/${SHADOW_MIN_DAYS} 天`] };
  const bad: string[] = [];
  if (!(c.ic > o.ic)) bad.push(`IC 沒有比現有好（${nn(c.ic)} vs ${nn(o.ic)}）`);
  if (!(c.top >= o.top)) bad.push(`前 5% 超額輸現有（${pc(c.top)} vs ${pc(o.top)}）`);
  if (!(c.buy >= o.buy)) bad.push(`買入組超額輸現有（${pc(c.buy)} vs ${pc(o.buy)}）`);
  const od = sh.oldDown[20], cd = sh.shadowDown[20];
  if (od && cd && od.days >= 10 && !(cd.ic >= od.ic)) bad.push(`大盤下跌日 IC 輸現有（${nn(cd.ic)} vs ${nn(od.ic)}）`);
  if (Number.isFinite(o.buyN) && Number.isFinite(c.buyN) && o.buyN > 0 && Math.abs(c.buyN / o.buyN - 1) > 0.3) bad.push(`買入檔數差太多（${c.buyN.toFixed(1)} vs ${o.buyN.toFixed(1)} 檔/日）`);
  return bad.length ? { status: "未通過", reasons: bad } : { status: "通過", reasons: [`${n} 天樣本外評等日全部條件都不輸現有`] };
}

/** 給 Actions 紀錄看的文字表：每組評分、每個期間（全部／前半／後半／大盤漲／大盤跌）一行 */
export function formatCompare(r: CmpResult): string[] {
  const out = [`新舊評分對照：${r.from} ~ ${r.to}，${r.days} 個評等日，前後半分界 ${r.split}`];
  for (const h of CMP_HORIZONS) {
    out.push(`-- ${h} 日報酬：IC＝分數與之後報酬的排名相關；多空差＝最高五分之一−最低五分之一；前5%＝分數最高 5% 比全部平均多賺；買入＝評為買入的比全部平均多賺（檔/日、贏過中位數）`);
    for (const v of r.variants) {
      const x = v.h[h];
      if (!x) continue;
      for (const [name, s] of [["全部", x], ["前半", x.first], ["後半", x.second], ["大盤漲", x.up], ["大盤跌", x.down]] as const) {
        if (!s) continue;
        out.push(`${v.key}｜${name}（${s.days}天）｜IC ${nn(s.ic)}｜多空差 ${pc(s.spread)}｜前5% ${pc(s.top)}｜買入 ${pc(s.buy)}（${Number.isFinite(s.buyN) ? s.buyN.toFixed(1) : "—"} 檔/日、贏過中位數 ${Number.isFinite(s.buyBeat) ? Math.round(s.buyBeat * 100) : "—"}%）`);
      }
    }
  }
  const sh = r.shadow;
  if (sh) {
    out.push(`== 影子追蹤（C 權重 ${sh.start} 凍結，只算之後的評等日）：${sh.verdict.status}`);
    for (const x of sh.verdict.reasons) out.push(`   ${x}`);
    for (const h of CMP_HORIZONS) {
      const o = sh.old[h], c = sh.shadow[h];
      out.push(`   ${h} 日：已成熟評等日 ${sh.matured[h] ?? 0} 天${o && c ? `｜現有 IC ${nn(o.ic)} 前5% ${pc(o.top)} 買入 ${pc(o.buy)}｜影子 IC ${nn(c.ic)} 前5% ${pc(c.top)} 買入 ${pc(c.buy)}` : ""}｜成交金額大減小的報酬差 ${pc(sh.liqSpread[h] ?? NaN)}`);
    }
    if (sh.latest) {
      const f = (xs: ShadowPick[]) => xs.map((p) => `${p.code}${p.name}(${p.score})`).join("、");
      out.push(`   最新資料日 ${sh.latest.date} 買入名單（前 15）｜現有：${f(sh.latest.old)}`);
      out.push(`   最新資料日 ${sh.latest.date} 買入名單（前 15）｜影子：${f(sh.latest.shadow)}`);
    }
  }
  return out;
}
