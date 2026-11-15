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
    const shares = Math.floor(Math.min(gap, cash / (1 + FEE)) / px);
    if (shares <= 0) continue;
    cash += cashFlow({ side: "buy", shares, price: px, code });
    out.push({ code, name: name(code), side: "buy", shares, price: px, target: w, now: have / nav, reason: have > 0 ? `加碼：目標 ${(w * 100).toFixed(1)}%，目前 ${((have / nav) * 100).toFixed(1)}%` : `新增：目標 ${(w * 100).toFixed(1)}%` });
  }
  return out;
}
