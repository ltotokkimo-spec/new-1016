// 當沖用「盤中成交量即時排名」（11/12 使用者）：從候選名單的即時報價排出前 N 名，並算出這一輪名次的升降。
export interface RankQuote { code: string; name: string; price: number; prevClose: number; volume?: number; time?: string; final?: boolean; date?: string }
export interface RankRow { code: string; name: string; price: number; chg: number; lots: number; value: number; rank: number; move: number | "new"; time?: string }
export type RankBy = "vol" | "value";

/** 候選名單：前一個交易日成交量最大的股票（含 ETF 時另外加 ETF 前幾名）；當天爆量的股票通常前一天量也不小 */
export function rankPool<T extends { code: string; volume?: number; value?: number }>(stocks: T[], etfs: T[], nStock = 200, nEtf = 40): T[] {
  const byVol = (a: T, b: T) => (b.volume ?? 0) - (a.volume ?? 0);
  const out = [...stocks].sort(byVol).slice(0, nStock);
  if (nEtf > 0) out.push(...[...etfs].sort(byVol).slice(0, nEtf));
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x.code) ? false : (seen.add(x.code), true)));
}

/** 依成交量（張）或估計成交值排出前 n 名；prev＝上一輪的名次（代號→名次），算升降與「新進榜」 */
export function rankQuotes(qs: RankQuote[], by: RankBy, n = 15, prev?: Map<string, number>): RankRow[] {
  const rows = qs
    .filter((q) => Number.isFinite(q.volume) && (q.volume ?? 0) > 0 && q.price > 0)
    .map((q) => ({ code: q.code, name: q.name, price: q.price, chg: q.prevClose > 0 ? q.price / q.prevClose - 1 : 0, lots: Math.round((q.volume ?? 0) / 1000), value: q.price * (q.volume ?? 0), time: q.time }))
    .sort((a, b) => (by === "vol" ? b.lots - a.lots || b.value - a.value : b.value - a.value || b.lots - a.lots))
    .slice(0, n);
  return rows.map((r, i) => {
    const p = prev?.get(r.code);
    return { ...r, rank: i + 1, move: !prev || !prev.size ? 0 : p === undefined ? "new" : p - (i + 1) };
  });
}

/** 成交值：億／萬 */
export const fmtValue = (v: number) => (v >= 1e8 ? `${(v / 1e8).toFixed(v >= 1e10 ? 0 : 1)} 億` : `${Math.round(v / 1e4).toLocaleString("zh-TW")} 萬`);

// ---------- 當沖推薦（11/25 使用者）----------
// 只挑「適合當沖」的標的，不預測漲跌：成交值大（好進出、價差小）、今天振幅夠（有空間）、量能比平常放大（有人在玩）。
// 排除漲停／跌停鎖住（買不到或賣不掉）、處置股、不可當沖標的。只標今天的位置（高檔／低檔／區間中段），不給做多做空的方向。
// 沒有盤中歷史資料可以回測，只是篩選與排序規則，不是勝率保證。
export interface DtPickQuote extends RankQuote { open?: number; high?: number; low?: number; limit?: "up" | "down" }
export interface DtPick { code: string; name: string; price: number; chg: number; value: number; range: number; relVol: number; pos: number; score: number; bias: "高檔" | "低檔" | "區間中段"; rank: number }

/** elapsed＝今天交易時段已經過的比例（0～1，收盤後＝1）；prevVol＝前一個交易日成交量（股）；skip＝要排除的代號（處置、不可當沖） */
export function dtPicks(qs: DtPickQuote[], prevVol: Map<string, number>, elapsed: number, skip: (code: string) => boolean = () => false, n = 10): DtPick[] {
  const el = Math.min(1, Math.max(0.1, elapsed));
  const cand = qs.filter((q) => q.price > 0 && q.prevClose > 0 && (q.volume ?? 0) > 0 && Number.isFinite(q.high) && Number.isFinite(q.low) && (q.high ?? 0) >= (q.low ?? 0) && !q.limit && !skip(q.code))
    .map((q) => {
      const value = q.price * (q.volume ?? 0), range = ((q.high! - q.low!) / q.prevClose), pv = prevVol.get(q.code) ?? 0;
      const relVol = pv > 0 ? (q.volume ?? 0) / (pv * el) : 1;
      const pos = q.high! > q.low! ? (q.price - q.low!) / (q.high! - q.low!) : 0.5;
      const chg = q.price / q.prevClose - 1, open = Number.isFinite(q.open) && (q.open ?? 0) > 0 ? q.open! : q.prevClose;
      // 11/25 回測（上市近半年）：照前一天「偏多做多、偏空放空」隔天平均 −0.8%、勝率 41%，方向沒有優勢 → 改成中性描述今天的位置
      const bias: DtPick["bias"] = pos >= 0.7 ? "高檔" : pos <= 0.3 ? "低檔" : "區間中段";
      return { code: q.code, name: q.name, price: q.price, chg, value, range, relVol, pos, bias, score: 0, rank: 0 };
    })
    .filter((x) => x.value >= 1e8 * el && x.range >= 0.015); // 至少 1 億（依時段比例）、振幅 1.5% 以上
  const byValue = [...cand].sort((a, b) => a.value - b.value);
  const pct = new Map(byValue.map((x, i) => [x.code, cand.length > 1 ? i / (cand.length - 1) : 1]));
  for (const x of cand) x.score = 0.4 * (pct.get(x.code) ?? 0) + 0.3 * Math.min(1, x.range / 0.06) + 0.3 * Math.min(1, x.relVol / 3);
  return cand.sort((a, b) => b.score - a.score).slice(0, n).map((x, i) => ({ ...x, score: Math.round(x.score * 100), rank: i + 1 }));
}
