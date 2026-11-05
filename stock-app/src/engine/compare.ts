// 虛擬 ETF 總評比：把 Claude 虛擬操作和三個規則自動計算的觀察組合放在一起比，也和 0050 比。
// 每組各自的起始日不同（Claude 虛擬 10/19、規則組合 10/23），所以除了「各自全期間」，另外算「同期」（從大家都有資料的那天起）。
import { BENCH, cashFlow, flowsFor, twrSeries, type AiEtf, type NavPoint } from "./aiEtf";
import type { VirtualEtf } from "./virtualEtf";

export interface GroupInput { key: string; label: string; v?: VirtualEtf; noCommon?: boolean } // noCommon：不參與決定「同期」起點（我的實單起始日不同，不要把大家的同期縮短）
/** holdRet：起點那天把錢全買 0050 抱著到最新的報酬（不含手續費）；holdDiff＝組合報酬減 holdRet。沒有 0050 價格就沒有 */
export interface Period { ret: number; bench: number; diff: number; days: number; holdRet?: number; holdDiff?: number }
export interface GroupRow {
  key: string; label: string;
  ready: boolean; // 已經有淨值紀錄
  start?: string; asOf?: string; budget?: number; nav?: number;
  all?: Period & { maxDd: number; worstDay: number }; // 各自的全期間
  same?: Period & { maxDd: number }; // 同期
}
export interface Comparison { rows: GroupRow[]; commonFrom?: string; closes: Map<string, number> }

/**
 * 從淨值紀錄反推每個交易日的 0050 收盤價：對照組淨值 ＝ 對照組現金 ＋ 持有單位 × 0050 價格，
 * 現金和單位照成交紀錄重算（和 valuate 一樣的算法），所以 價格 ＝（對照組淨值 − 現金）÷ 單位。
 * 單位太少（還沒買）時算不出來，就不記。
 */
export function benchCloses(v?: VirtualEtf): Map<string, number> {
  const out = new Map<string, number>();
  if (!v) return out;
  const trades = [...v.trades].filter((t) => t.benchPrice > 0).sort((a, b) => a.date.localeCompare(b.date));
  for (const pt of v.nav) {
    let bCash = v.budget, bUnits = 0;
    for (const t of trades) {
      if (t.date > pt.date) break;
      const units = (t.shares * t.price) / t.benchPrice;
      if (t.side === "buy") { bUnits += units; bCash += cashFlow(t); }
      else { const u = Math.min(units, bUnits); bUnits -= u; bCash += cashFlow({ side: "sell", shares: u, price: t.benchPrice, code: BENCH }); }
    }
    if (bUnits >= 1) out.set(pt.date, (pt.bench - bCash) / bUnits);
  }
  return out;
}

const maxDd = (xs: number[]) => { let pk = xs[0], dd = 0; for (const x of xs) { pk = Math.max(pk, x); dd = Math.min(dd, x / pk - 1); } return dd; };

function period(points: NavPoint[], budget: number, from?: string, px?: Map<string, number>): (Period & { maxDd: number; worstDay: number }) | undefined {
  const pts = from ? points.filter((p) => p.date >= from) : points;
  if (!pts.length) return undefined;
  const before = from ? points.filter((p) => p.date < from).at(-1) : undefined;
  const base = before ?? { nav: budget, bench: budget };
  const last = pts[pts.length - 1];
  const ret = last.nav / base.nav - 1, bench = last.bench / base.bench - 1;
  let worst = 0, prevN = base.nav;
  for (const p of pts) { worst = Math.min(worst, p.nav / prevN - 1); prevN = p.nav; }
  // 全買 0050 抱著：起點用該期間之前最後一筆的日期（沒有就用第一天）的 0050 收盤價
  const p0 = px?.get(before?.date ?? pts[0].date), p1 = px?.get(last.date);
  const holdRet = p0 && p1 ? p1 / p0 - 1 : undefined;
  return { ret, bench, diff: ret - bench, days: pts.length, ...(holdRet !== undefined ? { holdRet, holdDiff: ret - holdRet } : {}), maxDd: maxDd([base.nav, ...pts.map((p) => p.nav)]), worstDay: worst };
}

export function compareGroups(groups: GroupInput[]): Comparison {
  // 0050 收盤價：各組各自反推，合在一起用（有的組某天還沒買 0050，別組那天就補上）
  const px = new Map<string, number>();
  for (const g of groups) for (const [d, p] of benchCloses(g.v)) if (!px.has(d)) px.set(d, p);
  const firsts = groups.filter((g) => !g.noCommon).map((g) => g.v?.nav[0]?.date).filter((d): d is string => !!d);
  const commonFrom = firsts.length ? firsts.reduce((a, b) => (a > b ? a : b)) : undefined; // 大家都有資料的第一天
  const rows = groups.map((g): GroupRow => {
    const v = g.v;
    if (!v || !v.nav.length) return { key: g.key, label: g.label, ready: false, start: v?.start, asOf: v?.asOf, budget: v?.budget };
    const all = period(v.nav, v.budget, undefined, px);
    const same = commonFrom ? period(v.nav, v.budget, commonFrom, px) : undefined;
    return { key: g.key, label: g.label, ready: true, start: v.start, asOf: v.asOf, budget: v.budget, nav: v.nav.at(-1)!.nav, all, same: same && { ret: same.ret, bench: same.bench, diff: same.diff, days: same.days, maxDd: same.maxDd, holdRet: same.holdRet, holdDiff: same.holdDiff } };
  });
  return { rows, commonFrom, closes: px };
}

/**
 * 我的實單 → 總評比的一組：從第一筆實際成交那天起算；中途存入／提領用時間加權報酬（和「我的實單」頁一樣），
 * 換算成「起始資金 × (1＋累積報酬)」，0050 對照也一樣，這樣才能和其他組用同一套方法比。
 */
export function realAsGroup(etf: AiEtf | undefined): VirtualEtf | undefined {
  if (!etf || !etf.trades.length || !etf.nav.length) return undefined;
  const start = etf.trades.map((t) => t.date).sort()[0];
  const mine = twrSeries(etf.nav.map((p) => ({ date: p.date, v: p.nav })), etf.budget, flowsFor(etf.flows, "nav"));
  const bench = twrSeries(etf.nav.map((p) => ({ date: p.date, v: p.bench })), etf.budget, flowsFor(etf.flows, "bench"));
  const nav: NavPoint[] = etf.nav.map((p, i) => ({ date: p.date, nav: Math.round(etf.budget * (1 + mine[i].cum)), bench: Math.round(etf.budget * (1 + bench[i].cum)) })).filter((p) => p.date >= start);
  if (!nav.length) return undefined;
  return { version: 1, start, asOf: nav.at(-1)!.date, updatedAt: 0, budget: etf.budget, trades: [], nav, pending: [], notes: [], last: {} };
}
