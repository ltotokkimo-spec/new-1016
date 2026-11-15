// 雙引擎實單（使用者 11/15）：用真的錢照「雙引擎」觀察組合的目標配置下單，和「我的實單」分開記帳。
// 本金 50 萬（和觀察組合的虛擬資金一樣）；完全照觀察組合：和目標差距 ≥ 淨值 0.5% 才調整（DUAL.band），其餘不動。
// 目標配置由每天的回測算好（dual.json 的 targets：最後一個資料日收盤後的目標權重，下一個交易日調整）。
import { cashFlow, positions, valuate, FEE, type AiEtf } from "./aiEtf";

export const DUAL_REAL = { budget: 500_000, band: 0.005 } as const;

export interface DualOrder { code: string; name: string; side: "buy" | "sell"; shares: number; price: number; target: number; now: number; reason: string }

/**
 * 依目標權重算出這個帳戶要下的單：先賣後買；目標裡沒有的持股全部賣出；
 * 和目標差距小於淨值 band 的不動；買進受現金限制（先算完賣出回收的錢），股數無條件捨去（零股）。
 * price：估算用的價格（收盤價）；沒有價格的股票跳過。
 */
export function dualOrders(etf: AiEtf, targets: Record<string, number>, price: (code: string) => number | undefined, name: (code: string) => string, band: number = DUAL_REAL.band): DualOrder[] {
  const v = valuate(etf, price);
  const nav = v.nav;
  if (!(nav > 0)) return [];
  const held = new Map(positions(etf.trades).filter((p) => p.shares > 0).map((p) => [p.code, p]));
  const out: DualOrder[] = [];
  let cash = v.cash;
  const reserve = Math.max(0, etf.cashReserve ?? 0); // 保留現金：買進最多只動用到這個水位（賣出回收的錢算進可動用）
  for (const [code, p] of held) { // 先賣
    const px = price(code);
    if (!(px && px > 0)) continue;
    const have = p.shares * px, w = targets[code] ?? 0, want = w * nav;
    if (w > 0 && have - want < band * nav) continue;
    const shares = w > 0 ? Math.min(p.shares, Math.floor((have - want) / px)) : p.shares;
    if (shares <= 0) continue;
    cash += cashFlow({ side: "sell", shares, price: px, code });
    out.push({ code, name: p.name || name(code), side: "sell", shares, price: px, target: w, now: have / nav, reason: w > 0 ? `減碼：目標 ${(w * 100).toFixed(1)}%，目前 ${((have / nav) * 100).toFixed(1)}%` : "不在雙引擎今天的名單，全部賣出" });
  }
  const buys = Object.entries(targets).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]); // 權重大的先買（現金不夠時，小的先放棄）
  for (const [code, w] of buys) {
    const px = price(code);
    if (!(px && px > 0)) continue;
    const have = (held.get(code)?.shares ?? 0) * px, gap = w * nav - have;
    if (gap < band * nav) continue;
    const shares = Math.floor(Math.min(gap, Math.max(0, cash - reserve) / (1 + FEE)) / px);
    if (shares <= 0) continue;
    cash += cashFlow({ side: "buy", shares, price: px, code });
    out.push({ code, name: name(code), side: "buy", shares, price: px, target: w, now: have / nav, reason: have > 0 ? `加碼：目標 ${(w * 100).toFixed(1)}%，目前 ${((have / nav) * 100).toFixed(1)}%` : `新增：目標 ${(w * 100).toFixed(1)}%` });
  }
  return out;
}

/** 資金水位（使用者 11/15）：股票成本、高於成本賺的／低於成本賠的、現金，各佔橫條多少（百分比）。 */
export interface WaterLevel {
  cost: number; marketValue: number; cash: number; invested: number; nav: number;
  unrealized: number; realized: number;
  reserve: number; // 保留現金（元，最多算到現有現金）
  /** 橫條各段寬度（%）：stock 股票（賺錢時＝成本、賠錢時＝市值）、gain 賺、loss 賠的缺口、cash 現金；tick＝成本線位置 */
  bar: { stock: number; gain: number; loss: number; cash: number; tick: number; reserve: number };
}
export function waterLevel(etf: AiEtf, price: (code: string) => number | undefined): WaterLevel {
  const v = valuate(etf, price);
  const ps = positions(etf.trades);
  const cost = ps.reduce((a, p) => a + (p.shares > 0 ? p.shares * p.avgCost : 0), 0);
  const realized = ps.reduce((a, p) => a + p.realized, 0);
  const unrealized = v.marketValue - cost;
  const cash = Math.max(0, v.cash);
  const total = Math.max(cost, v.marketValue) + cash; // 賠錢時橫條總長＝成本＋現金，缺口留在成本線左邊
  const pct = (x: number) => (total > 0 ? (x / total) * 100 : 0);
  const bar = { stock: pct(Math.min(cost, v.marketValue)), gain: pct(Math.max(0, unrealized)), loss: pct(Math.max(0, -unrealized)), cash: pct(cash), tick: pct(cost), reserve: pct(Math.min(Math.max(0, etf.cashReserve ?? 0), cash)) };
  return { cost, marketValue: v.marketValue, cash: v.cash, invested: v.invested, nav: v.nav, unrealized, realized, reserve: Math.max(0, etf.cashReserve ?? 0), bar };
}
