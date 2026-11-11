// 工具分頁（11/11 使用者）：攤平計算、股息計算。只用手機上的資料計算，不呼叫 Claude、不花錢。
import { breakEvenPrice } from "./recovery";

const FEE = 0.001425;
const isUs = (market: string) => market === "US";
/** 買進手續費（台股最低 20 元、零股 1 元；美股複委託 0.1%） */
export function buyFee(amount: number, shares: number, market: string, discount = 1): number {
  if (!(amount > 0)) return 0;
  if (isUs(market)) return amount * 0.001;
  const f = amount * FEE * discount;
  return Math.max(f, shares % 1000 === 0 ? 20 : 1);
}

export interface AvgInput { code: string; market: string; shares: number; cost: number; price: number; addShares: number; addPrice: number; discount?: number }
export interface AvgSide { shares: number; avg: number; invested: number; breakEven: number; needPct: number; pnl: number }
export interface AvgResult { before: AvgSide; after: AvgSide; addCost: number; addFee: number; cash: number; ifDrop10: { before: number; after: number; price: number }; stop: number }

/** 回本價倍數（含買賣手續費、證交稅）；折扣只影響手續費 */
function beFactor(code: string, market: string, discount = 1): number {
  if (discount === 1) return breakEvenPrice(1, code, market);
  const fee = isUs(market) ? 0.001 : FEE * discount, tax = isUs(market) ? 0 : /^00/.test(code) ? 0.001 : 0.003;
  return (1 + fee) / (1 - fee - tax);
}

export function averageDown(p: AvgInput): AvgResult {
  const k = beFactor(p.code, p.market, p.discount);
  const side = (shares: number, avg: number): AvgSide => ({
    shares, avg, invested: shares * avg, breakEven: avg * k, needPct: p.price > 0 ? (avg * k) / p.price - 1 : NaN, pnl: (p.price - avg) * shares,
  });
  const before = side(p.shares, p.cost);
  const addCost = Math.max(0, p.addShares) * p.addPrice;
  const n = p.shares + Math.max(0, p.addShares);
  const after = side(n, n > 0 ? (p.shares * p.cost + addCost) / n : 0);
  const addFee = buyFee(addCost, p.addShares, p.market, p.discount);
  const drop = p.price * 0.9;
  return {
    before, after, addCost, addFee, cash: addCost + addFee,
    ifDrop10: { price: drop, before: (drop - p.cost) * p.shares, after: (drop - after.avg) * n },
    stop: after.avg * 0.9,
  };
}

/** 想把均價壓到 target，要在 addPrice 買幾股（做不到回 undefined） */
export function sharesForTarget(shares: number, cost: number, addPrice: number, target: number): number | undefined {
  if (!(target < cost) || !(target > addPrice)) return undefined;
  return Math.ceil((shares * (cost - target)) / (target - addPrice));
}

/** 加碼金額換成股數（台股滿 1 張就取整張，不滿用零股） */
export function sharesForAmount(amount: number, price: number, market: string): number {
  if (!(amount > 0) || !(price > 0)) return 0;
  const n = Math.floor(amount / price);
  return !isUs(market) && n >= 1000 ? Math.floor(n / 1000) * 1000 : n;
}

/** 分批攤平：現價、跌 5%、跌 10% 各買約三分之一 */
export function batchPlan(p: AvgInput): { price: number; shares: number }[] {
  const total = Math.max(0, p.addShares);
  const a = Math.floor(total / 3), b = Math.floor(total / 3), c = total - a - b;
  return [{ price: p.addPrice, shares: a }, { price: p.addPrice * 0.95, shares: b }, { price: p.addPrice * 0.9, shares: c }];
}

// ---------------- 股息 ----------------
export const NHI = { rate: 0.0211, threshold: 20000 }; // 二代健保補充保費：單次股利 ≥ 2 萬扣 2.11%
export const TRANSFER_FEE = 10; // 股利匯費（多數券商 10 元）

export interface DivInput { code: string; market: string; shares: number; cost: number; price: number; perPay: number; perYear: number; years: number; drip: boolean; priceGrowth: number; addPerYear: number }
export interface DivPay { gross: number; nhi: number; fee: number; net: number }
export interface DivRow { year: number; shares: number; yearGross: number; cumNet: number; value: number }

/** 一次配息實際入帳（台股：二代健保、匯費；美股：預扣 30% 稅） */
export function payout(shares: number, perPay: number, market: string): DivPay {
  const gross = shares * perPay;
  if (!(gross > 0)) return { gross: 0, nhi: 0, fee: 0, net: 0 };
  if (isUs(market)) { const tax = gross * 0.3; return { gross, nhi: tax, fee: 0, net: gross - tax }; }
  const nhi = gross >= NHI.threshold ? Math.round(gross * NHI.rate) : 0;
  const fee = Math.min(TRANSFER_FEE, gross);
  return { gross, nhi, fee, net: gross - nhi - fee };
}

/** 逐次配息模擬：股價每年漲跌 priceGrowth；drip＝配到的錢（實領）在除息時買回零股；每年年初另外加碼 addPerYear 元 */
export function dividendPlan(p: DivInput): { rows: DivRow[]; first: DivPay } {
  let shares = p.shares, cumNet = 0;
  const rows: DivRow[] = [];
  const n = Math.max(1, Math.round(p.perYear));
  const g = Math.pow(1 + p.priceGrowth, 1 / n);
  let price = p.price;
  for (let y = 1; y <= p.years; y++) {
    if (p.addPerYear > 0 && price > 0) { const add = Math.floor(p.addPerYear / price); shares += add; }
    let yearGross = 0;
    for (let k = 0; k < n; k++) {
      const pay = payout(shares, p.perPay, p.market);
      yearGross += pay.gross; cumNet += pay.net;
      price *= g;
      if (p.drip && price > 0) shares += Math.floor(pay.net / (price * (1 + FEE)));
    }
    rows.push({ year: y, shares, yearGross, cumNet, value: shares * price });
  }
  return { rows, first: payout(p.shares, p.perPay, p.market) };
}

/** 想要每月領 monthly 元（實領），要持有幾股 */
export function sharesForMonthly(monthly: number, perPay: number, perYear: number, market: string): number {
  if (!(monthly > 0) || !(perPay > 0) || !(perYear > 0)) return 0;
  const perPayNeed = (monthly * 12) / perYear; // 每次要實領多少
  // 先不考慮二代健保估一次，超過門檻再把扣掉的補回來
  let sh = Math.ceil((perPayNeed + (isUs(market) ? 0 : TRANSFER_FEE)) / (perPay * (isUs(market) ? 0.7 : 1)));
  if (!isUs(market) && sh * perPay >= NHI.threshold) sh = Math.ceil((perPayNeed + TRANSFER_FEE) / (perPay * (1 - NHI.rate)));
  return sh;
}
