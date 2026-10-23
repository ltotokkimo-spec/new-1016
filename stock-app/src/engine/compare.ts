// 虛擬 ETF 總評比：把 Claude 虛擬操作和三個規則自動計算的觀察組合放在一起比，也和 0050 比。
// 每組各自的起始日不同（Claude 虛擬 10/19、規則組合 10/23），所以除了「各自全期間」，另外算「同期」（從大家都有資料的那天起）。
import type { NavPoint } from "./aiEtf";
import type { VirtualEtf } from "./virtualEtf";

export interface GroupInput { key: string; label: string; v?: VirtualEtf }
export interface Period { ret: number; bench: number; diff: number; days: number }
export interface GroupRow {
  key: string; label: string;
  ready: boolean; // 已經有淨值紀錄
  start?: string; asOf?: string; budget?: number; nav?: number;
  all?: Period & { maxDd: number; worstDay: number }; // 各自的全期間
  same?: Period & { maxDd: number }; // 同期
}
export interface Comparison { rows: GroupRow[]; commonFrom?: string }

const maxDd = (xs: number[]) => { let pk = xs[0], dd = 0; for (const x of xs) { pk = Math.max(pk, x); dd = Math.min(dd, x / pk - 1); } return dd; };

function period(points: NavPoint[], budget: number, from?: string): (Period & { maxDd: number; worstDay: number }) | undefined {
  const pts = from ? points.filter((p) => p.date >= from) : points;
  if (!pts.length) return undefined;
  const before = from ? points.filter((p) => p.date < from).at(-1) : undefined;
  const base = before ?? { nav: budget, bench: budget };
  const last = pts[pts.length - 1];
  const ret = last.nav / base.nav - 1, bench = last.bench / base.bench - 1;
  let worst = 0, prevN = base.nav;
  for (const p of pts) { worst = Math.min(worst, p.nav / prevN - 1); prevN = p.nav; }
  return { ret, bench, diff: ret - bench, days: pts.length, maxDd: maxDd([base.nav, ...pts.map((p) => p.nav)]), worstDay: worst };
}

export function compareGroups(groups: GroupInput[]): Comparison {
  const firsts = groups.map((g) => g.v?.nav[0]?.date).filter((d): d is string => !!d);
  const commonFrom = firsts.length ? firsts.reduce((a, b) => (a > b ? a : b)) : undefined; // 大家都有資料的第一天
  const rows = groups.map((g): GroupRow => {
    const v = g.v;
    if (!v || !v.nav.length) return { key: g.key, label: g.label, ready: false, start: v?.start, asOf: v?.asOf, budget: v?.budget };
    const all = period(v.nav, v.budget);
    const same = commonFrom ? period(v.nav, v.budget, commonFrom) : undefined;
    return { key: g.key, label: g.label, ready: true, start: v.start, asOf: v.asOf, budget: v.budget, nav: v.nav.at(-1)!.nav, all, same: same && { ret: same.ret, bench: same.bench, diff: same.diff, days: same.days, maxDd: same.maxDd } };
  });
  return { rows, commonFrom };
}
