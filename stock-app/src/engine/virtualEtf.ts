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
  // 加碼紀錄：date 起資金由 from 加到 to；加入的錢視為一開始就在、之前閒置的現金（淨值歷史一起加上）
  topUps?: { date: string; from: number; to: number }[];
  cashPlan?: CashPlan; // 資金水位：Claude 每天收盤後依大盤跌幅更新
}

/**
 * 資金水位規劃（使用者 10/21 指定）：平常 7 成股票、3 成現金；
 * 大盤跌深時分段加碼，最多 9 成股票，至少留 1 成現金；反彈回穩再降回 7 成。
 */
export interface CashPlan {
  target: number; // 目前的股票比重目標（0.7 / 0.8 / 0.9）
  drawdown: number; // 加權指數距近 20 日最高收盤（負數，-0.059 = 跌 5.9%）
  date: string; // 判斷日 YYYYMMDD
  reason: string; // 一句話說明
}
export const CASH_BASE = 0.7;
export const CASH_MAX = 0.9;
export const CASH_STEPS = [
  { dd: 0.05, target: 0.8, label: "跌深第 1 段" },
  { dd: 0.10, target: 0.9, label: "跌深第 2 段" },
] as const;

/** 依大盤跌幅決定股票比重目標 */
export function targetFor(drawdown: number): { target: number; label: string } {
  let out = { target: CASH_BASE, label: "正常" };
  for (const s of CASH_STEPS) if (-drawdown >= s.dd - 1e-9) out = { target: s.target, label: s.label };
  return out;
}

/** 目前股票、現金比重，以及離目標還差多少錢（正＝還可以買、負＝超出目標） */
export function cashLevel(plan: CashPlan | undefined, nav: number, marketValue: number) {
  const target = plan?.target ?? CASH_BASE;
  const stock = nav > 0 ? marketValue / nav : 0;
  return { stock, cash: 1 - stock, target, room: target * nav - marketValue, label: plan ? targetFor(plan.drawdown).label : "正常" };
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
  // 只成交 date 之前下的委託（當天盤中才下的單留到下一個交易日）
  const due = v.pending.filter((o) => o.placed < date);
  const order = [...due].sort((a, b) => (a.side === b.side ? 0 : a.side === "sell" ? -1 : 1));
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
  return { ...v, trades, cancelled: cancelled.slice(-100), stops, pending: v.pending.filter((o) => o.placed >= date) };
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

/**
 * 加碼：資金從目前的 budget 加到 to。加入的錢當作從頭就在、之前沒動用的現金，
 * 所以淨值歷史（含 0050 對照）都加上同一筆金額，現金與報酬率的計算方式不變。
 */
export function topUp(v: VirtualEtf, date: string, to: number): VirtualEtf {
  const add = to - v.budget;
  if (!(add > 0)) throw new Error(`加碼後的資金要大於目前的 ${v.budget}`);
  return {
    ...v, budget: to,
    nav: v.nav.map((p) => ({ ...p, nav: p.nav + add, bench: p.bench + add })),
    topUps: [...(v.topUps ?? []), { date, from: v.budget, to }],
  };
}

/** 加碼前那一段用原本資金算的報酬（加碼後報酬率會被稀釋，另外列出來才公平） */
export function beforeTopUp(v: VirtualEtf): { from: number; to: number; date: string; days: number; ret: number; benchRet: number } | undefined {
  const t = v.topUps?.[0];
  if (!t) return undefined;
  const pts = v.nav.filter((p) => p.date < t.date);
  const last = pts.at(-1);
  if (!last) return undefined;
  const add = t.to - t.from;
  const cut = (v.topUps ?? []).filter((x) => x !== t).reduce((s, x) => s + x.to - x.from, 0); // 之後的加碼也加在歷史上
  return { ...t, days: pts.length, ret: (last.nav - add - cut) / t.from - 1, benchRet: (last.bench - add - cut) / t.from - 1 };
}

/** 記錄當天的資金水位判斷（目標由跌幅決定，不能超過 9 成） */
export function setCashPlan(v: VirtualEtf, date: string, drawdown: number, reason: string): VirtualEtf {
  if (!Number.isFinite(drawdown) || drawdown > 0 || drawdown < -0.6) throw new Error(`大盤跌幅要是 0 到 -0.6 之間的小數：${drawdown}`);
  return { ...v, cashPlan: { target: Math.min(CASH_MAX, targetFor(drawdown).target), drawdown, date, reason } };
}

export function addNote(v: VirtualEtf, date: string, text: string): VirtualEtf {
  return { ...v, notes: [...v.notes.filter((n) => n.date !== date), { date, text }].slice(-120) };
}
