// N5 觀察組合（使用者 2026-10-23 指定套用並觀察）：虛擬 50 萬，一半買 0050，一半照方案 A 選股，每天重新判斷（10/29 使用者從每 5 個交易日改成每天）。
// 完全由規則自動算（不需要 Claude），每天回測工作流程跑完後輸出 n5.json（和 Claude 虛擬 ETF 同格式），App 直接顯示。
// 成交規則和 2 年回測一致：第 j 天收盤後決定，第 j+1 天收盤價成交，已計手續費與證交稅。
import { cashFlow, positions, recordNav, valuate, type EtfTrade } from "./aiEtf";
import type { BtDay } from "./backtest";
import { DUALPLUS, buyCodesAt, aiTargets, aPicks, buildCtx, DUAL, GROWTH, growthPicks, type GrowthPick, LEAD, leadTargets, REAL, realTargets, regimeStep, STEADY, TURN2, turnPicker, wideTargets } from "./steady";
import type { RevTable } from "./revHist";
import type { DualVeto } from "./virtualEtf";
import { addNote, newVirtual, type PendingOrder, type VirtualEtf } from "./virtualEtf";
import type { Company } from "../data/tw";

export const WATCH = {
  start: "20261023", // 第一次決定的日期（當天收盤後選股，下一個交易日收盤成交）
  budget: 500_000,
  core: 0.5, // 0050 比重；其餘給方案 A
  every: 5, // 每幾個交易日調整一次（約每週）：現在只有攻守輪動用；N5、權值強化 10/29 起改成每天
  aiEvery: 20, // AI 供應鏈每幾個交易日調整一次（約每月，和回測一致）
  minTrade: 0.002, // 與目標差距小於淨值的 0.2% 就不動，避免零碎交易
} as const;
const BENCH = "0050";
const r2 = (x: number) => Math.round(x * 100) / 100;
const pc = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;

/**
 * mode "n5"：0050 五成＋方案 A 五成，每天重新判斷（10/29 使用者從每 5 個交易日改成每天），差距小於淨值 0.2% 就不動。
 * mode "wide"：全個股（不放 0050）、不限檔數，條件同 A（見 wideTargets），每天重新判斷，只做局部修正。
 * mode "dual"：雙引擎（使用者 11/14 同意上線）：成長組五成（每 20 個交易日重選，需要 opts.rev 歷史月營收）＋方案 A 五成（每 5 個交易日重選）。
 *   雙引擎＋（11/18 使用者要求乾淨重新開始）起始日是 DUALPLUS.rankFrom（11/17）：新規則從 11/17 收盤的判斷起算，歷史不含舊規則；原版雙引擎起始日是 DUAL.start（規則定案前最後一個資料日 11/13），不是其他組的 10/23：規則是看過 11/13 以前的資料才訂的，從定案日起算才是真正的事後觀察。
 */
export function runWatch(days: BtDay[], companies: Company[], opts: { start?: string; budget?: number; now?: number; mode?: "n5" | "wide" | "regime" | "lead" | "ai" | "real" | "turn" | "dual" | "dualplus"; rev?: RevTable; vetoes?: DualVeto[]; rankFrom?: string; buyAt?: (j: number) => ReadonlySet<string> } = {}): VirtualEtf {
  const wide = opts.mode === "wide", regime = opts.mode === "regime", lead = opts.mode === "lead", ai = opts.mode === "ai", real = opts.mode === "real", turn = opts.mode === "turn", plus = opts.mode === "dualplus", dual = opts.mode === "dual" || plus;
  // 雙引擎＋：當天有效的新聞否決（代號 → 否決）
  const vetoAt = (d: string) => new Map((plus ? opts.vetoes ?? [] : []).filter((x) => x.from <= d && (!x.until || d <= x.until)).map((x) => [x.code, x]));
  let lastA: Map<string, number> | undefined;
  const rankFrom = opts.rankFrom ?? DUALPLUS.rankFrom;
  let curGroups: Record<string, "growth" | "steady" | "both"> | undefined; // 雙引擎：最近一次判斷的分類 // 雙引擎＋：非判斷日因否決臨時調整時，沿用上次的低波動組
  let regimeOn: boolean | undefined; // 攻守輪動目前的狀態
  const start = opts.start ?? (plus ? DUALPLUS.rankFrom : dual ? DUAL.start : WATCH.start), budget = opts.budget ?? WATCH.budget;
  let v: VirtualEtf = { ...newVirtual(start, budget), updatedAt: opts.now ?? Date.now(), stops: {} };
  const c = buildCtx(days, companies, opts.rev);
  let growth: GrowthPick[] = []; // 雙引擎：成長組目前的選股（每 20 個交易日重選）
  const j0 = c.dates.findIndex((d) => d >= start);
  const jRank = plus ? c.dates.findIndex((d) => d >= rankFrom) : -1; // 雙引擎＋：新規則（候選限定選股頁「買入」）從這天起算：這天做第一次判斷（成長組也重選），之後每 5 個交易日判斷、成長組每 20 個交易日重選
  if (j0 < 0 || j0 < STEADY.lookback + 25) return v; // 還沒到開始日（或資料不夠）
  const close = (code: string, j: number) => { const r = c.rows[j].get(code); return r && r[2] > 0 ? r[2] : undefined; };
  const name = (code: string, j: number) => c.rows[j].get(code)?.[1] ?? code;

  let lastDecision: string | undefined; // 最近一次判斷日
  let curTarget: Map<string, number> | undefined, curTargetDate = ""; // 最近一次判斷的目標（不論哪天判斷的）
  let lastDayTarget = undefined as Map<string, number> | undefined; // 最後一個資料日收盤後做的決定（明天要成交的目標，還沒成交）
  let target = null as Map<string, number> | null; // 昨天收盤後決定、今天收盤要調整成的目標
  const trades: EtfTrade[] = [];
  const last: VirtualEtf["last"] = {};
  const hold = new Map<string, number>(); // 代號 → 股數
  let cash = budget;
  // 剛轉強（使用者 11/04 選 T1-混合）：每天收盤判斷；選股器自己記住持股的買進日與買進價，所以要從起始日每天依序呼叫
  const turnPick = turn ? turnPicker(c, { strict: false, regime: false, exit: "hybrid" }) : undefined;
  for (let j = j0; j < c.N; j++) {
    const date = c.dates[j];
    const setTarget = (t: Map<string, number>) => { curTarget = t; curTargetDate = date; if (j < c.N - 1) target = t; else lastDayTarget = t; };
    const bench = close(BENCH, j);
    // 1. 執行昨天決定的調整（今天收盤價）
    if (target && bench) {
      const px = (code: string) => close(code, j) ?? last[code]?.close ?? 0;
      let total = cash;
      for (const [code, sh] of hold) total += sh * px(code);
      const minAmt = total * (wide ? STEADY.wideBand : turn ? TURN2.band : dual ? DUAL.band : lead || ai ? LEAD.band : WATCH.minTrade);
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
    // 3. 收盤後重新選股：全個股、N5、權值強化每天；攻守輪動每 5 個交易日；AI 供應鏈每 20 個交易日
    const scheduled = wide || lead || turn || !(regime || ai || real || dual) || (j - (jRank >= 0 && j >= jRank ? jRank : j0)) % (ai ? WATCH.aiEvery : real ? REAL.every : dual ? DUAL.every : WATCH.every) === 0;
    const vetoNow = vetoAt(date);
    // 雙引擎＋：持股當天被否決，就算不是判斷日也要在收盤後排賣出
    const decide = scheduled || (plus && [...hold.keys()].some((k) => vetoNow.has(k)));
    // 實單規則：每天收盤檢查停損（跌破成本 10%），跌破的明天賣出；其餘持股不動
    const stopped = real ? positions(trades).filter((p) => p.shares > 0 && hold.has(p.code) && (close(p.code, j) ?? Infinity) < p.avgCost * (1 - REAL.stop)) : [];
    if (decide) lastDecision = date;
    let text = `資料日收盤：組合 ${pc(val.ret, 2)}，0050 對照 ${pc(val.benchRet, 2)}；股票 ${val.nav > 0 ? Math.round((val.marketValue / val.nav) * 100) : 0}%，持有 ${hold.size} 檔。`;
    if (turn && turnPick) {
      const t = turnPick(j);
      setTarget(t);
      const adds = [...t.keys()].filter((code) => !hold.has(code)), drops = [...hold.keys()].filter((code) => !t.has(code));
      const nm = (list: string[]) => (list.length ? list.map((code) => `${name(code, j)}${code}`).join("、") : "無");
      text += `\n本日判斷：剛轉強訊號（站上 20 日線 0～5%、MACD 5 天內翻正、RSI<70、外資＋投信 5 日買超）每天最多新增 2 檔、每檔 ${Math.round(TURN2.weight * 100)}%、最多 ${TURN2.maxN} 檔；持有 ${t.size} 檔。下一個交易日收盤價調整，新增：${nm(adds)}；賣出：${nm(drops)}（跌破買進價 8%，或滿 20 個交易日後跌破 20 日線）。`;
    } else if (real && (decide || stopped.length)) {
      const stopSet = new Set(stopped.map((p) => p.code));
      let t: Map<string, number>;
      if (decide) {
        t = realTargets(days, companies, c, j);
        for (const code of stopSet) t.delete(code);
      } else {
        // 不是換股日：只賣停損的，其他維持目前比重
        let total = cash; const px = (code: string) => close(code, j) ?? last[code]?.close ?? 0;
        for (const [code, sh] of hold) total += sh * px(code);
        t = new Map([...hold].filter(([code]) => !stopSet.has(code)).map(([code, sh]) => [code, total > 0 ? (sh * px(code)) / total : 0]));
      }
      setTarget(t);
      const list = [...t].sort((a, b) => b[1] - a[1]).map(([code, w]) => `${name(code, j)}${code} ${(w * 100).toFixed(1)}%`).join("、");
      text += decide
        ? `\n本日判斷（每 ${REAL.every} 個交易日）：App「買入」候選（每產業最多 ${REAL.perSector} 檔、成交金額達門檻）分數前 ${REAL.pick} 檔等權：${list || "目前沒有符合的，先放現金"}。下一個交易日收盤價調整。`
        : "";
      if (stopped.length) text += `\n停損：${stopped.map((p) => `${p.name}${p.code}（收盤跌破成本 ${Math.round(REAL.stop * 100)}%）`).join("、")}，下一個交易日收盤價賣出。`;
    } else if (decide && wide) {
      const t = wideTargets(c, j, new Set(hold.keys()));
      setTarget(t);
      const adds = [...t.keys()].filter((code) => !hold.has(code)), drops = [...hold.keys()].filter((code) => !t.has(code));
      const nm = (list: string[]) => (list.length ? list.slice(0, 8).map((code) => `${name(code, j)}${code}`).join("、") + (list.length > 8 ? `…共 ${list.length} 檔` : "") : "無");
      text += `\n本日判斷：符合條件 ${t.size} 檔（不限檔數）。下一個交易日收盤價調整，新增：${nm(adds)}；剔除：${nm(drops)}；其餘差距小於淨值 ${(STEADY.wideBand * 100).toFixed(1)}% 的不動。`;
    } else if (decide && ai) {
      const t = aiTargets(c, j, { weight: "cap" });
      setTarget(t);
      const top = [...t].sort((a, b) => b[1] - a[1]);
      const list = top.slice(0, 10).map(([code, w]) => `${name(code, j)}${code} ${(w * 100).toFixed(1)}%`).join("、");
      text += `\n本日判斷：AI 供應鏈清單依市值配置（單檔上限 35%），共 ${top.length} 檔，前 10 大：${list || "無"}。下一個交易日收盤價調整（每 ${WATCH.aiEvery} 個交易日調整一次）。`;
    } else if (decide && lead) {
      const r = leadTargets(c, j);
      setTarget(r.targets);
      const top = [...r.targets].sort((a, b) => b[1] - a[1]);
      const list = top.slice(0, 10).map(([code, w]) => `${name(code, j)}${code} ${(w * 100).toFixed(1)}%`).join("、");
      text += `\n本日判斷：${r.byCap ? "市值" : "成交金額"}前 ${LEAD.universe} 大個股，依市值配置再依趨勢、外資、投信、走勢品質調整（滿倉）；目標持股 ${Math.round(r.exposure * 100)}%、${top.length} 檔，前 10 大：${list || "無"}。下一個交易日收盤價調整。`;
    } else if (decide && regime) {
      const r = regimeStep(c, j, regimeOn);
      regimeOn = r.on;
      setTarget(r.targets);
      const sat = [...r.targets].filter(([code]) => code !== BENCH).sort((a, b) => b[1] - a[1]);
      const list = sat.map(([code, w]) => `${name(code, j)}${code} ${(w * 100).toFixed(1)}%`).join("、");
      text += `\n市場狀態：${r.on ? "進攻（0050 站上 60 日線）" : "防守（0050 跌破 60 日線）"}；目標 0050 ${Math.round((r.targets.get(BENCH) ?? 0) * 100)}%，方案 A ${sat.length} 檔：${list || "目前沒有符合的，先放現金"}。下一個交易日收盤價調整。`;
    } else if (decide && dual) {
      // 雙引擎＋（11/17）：從 rankFrom 起，兩組候選都限定在當天選股頁「買入」；rankFrom 那天做第一次判斷（成長組也重選），之後的節奏從那天重新算
      const onNew = plus && jRank >= 0 && j >= jRank;
      const useList = onNew;
      const reGrowth = (j - (onNew ? jRank : j0)) % GROWTH.every === 0;
      const allow = useList && (reGrowth || scheduled || !lastA) ? (opts.buyAt ? opts.buyAt(j) : buyCodesAt(days, companies, c, j)) : undefined;
      if (reGrowth) growth = growthPicks(c, j, new Set(growth.map((x) => x.code)), allow);
      const a = scheduled || !lastA ? aPicks(c, j, { foreignOk: plus, allow }) : lastA;
      lastA = a;
      const t = new Map<string, number>();
      for (const x of growth) t.set(x.code, (t.get(x.code) ?? 0) + x.weight * DUAL.growth);
      for (const [code, w] of a) t.set(code, (t.get(code) ?? 0) + w * DUAL.steady);
      const vetoed = [...t.keys(), ...hold.keys()].filter((k, i, arr) => arr.indexOf(k) === i && vetoNow.has(k));
      for (const k of vetoed) t.delete(k); // 否決的不買、已持有的賣出；那部分先放現金
      const gs = new Set(growth.map((x) => x.code));
      curGroups = Object.fromEntries([...t.keys()].map((k) => [k, gs.has(k) && a.has(k) ? "both" : gs.has(k) ? "growth" : "steady"]));
      setTarget(t);
      // 每檔一行、比重大的在前（11/15 使用者：原本擠成一段太亂）
      const gl = [...growth].sort((a, b) => b.weight - a.weight).map((x) => `・${name(x.code, j)} ${x.code}　${(x.weight * DUAL.growth * 100).toFixed(1)}%　營收年增 ${pc(x.yoy3, 0)}${x.newHigh ? "・創高" : ""}`).join("\n");
      const al = [...a].sort((x, y) => y[1] - x[1]).map(([code, w]) => `・${name(code, j)} ${code}　${(w * DUAL.steady * 100).toFixed(1)}%`).join("\n");
      text += `\n\n【成長組】${reGrowth ? "重新選股" : `沿用上次選股（每 ${GROWTH.every} 個交易日重選）`}${reGrowth && useList ? "（候選限定當天選股頁「買入」）" : ""}，${growth.length} 檔：\n${gl || (c.rev ? "目前沒有符合的，這部分先放現金" : "沒有下載到月營收資料，這部分先放現金")}`
        + `\n\n【低波動組】每 ${DUAL.every} 個交易日重選${plus ? "，外資近 60 日沒有賣超才選" : ""}${useList ? "，候選限定當天選股頁「買入」" : ""}，${a.size} 檔：\n${al || "目前沒有符合的，這部分先放現金"}`
        + (vetoed.length ? `\n\n【新聞否決】不買／賣出，那部分先放現金：\n${vetoed.map((k) => `・${name(k, j)} ${k}：${vetoNow.get(k)!.reason}`).join("\n")}` : "")
        + "\n\n"
        + (scheduled ? "" : "（今天不是判斷日，只因否決調整，其他持股不動。）\n") + "下一個交易日收盤價調整。";
    } else if (decide) {
      const a = aPicks(c, j);
      const t = new Map<string, number>([[BENCH, WATCH.core]]);
      for (const [code, w] of a) t.set(code, (t.get(code) ?? 0) + w * (1 - WATCH.core));
      setTarget(t); // 最後一天的決定還沒成交，下次有新資料時會重算並執行
      const list = [...a].map(([code, w]) => `${name(code, j)}${code} ${(w * (1 - WATCH.core) * 100).toFixed(1)}%`).join("、");
      text += `\n本日重新選股：0050 目標 ${Math.round(WATCH.core * 100)}%；方案 A ${a.size} 檔（各佔淨值）${list || "：目前沒有符合的，這部分先放現金"}。下一個交易日收盤價調整。`;
    }
    if (decide || stopped.length || j === c.N - 1) v = addNote(v, date, text);
  }
  // 明天（下一個交易日）要調整的股票：最後一個資料日收盤後的目標，和目前持股的差距（數量用今天收盤價估算，實際以明天收盤價成交）
  const pending: PendingOrder[] = [];
  if (lastDayTarget && v.asOf) {
    const px = (code: string) => v.last[code]?.close ?? close(code, c.N - 1) ?? 0;
    let total = cash;
    for (const [code, sh] of hold) total += sh * px(code);
    const minAmt = total * (wide ? STEADY.wideBand : turn ? TURN2.band : dual ? DUAL.band : lead || ai ? LEAD.band : WATCH.minTrade);
    const nm = (code: string) => name(code, c.N - 1);
    for (const [code, sh] of hold) { // 先賣
      const p = px(code), want = (lastDayTarget.get(code) ?? 0) * total, have = sh * p;
      if (!(p > 0) || (lastDayTarget.has(code) && have - want <= minAmt)) continue;
      const n = lastDayTarget.has(code) ? Math.min(sh, Math.floor((have - want) / p)) : sh;
      if (n > 0) pending.push({ code, name: nm(code), side: "sell", shares: n, reason: lastDayTarget.has(code) ? `減碼：目標 ${(lastDayTarget.get(code)! * 100).toFixed(1)}%，目前 ${((have / total) * 100).toFixed(1)}%` : "不在今天的規則名單，全部賣出", placed: v.asOf });
    }
    for (const [code, w] of lastDayTarget) { // 再買
      const p = px(code), have = (hold.get(code) ?? 0) * p, gap = w * total - have;
      if (!(p > 0) || gap <= minAmt) continue;
      const n = Math.floor(gap / p);
      if (n > 0) pending.push({ code, name: nm(code), side: "buy", shares: n, reason: have > 0 ? `加碼：目標 ${(w * 100).toFixed(1)}%，目前 ${((have / total) * 100).toFixed(1)}%` : `新增：目標 ${(w * 100).toFixed(1)}%`, placed: v.asOf });
    }
  }
  const every = wide || lead || turn || !(regime || ai || real || dual) ? 1 : ai ? WATCH.aiEvery : real ? REAL.every : dual ? DUAL.every : WATCH.every;
  const nextStock = lastDayTarget ? [...lastDayTarget.values()].reduce((a, b) => a + b, 0) : undefined; // 明天調整完的股票目標比重（其餘是現金）
  const lastVetoes = plus && v.asOf ? [...vetoAt(v.asOf).values()].map((x) => ({ ...x, name: x.name ?? name(x.code, c.N - 1) })) : undefined;
  return { ...v, pending, ...(lastVetoes ? { vetoes: lastVetoes } : {}), ...(curGroups ? { groups: curGroups } : {}), ...(curTarget ? { targets: Object.fromEntries([...curTarget].map(([k, w]) => [k, Math.round(w * 1e6) / 1e6])), targetsDate: curTargetDate } : {}), plan: { every, lastDecision, nextStock, band: wide ? STEADY.wideBand : turn ? TURN2.band : dual ? DUAL.band : lead || ai ? LEAD.band : WATCH.minTrade } };
}
