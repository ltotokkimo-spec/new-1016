// 主動式 ETF「主動加碼」追蹤（11/27 使用者：主動式 ETF 買超當參考，有依據再納入條件）：
// 每個資料日，取被 MIN 檔以上主動式 ETF 同時主動加碼（扣掉申購造成的同比例買進，見 tiltOf）的個股，依家數多寡取前 TOP 檔；
// 看到資料的「隔天」收盤買進（資料晚上才公布，當天收盤買不到），之後 5、20 個交易日報酬，減去同期成交金額 ≥ 5 千萬個股的平均（超額）。
// 也算「主動減碼」那組當對照。只有累積到的日子才算，不回補。
import type { BtDay } from "./backtest";
import type { TiltCount } from "../lib/activeEtf";

export const ATRACK = { min: 3, top: 10, minValue: 5e7, horizons: [5, 20] as const } as const;
export interface TrackStat { n: number; avg: number; win: number }
export interface ActiveTrack {
  version: 1; asOf: string; from: string; signalDays: number;
  buy: Record<string, TrackStat>; sell: Record<string, TrackStat>;
  recent: { date: string; picks: { code: string; name: string; n: number }[]; ex5?: number }[];
}

export function runActiveTrack(days: BtDay[], tilts: TiltCount[]): ActiveTrack {
  const asc = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const idx = new Map(asc.map((d, i) => [d.date, i]));
  const rows = asc.map((d) => new Map(d.quotes.map((r) => [r[0], r])));
  const stock = (c: string) => /^[1-9]\d{3}$/.test(c);
  const fwd = (i: number, n: number, codes: string[]) => {
    const e = i + 1, x = e + n;
    if (x >= asc.length) return undefined;
    const r = (c: string) => { const a = rows[e].get(c)?.[2], b = rows[x].get(c)?.[2]; return a && b && b / a > 0.5 && b / a < 2 ? b / a - 1 : undefined; };
    const pr = codes.map(r).filter((v): v is number => v !== undefined);
    const all = [...rows[e]].filter(([c, q]) => stock(c) && q[4] >= ATRACK.minValue).map(([c]) => r(c)).filter((v): v is number => v !== undefined);
    if (!pr.length || !all.length) return undefined;
    return pr.reduce((a, b) => a + b, 0) / pr.length - all.reduce((a, b) => a + b, 0) / all.length;
  };
  const acc = () => Object.fromEntries(ATRACK.horizons.map((n) => [n, [] as number[]]));
  const res = { buy: acc(), sell: acc() };
  const recent: ActiveTrack["recent"] = [];
  let signalDays = 0;
  for (const t of tilts) {
    const i = idx.get(t.date); if (i === undefined) continue;
    const pick = (m: Record<string, string[]>) => Object.entries(m).filter(([c, e]) => stock(c) && e.length >= ATRACK.min && (rows[i].get(c)?.[4] ?? 0) >= ATRACK.minValue)
      .sort((a, b) => b[1].length - a[1].length || (rows[i].get(b[0])?.[4] ?? 0) - (rows[i].get(a[0])?.[4] ?? 0)).slice(0, ATRACK.top);
    const b = pick(t.buy), s = pick(t.sell);
    if (!b.length) continue;
    signalDays++;
    for (const n of ATRACK.horizons) {
      const xb = fwd(i, n, b.map((x) => x[0])); if (xb !== undefined) res.buy[n].push(xb);
      const xs = s.length ? fwd(i, n, s.map((x) => x[0])) : undefined; if (xs !== undefined) res.sell[n].push(xs);
    }
    recent.push({ date: t.date, picks: b.map(([c, e]) => ({ code: c, name: rows[i].get(c)?.[1] ?? c, n: e.length })), ex5: fwd(i, 5, b.map((x) => x[0])) });
  }
  const st = (xs: number[]): TrackStat => ({ n: xs.length, avg: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0, win: xs.length ? xs.filter((x) => x > 0).length / xs.length : 0 });
  const map = (r: Record<string, number[]>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, st(v)]));
  return { version: 1, asOf: asc.at(-1)?.date ?? "", from: tilts.find((t) => idx.has(t.date))?.date ?? "", signalDays, buy: map(res.buy), sell: map(res.sell), recent: recent.slice(-10).reverse() };
}
