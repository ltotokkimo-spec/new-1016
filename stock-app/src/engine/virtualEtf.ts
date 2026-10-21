// Claude 虛擬操作的自組 ETF：每個交易日收盤後由 Claude 排程任務更新（tools/virtual-etf.ts），
// 結果發布到 GitHub Release，App 只負責顯示。這裡是純計算，App、排程與單元測試共用。
// 注意：這個檔案也會被 Node 直接執行（--experimental-strip-types），所以 import 要寫副檔名。
import { cashFlow, positions, recordNav, valuate, type AiEtf, type EtfTrade } from "./aiEtf.ts";

export interface Quote { name?: string; open: number; high: number; low: number; close: number }
export interface PendingOrder { code: string; name: string; side: "buy" | "sell"; shares: number; limit?: number; stop?: number; reason: string; placed: string }
export interface DayNote { date: string; text: string }

export interface VirtualEtf extends AiEtf {
  version: 1;
  start: string; // 開始日 YYYYMMDD
  asOf: string; // 最近一次收盤更新的日期
  updatedAt: number;
  pending: PendingOrder[]; // 下一個交易日要執行的委託
  notes: DayNote[]; // Claude 每天的操作說明
  last: Record<string, { name: string; close: number }>; // 最近收盤價（持股與 0050）
  cancelled?: { date: string; code: string; name: string; reason: string }[]; // 沒成交的委託
}

export const newVirtual = (start: string, budget = 100_000): VirtualEtf => ({
  version: 1, budget, start, asOf: "", updatedAt: Date.now(), trades: [], nav: [], stops: {}, pending: [], notes: [], last: {}, cancelled: [],
});

const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * 用當天的開高低成交前一天收盤後下的委託：
 * 買進：開盤 ≤ 限價 → 以開盤價成交；盤中最低 ≤ 限價 → 以限價成交；否則沒成交（取消）。
 * 賣出：一律以開盤價成交（停損、出場不等價）。
 */
export function fillPending(v: VirtualEtf, date: string, q: Record<string, Quote>): VirtualEtf {
  const trades: EtfTrade[] = [...v.trades];
  const cancelled = [...(v.cancelled ?? [])];
  const stops = { ...v.stops };
  const bench = q["0050"]?.open ?? NaN;
  let cash = valuate(v, () => undefined).cash;
  // 先賣後買，賣出的錢可以拿來買
  const order = [...v.pending].sort((a, b) => (a.side === b.side ? 0 : a.side === "sell" ? -1 : 1));
  const held = new Map(positions(v.trades).map((p) => [p.code, p.shares]));
  for (const o of order) {
    const k = q[o.code];
    if (!k || !(k.open > 0)) { cancelled.push({ date, code: o.code, name: o.name, reason: "當天沒有成交資料（可能停牌）" }); continue; }
    let price: number | undefined;
    if (o.side === "sell") price = k.open;
    else if (!o.limit || k.open <= o.limit) price = k.open;
    else if (k.low <= o.limit) price = o.limit;
    if (price === undefined) { cancelled.push({ date, code: o.code, name: o.name, reason: `沒買到：最低 ${k.low} 高於限價 ${o.limit}` }); continue; }
    let shares = o.shares;
    if (o.side === "sell") shares = Math.min(shares, held.get(o.code) ?? 0);
    else {
      const need = -cashFlow({ side: "buy", shares, price });
      if (need > cash) shares = Math.floor(cash / (price * 1.001425));
    }
    if (shares <= 0) { cancelled.push({ date, code: o.code, name: o.name, reason: o.side === "sell" ? "沒有持股可賣" : "現金不足" }); continue; }
    const t: EtfTrade = { id: `${date}-${o.code}-${o.side}`, date, code: o.code, name: k.name || o.name, side: o.side, shares, price: r2(price), benchPrice: bench };
    trades.push(t);
    cash += cashFlow(t);
    held.set(o.code, (held.get(o.code) ?? 0) + (o.side === "buy" ? shares : -shares));
    if (o.side === "buy" && o.stop) stops[o.code] = o.stop;
  }
  return { ...v, trades, cancelled: cancelled.slice(-100), stops, pending: [] };
}

/** 收盤後：更新收盤價、記錄淨值；收盤跌破停損價的持股，自動排入隔天開盤賣出 */
export function closeDay(v: VirtualEtf, date: string, q: Record<string, Quote>): VirtualEtf {
  const last = { ...v.last };
  for (const [code, k] of Object.entries(q)) if (k.close > 0) last[code] = { name: k.name || last[code]?.name || code, close: k.close };
  let out: VirtualEtf = { ...v, last, asOf: date, updatedAt: Date.now() };
  const val = valuate(out, (c) => last[c]?.close);
  if (!val.missing.length) out = { ...out, ...recordNav(out, date, val) };
  const pending = [...out.pending];
  for (const p of positions(out.trades)) {
    if (p.shares <= 0) continue;
    const stop = out.stops?.[p.code];
    const px = last[p.code]?.close;
    if (stop && px !== undefined && px <= stop && !pending.some((o) => o.code === p.code && o.side === "sell"))
      pending.push({ code: p.code, name: p.name, side: "sell", shares: p.shares, reason: `收盤 ${px} 跌破停損價 ${stop}，隔天開盤賣出`, placed: date });
  }
  return { ...out, pending };
}

/** 加入隔天的委託（同一檔同方向的舊委託會被取代） */
export function placeOrders(v: VirtualEtf, date: string, orders: Omit<PendingOrder, "placed">[]): VirtualEtf {
  const pending = v.pending.filter((p) => !orders.some((o) => o.code === p.code && o.side === p.side));
  for (const o of orders) if (o.shares > 0) pending.push({ ...o, placed: date });
  return { ...v, pending };
}

export function addNote(v: VirtualEtf, date: string, text: string): VirtualEtf {
  return { ...v, notes: [...v.notes.filter((n) => n.date !== date), { date, text }].slice(-120) };
}
