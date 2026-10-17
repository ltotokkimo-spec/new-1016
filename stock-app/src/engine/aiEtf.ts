// 自組 ETF：照 Claude 建議實際買進，記錄成交，計算淨值並和「同樣的錢買 0050」比較。
// 純計算，方便單元測試；資料存在手機（store.ts 的 aiEtf）。

export interface EtfTrade {
  id: string;
  date: string; // YYYYMMDD
  code: string;
  name: string;
  side: "buy" | "sell";
  shares: number;
  price: number; // 實際成交價
  benchPrice: number; // 當天 0050 價格（用來模擬「同樣的錢買 0050」）
}
export interface NavPoint { date: string; nav: number; bench: number }
export interface AiEtf {
  budget: number; // 起始資金
  trades: EtfTrade[];
  nav: NavPoint[]; // 每天記一筆
  planKey?: string; // 最近一次 Claude 建議的報告 key
  appliedKey?: string; // 已經填入成交的建議（不再顯示填單表）
}

export const FEE = 0.001425; // 券商手續費（未打折）
export const TAX = 0.003; // 證交稅（賣出）
export const BENCH = "0050";

export const emptyEtf = (budget = 100_000): AiEtf => ({ budget, trades: [], nav: [] });

/** 一筆交易的現金流（買入為負、賣出為正，已扣手續費與稅） */
export function cashFlow(t: Pick<EtfTrade, "side" | "shares" | "price">): number {
  const amt = t.shares * t.price;
  return t.side === "buy" ? -(amt + amt * FEE) : amt - amt * FEE - amt * TAX;
}

export interface Position { code: string; name: string; shares: number; avgCost: number; realized: number }

/** 依成交紀錄算出目前持股（賣出用平均成本計算已實現損益） */
export function positions(trades: EtfTrade[]): Position[] {
  const m = new Map<string, Position>();
  for (const t of [...trades].sort((a, b) => a.date.localeCompare(b.date))) {
    const p = m.get(t.code) ?? { code: t.code, name: t.name, shares: 0, avgCost: 0, realized: 0 };
    if (t.side === "buy") {
      const cost = p.avgCost * p.shares + t.shares * t.price * (1 + FEE);
      p.shares += t.shares;
      p.avgCost = p.shares ? cost / p.shares : 0;
    } else {
      const n = Math.min(t.shares, p.shares);
      p.realized += cashFlow({ side: "sell", shares: n, price: t.price }) - n * p.avgCost;
      p.shares -= n;
    }
    p.name = t.name || p.name;
    m.set(t.code, p);
  }
  return [...m.values()];
}

export interface Valuation {
  cash: number;
  marketValue: number;
  nav: number; // 現金＋股票市值
  ret: number; // 淨值報酬率（對起始資金）
  bench: number; // 同樣的錢買 0050 的淨值
  benchRet: number;
  missing: string[]; // 沒有現價的代號
}

/** 用目前價格算淨值；0050 對照組：每次買賣都用同樣金額買賣 0050 */
export function valuate(etf: AiEtf, price: (code: string) => number | undefined): Valuation {
  let cash = etf.budget, bCash = etf.budget, bUnits = 0, lastBench = NaN;
  for (const t of etf.trades) {
    const cf = cashFlow(t);
    cash += cf;
    if (t.benchPrice > 0) {
      lastBench = t.benchPrice;
      const units = (t.shares * t.price) / t.benchPrice;
      if (t.side === "buy") { bUnits += units; bCash += cf; }
      else { const u = Math.min(units, bUnits); bUnits -= u; bCash += cashFlow({ side: "sell", shares: u, price: t.benchPrice }); }
    }
  }
  const missing: string[] = [];
  let marketValue = 0;
  for (const p of positions(etf.trades)) {
    if (p.shares <= 0) continue;
    const px = price(p.code);
    if (px === undefined || !Number.isFinite(px)) { missing.push(p.code); marketValue += p.shares * p.avgCost; continue; }
    marketValue += p.shares * px;
  }
  // 0050 還沒有最新價時，先用最後一次成交時的 0050 價格，免得對照組看起來像賠光
  const live = price(BENCH);
  const bp = live !== undefined && Number.isFinite(live) ? live : lastBench;
  if (bUnits > 0 && bp !== live) missing.push(BENCH);
  const bench = bCash + bUnits * (Number.isFinite(bp) ? bp : 0);
  const nav = cash + marketValue;
  return { cash, marketValue, nav, ret: nav / etf.budget - 1, bench, benchRet: bench / etf.budget - 1, missing };
}

/** 記錄今天的淨值（同一天只留最後一筆） */
export function recordNav(etf: AiEtf, date: string, v: Valuation): AiEtf {
  if (!etf.trades.length) return etf;
  const nav = etf.nav.filter((x) => x.date !== date);
  nav.push({ date, nav: Math.round(v.nav), bench: Math.round(v.bench) });
  nav.sort((a, b) => a.date.localeCompare(b.date));
  return { ...etf, nav: nav.slice(-400) };
}

// ---------- Claude 建議的格式 ----------
export interface PlanItem { code: string; side: "buy" | "sell"; shares: number; reason: string }

/** 從 Claude 回覆最後的 ```json 區塊取出買賣清單；回傳清單與去掉 JSON 後的說明文字 */
export function parsePlan(text: string): { items: PlanItem[]; body: string } {
  const re = /```json\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null, last: RegExpExecArray | null = null;
  while ((m = re.exec(text))) last = m;
  if (!last) return { items: [], body: text };
  let items: PlanItem[] = [];
  try {
    const j = JSON.parse(last[1]);
    const arr = Array.isArray(j) ? j : j.trades ?? j.picks ?? [];
    items = arr
      .map((x: any) => ({
        code: String(x.code ?? "").trim().toUpperCase(),
        side: x.side === "sell" ? "sell" : "buy",
        shares: Math.max(0, Math.round(Number(x.shares))),
        reason: String(x.reason ?? ""),
      }))
      .filter((x: PlanItem) => x.code && x.shares > 0);
  } catch { /* JSON 壞掉就只顯示文字 */ }
  return { items, body: (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim() };
}

/** 依預算檢查：買進總額（含手續費）超過可用現金時，等比例縮小股數 */
export function fitBudget(items: PlanItem[], price: (code: string) => number | undefined, cash: number): PlanItem[] {
  const sells = items.filter((x) => x.side === "sell").reduce((a, x) => a + cashFlow({ side: "sell", shares: x.shares, price: price(x.code) ?? 0 }), 0);
  const buys = items.filter((x) => x.side === "buy");
  const need = buys.reduce((a, x) => a + -cashFlow({ side: "buy", shares: x.shares, price: price(x.code) ?? 0 }), 0);
  const avail = cash + sells;
  if (need <= avail || need <= 0) return items;
  const k = avail / need;
  return items.map((x) => (x.side === "buy" ? { ...x, shares: Math.floor(x.shares * k) } : x)).filter((x) => x.shares > 0);
}
