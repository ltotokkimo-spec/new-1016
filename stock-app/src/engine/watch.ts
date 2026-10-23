// N5 觀察組合（使用者 2026-10-23 指定套用並觀察）：虛擬 50 萬，一半買 0050，一半照方案 A 選股，每 5 個交易日調整一次。
// 完全由規則自動算（不需要 Claude），每天回測工作流程跑完後輸出 n5.json（和 Claude 虛擬 ETF 同格式），App 直接顯示。
// 成交規則和 2 年回測一致：第 j 天收盤後決定，第 j+1 天收盤價成交，已計手續費與證交稅。
import { cashFlow, recordNav, valuate, type EtfTrade } from "./aiEtf";
import type { BtDay } from "./backtest";
import { aPicks, buildCtx, LEAD, leadTargets, regimeStep, STEADY, wideTargets } from "./steady";
import { addNote, newVirtual, type VirtualEtf } from "./virtualEtf";
import type { Company } from "../data/tw";

export const WATCH = {
  start: "20261023", // 第一次決定的日期（當天收盤後選股，下一個交易日收盤成交）
  budget: 500_000,
  core: 0.5, // 0050 比重；其餘給方案 A
  every: 5, // 每幾個交易日調整一次（約每週）
  minTrade: 0.002, // 與目標差距小於淨值的 0.2% 就不動，避免零碎交易
} as const;
const BENCH = "0050";
const r2 = (x: number) => Math.round(x * 100) / 100;
const pc = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;

/**
 * mode "n5"：0050 五成＋方案 A 五成，每 5 個交易日調整。
 * mode "wide"：全個股（不放 0050）、不限檔數，條件同 A（見 wideTargets），每天重新判斷，只做局部修正。
 */
export function runWatch(days: BtDay[], companies: Company[], opts: { start?: string; budget?: number; now?: number; mode?: "n5" | "wide" | "regime" | "lead" } = {}): VirtualEtf {
  const wide = opts.mode === "wide", regime = opts.mode === "regime", lead = opts.mode === "lead";
  let regimeOn: boolean | undefined; // 攻守輪動目前的狀態
  const start = opts.start ?? WATCH.start, budget = opts.budget ?? WATCH.budget;
  let v: VirtualEtf = { ...newVirtual(start, budget), updatedAt: opts.now ?? Date.now(), stops: {} };
  const c = buildCtx(days, companies);
  const j0 = c.dates.findIndex((d) => d >= start);
  if (j0 < 0 || j0 < STEADY.lookback + 25) return v; // 還沒到開始日（或資料不夠）
  const close = (code: string, j: number) => { const r = c.rows[j].get(code); return r && r[2] > 0 ? r[2] : undefined; };
  const name = (code: string, j: number) => c.rows[j].get(code)?.[1] ?? code;

  let target: Map<string, number> | null = null; // 昨天收盤後決定、今天收盤要調整成的目標
  const trades: EtfTrade[] = [];
  const last: VirtualEtf["last"] = {};
  const hold = new Map<string, number>(); // 代號 → 股數
  let cash = budget;
  for (let j = j0; j < c.N; j++) {
    const date = c.dates[j];
    const bench = close(BENCH, j);
    // 1. 執行昨天決定的調整（今天收盤價）
    if (target && bench) {
      const px = (code: string) => close(code, j) ?? last[code]?.close ?? 0;
      let total = cash;
      for (const [code, sh] of hold) total += sh * px(code);
      const minAmt = total * (wide ? STEADY.wideBand : lead ? LEAD.band : WATCH.minTrade);
      const book = (code: string, side: "buy" | "sell", shares: number) => {
        const price = r2(px(code));
        const t: EtfTrade = { id: `${date}-${code}-${side}`, date, code, name: name(code, j), side, shares, price, benchPrice: bench };
        trades.push(t); cash += cashFlow(t);
        hold.set(code, (hold.get(code) ?? 0) + (side === "buy" ? shares : -shares));
        if ((hold.get(code) ?? 0) <= 0) hold.delete(code);
      };
      for (const [code, sh] of [...hold]) { // 先賣
        if (!close(code, j)) continue; // 停牌：下次再處理
        const want = (target.get(code) ?? 0) * total, have = sh * px(code);
        if (have - want <= minAmt && target.has(code)) continue;
        const n = target.has(code) ? Math.min(sh, Math.floor((have - want) / px(code))) : sh;
        if (n > 0) book(code, "sell", n);
      }
      for (const [code, w] of target) { // 再買
        if (!close(code, j)) continue;
        const have = (hold.get(code) ?? 0) * px(code), gap = w * total - have;
        if (gap <= minAmt) continue;
        const n = Math.floor(Math.min(gap, cash / 1.001425) / r2(px(code)));
        if (n > 0) book(code, "buy", n);
      }
      target = null;
    }
    // 2. 更新持股與 0050 的收盤價，記錄今天的淨值
    for (const code of Object.keys(last)) if (!hold.has(code) && code !== BENCH) delete last[code];
    for (const code of [...hold.keys(), BENCH]) { const p = close(code, j); if (p) last[code] = { name: name(code, j), close: p }; }
    v = { ...v, trades: [...trades], last: { ...last }, asOf: date };
    const val = valuate(v, (code) => close(code, j) ?? last[code]?.close);
    if (!val.missing.length) v = { ...v, ...recordNav(v, date, val) };
    // 3. 收盤後：每 5 個交易日重新選股
    const decide = wide || (j - j0) % WATCH.every === 0;
    let text = `資料日收盤：組合 ${pc(val.ret, 2)}，0050 對照 ${pc(val.benchRet, 2)}；股票 ${val.nav > 0 ? Math.round((val.marketValue / val.nav) * 100) : 0}%，持有 ${hold.size} 檔。`;
    if (decide && wide) {
      const t = wideTargets(c, j, new Set(hold.keys()));
      if (j < c.N - 1) target = t;
      const adds = [...t.keys()].filter((code) => !hold.has(code)), drops = [...hold.keys()].filter((code) => !t.has(code));
      const nm = (list: string[]) => (list.length ? list.slice(0, 8).map((code) => `${name(code, j)}${code}`).join("、") + (list.length > 8 ? `…共 ${list.length} 檔` : "") : "無");
      text += `\n本日判斷：符合條件 ${t.size} 檔（不限檔數）。下一個交易日收盤價調整，新增：${nm(adds)}；剔除：${nm(drops)}；其餘差距小於淨值 ${(STEADY.wideBand * 100).toFixed(1)}% 的不動。`;
    } else if (decide && lead) {
      const r = leadTargets(c, j);
      if (j < c.N - 1) target = r.targets;
      const top = [...r.targets].sort((a, b) => b[1] - a[1]);
      const list = top.slice(0, 10).map(([code, w]) => `${name(code, j)}${code} ${(w * 100).toFixed(1)}%`).join("、");
      text += `\n本日判斷：${r.byCap ? "市值" : "成交金額"}前 ${LEAD.universe} 大個股，依市值配置再依趨勢、外資、投信、走勢品質調整（滿倉）；目標持股 ${Math.round(r.exposure * 100)}%、${top.length} 檔，前 10 大：${list || "無"}。下一個交易日收盤價調整。`;
    } else if (decide && regime) {
      const r = regimeStep(c, j, regimeOn);
      regimeOn = r.on;
      if (j < c.N - 1) target = r.targets;
      const sat = [...r.targets].filter(([code]) => code !== BENCH).sort((a, b) => b[1] - a[1]);
      const list = sat.map(([code, w]) => `${name(code, j)}${code} ${(w * 100).toFixed(1)}%`).join("、");
      text += `\n市場狀態：${r.on ? "進攻（0050 站上 60 日線）" : "防守（0050 跌破 60 日線）"}；目標 0050 ${Math.round((r.targets.get(BENCH) ?? 0) * 100)}%，方案 A ${sat.length} 檔：${list || "目前沒有符合的，先放現金"}。下一個交易日收盤價調整。`;
    } else if (decide) {
      const a = aPicks(c, j);
      if (j < c.N - 1) { // 最後一天的決定還沒成交，下次有新資料時會重算並執行
        target = new Map([[BENCH, WATCH.core]]);
        for (const [code, w] of a) target.set(code, (target.get(code) ?? 0) + w * (1 - WATCH.core));
      }
      const list = [...a].map(([code, w]) => `${name(code, j)}${code} ${(w * (1 - WATCH.core) * 100).toFixed(1)}%`).join("、");
      text += `\n本日重新選股：0050 目標 ${Math.round(WATCH.core * 100)}%；方案 A ${a.size} 檔（各佔淨值）${list || "：目前沒有符合的，這部分先放現金"}。下一個交易日收盤價調整。`;
    }
    if (decide || j === c.N - 1) v = addNote(v, date, text);
  }
  return v;
}
