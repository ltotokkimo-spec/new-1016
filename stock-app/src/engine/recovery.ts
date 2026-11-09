// 持股分析與建議（11/9 使用者：「引導我將負損益做到正損益」）：只用規則計算，不呼叫 Claude、不花錢。
// 對每一檔虧損的持股算出「回本價」與還要漲多少，再依 App 評等給一個動作：
//   停損換股：評等「離場」或虧損已達 10% 停損線 → 賣掉，資金轉到目前評分最高的「買入」標的（ETF 換分數最高的 ETF）
//   攤平：評等「買入」（動能、籌碼仍強）→ 算出加碼多少股能讓回本所需漲幅減半，金額不超過目前持股市值
//   續抱設條件：其他（觀望、只供參考、沒有評等）→ 給回本價與停損價，轉為「買入」再考慮攤平
// 不是投資建議：攤平會增加這檔的部位與風險，停損換股也不保證新標的會漲。

import type { HoldingView, Scored } from "./score";
import { STOP_LOSS } from "./score";

export type RecoveryAction = "停損換股" | "攤平" | "續抱設條件";

export interface RecoveryItem {
  code: string; name: string; market: HoldingView["market"];
  shares: number; cost: number; price: number; pnl: number; pnlPct: number;
  rating: HoldingView["rating"];
  breakEven: number; // 含買賣手續費與證交稅的回本價
  needPct: number; // 從現價要漲多少才回本
  stopPrice: number; // 成本 −10%
  action: RecoveryAction;
  avg?: { addShares: number; addCost: number; newCost: number; newBreakEven: number; newNeedPct: number };
  swap?: { code: string; name: string; score: number; proceeds: number };
  lines: string[];
}

export interface RecoverySummary {
  losers: number; winners: number;
  loss: number; // 虧損持股的損益合計（負數，台股台幣；美股另計）
  cutProceeds: number; // 停損換股可收回的金額
  avgCash: number; // 攤平需要的金額
  lines: string[];
}

const FEE = 0.001425; // 台股手續費（未打折）
const taxOf = (code: string, market: string) => (market === "US" ? 0 : /^00/.test(code) ? 0.001 : 0.003);

/** 含手續費、證交稅的回本價：賣出淨得 ≥ 買進總成本 */
export function breakEvenPrice(cost: number, code: string, market: string): number {
  const fee = market === "US" ? 0.001 : FEE;
  return (cost * (1 + fee)) / (1 - fee - taxOf(code, market));
}

/** 加碼 n 股（現價）讓回本所需漲幅降到 targetNeed；回傳需要的股數（不超過 maxShares） */
export function sharesToAverage(shares: number, cost: number, price: number, k: number, targetNeed: number, maxShares: number): number {
  const cStar = (price * (1 + targetNeed)) / k; // 新均價目標
  if (!(cStar > price) || !(cStar < cost)) return 0;
  const n = Math.ceil((shares * (cost - cStar)) / (cStar - price));
  return Math.max(0, Math.min(n, maxShares));
}

/** 台股加碼股數：滿 1 張就取整張（較省手續費），不滿 1 張用零股 */
const roundTw = (n: number) => (n >= 1000 ? Math.floor(n / 1000) * 1000 : n);

export function recoveryPlan(views: HoldingView[], picks: { stocks: Scored[]; etfs: Scored[]; us: Scored[] }): { items: RecoveryItem[]; summary: RecoverySummary } {
  const held = new Set(views.map((v) => v.code));
  const best = (list: Scored[], buyOnly: boolean) => list.filter((s) => !held.has(s.code) && (!buyOnly || s.rating === "買入")).sort((a, b) => b.score - a.score)[0];
  const items: RecoveryItem[] = [];
  let winners = 0;
  for (const v of views) {
    if (!Number.isFinite(v.price) || !(v.cost > 0) || !(v.shares > 0)) continue;
    if (!(v.pnl < 0)) { if (v.pnl > 0) winners++; continue; }
    const us = v.market === "US", etf = !us && /^00/.test(v.code);
    const be = breakEvenPrice(v.cost, v.code, v.market);
    const k = be / v.cost;
    const needPct = be / v.price - 1;
    const stopPrice = v.cost * (1 + STOP_LOSS);
    const unit = us ? "$" : "";
    const px = (x: number) => `${unit}${x >= 100 ? x.toFixed(1) : x.toFixed(2)}`;
    const money = (x: number) => `${us ? "$" : ""}${Math.round(x).toLocaleString("zh-TW")}${us ? "" : " 元"}`;
    const base = { code: v.code, name: v.name, market: v.market, shares: v.shares, cost: v.cost, price: v.price, pnl: v.pnl, pnlPct: v.pnlPct, rating: v.rating, breakEven: be, needPct, stopPrice };
    const lines = [`回本價 ${px(be)}（含手續費與證交稅），現價還要漲 ${(needPct * 100).toFixed(1)}%`];
    const hitStop = v.pnlPct <= STOP_LOSS;
    if (v.rating === "離場" || hitStop) {
      const s = best(us ? picks.us : etf ? picks.etfs : picks.stocks, !etf);
      const proceeds = v.shares * v.price * (1 - (us ? 0.001 : FEE) - taxOf(v.code, v.market));
      lines.push(hitStop ? `虧損 ${(v.pnlPct * 100).toFixed(1)}% 已達 10% 停損線` : "App 評等「離場」：動能與籌碼都轉弱，等它回本的機會較低");
      lines.push(`建議賣出 ${v.shares.toLocaleString()} 股，約可收回 ${money(proceeds)}`);
      if (s) lines.push(`轉買${etf ? "分數最高的 ETF" : "目前評分最高的「買入」標的"}：${s.name} ${s.code}（分數 ${s.score}）。同樣要賺回 ${(needPct * 100).toFixed(1)}%，放在走強的股票上機會較大`);
      lines.push("如果不想停損：至少不要再加碼，等評等轉回「觀望」或「買入」再說");
      items.push({ ...base, action: "停損換股", swap: s ? { code: s.code, name: s.name, score: s.score, proceeds } : undefined, lines });
    } else if (v.rating === "買入") {
      // 加碼股數不超過目前持股（最多加倍），避免單檔越攤越大
      let n = sharesToAverage(v.shares, v.cost, v.price, k, needPct / 2, v.shares);
      if (!us) n = roundTw(n);
      if (n > 0) {
        const newCost = (v.shares * v.cost + n * v.price) / (v.shares + n), nbe = newCost * k, nn = nbe / v.price - 1;
        lines.push(`App 評等「買入」：動能、籌碼仍強，可以考慮攤平`);
        lines.push(`在 ${px(v.price)} 附近加碼 ${n.toLocaleString()} 股（約 ${money(n * v.price)}）→ 均價 ${px(newCost)}、回本價 ${px(nbe)}，只要漲 ${(nn * 100).toFixed(1)}% 就回本`);
        lines.push(`攤平會加大這檔的部位：跌破 ${px(stopPrice)}（原成本 −10%）一樣要停損`);
        items.push({ ...base, action: "攤平", avg: { addShares: n, addCost: n * v.price, newCost, newBreakEven: nbe, newNeedPct: nn }, lines });
      } else {
        lines.push("App 評等「買入」，虧損很小，續抱等回本即可");
        lines.push(`跌破 ${px(stopPrice)}（成本 −10%）就停損`);
        items.push({ ...base, action: "續抱設條件", lines });
      }
    } else {
      lines.push(v.rating === "觀望" ? "App 評等「觀望」：訊號分歧，先不加碼也不急著賣" : v.rating === "參考" ? `ETF 只供參考（分數 ${v.scored?.score ?? "—"}）：先不加碼` : "沒有評等：先不加碼");
      lines.push(`跌破 ${px(stopPrice)}（成本 −10%）就停損；評等轉為「買入」再考慮攤平`);
      items.push({ ...base, action: "續抱設條件", lines });
    }
  }
  // 停損換股的排最前面（最需要處理），其次攤平，最後續抱；同一類虧損金額大的在前
  const order: Record<RecoveryAction, number> = { 停損換股: 0, 攤平: 1, 續抱設條件: 2 };
  items.sort((a, b) => order[a.action] - order[b.action] || a.pnl - b.pnl);
  const tw = items.filter((x) => x.market !== "US");
  const loss = tw.reduce((a, x) => a + x.pnl, 0);
  const cuts = tw.filter((x) => x.action === "停損換股"), avgs = tw.filter((x) => x.action === "攤平");
  const cutProceeds = cuts.reduce((a, x) => a + (x.swap?.proceeds ?? x.shares * x.price), 0);
  const avgCash = avgs.reduce((a, x) => a + (x.avg?.addCost ?? 0), 0);
  const lines: string[] = [];
  if (!items.length) lines.push(winners ? "目前沒有虧損的持股，照各檔的停利、停損條件續抱即可。" : "還沒有可計算的持股。");
  else {
    lines.push(`${items.length} 檔虧損${tw.length ? `，台股合計 ${Math.round(loss).toLocaleString("zh-TW")} 元` : ""}；${winners} 檔獲利。`);
    if (cuts.length) lines.push(`先處理 ${cuts.length} 檔「停損換股」：${cuts.map((x) => x.name).join("、")}，約可收回 ${Math.round(cutProceeds).toLocaleString("zh-TW")} 元，轉到走強的標的。`);
    if (avgs.length) lines.push(`${avgs.length} 檔評等仍是「買入」可以攤平：${avgs.map((x) => x.name).join("、")}，約需 ${Math.round(avgCash).toLocaleString("zh-TW")} 元；停損換股收回的錢可以優先用在這裡。`);
    const holdN = items.filter((x) => x.action === "續抱設條件").length;
    if (holdN) lines.push(`${holdN} 檔續抱設條件：照回本價與停損價觀察，不加碼。`);
  }
  return { items, summary: { losers: items.length, winners, loss, cutProceeds, avgCash, lines } };
}
