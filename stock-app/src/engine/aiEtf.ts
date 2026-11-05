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
  hidden?: boolean; // 只從成交紀錄列表隱藏；持股、現金、損益仍照這筆計算
  offList?: boolean; // 買進當下不在 App 選股「買入」清單裡（只警告，不阻擋）
}
export interface NavPoint { date: string; nav: number; bench: number }
/** 配息入帳（選用：沒有這個欄位的組合，算出來的數字和以前完全一樣）。date 是除息日；amount = 除息日前一天收盤持有的股數 × 每股配息 */
export interface EtfDividend { id: string; date: string; code: string; name: string; perShare: number; shares: number; amount: number }
/** 中途存入（amount > 0）或提領（amount < 0）的資金；date 和淨值紀錄用同一個資料日，報酬率用時間加權，存提款不影響報酬率 */
export interface EtfFlow {
  id: string; date: string; amount: number;
  navBefore?: number; benchBefore?: number; // 存提款前一刻的淨值（自組 ETF、0050 對照）：把當天切成前後兩段，前一段的賺賠不會被存入的錢稀釋
}
export interface AiEtf {
  budget: number; // 起始資金
  flows?: EtfFlow[]; // 中途存入／提領資金（選用：沒有就和以前完全一樣）
  trades: EtfTrade[];
  dividends?: EtfDividend[]; // 持股的配息（現金入帳）
  benchDividends?: { date: string; perShare: number }[]; // 0050 的配息（對照組用同樣方式入帳，才公平）
  nav: NavPoint[]; // 每天記一筆
  planKey?: string; // 最近一次 Claude 建議的報告 key
  appliedKey?: string; // 已經填入成交的建議（不再顯示填單表）
  stops?: Record<string, number>; // 每檔的停損價（Claude 建議或自己設定）
  proKey?: string; // 最近一次貼回的 Claude App（Pro）回覆
  fillFrom?: "api" | "pro"; // 要照哪一份建議填成交
  planAsOf?: string; // 付費版建議用的收盤資料日（YYYYMMDD）
  proAsOf?: string; // Pro 版建議用的收盤資料日
}

export const FEE = 0.001425; // 券商手續費（未打折）
export const TAX = 0.003; // 證交稅（賣出，一般股票）
export const TAX_ETF = 0.001; // 證交稅（賣出，ETF）
const isEtfCode = (code?: string) => !!code && /^00\d{2,4}[A-Z]?$/.test(code.trim());
export const BENCH = "0050";

export const emptyEtf = (budget = 100_000): AiEtf => ({ budget, trades: [], nav: [] });

/** 一筆交易的現金流（買入為負、賣出為正，已扣手續費與稅） */
export function cashFlow(t: Pick<EtfTrade, "side" | "shares" | "price"> & { code?: string }): number {
  const amt = t.shares * t.price;
  return t.side === "buy" ? -(amt + amt * FEE) : amt - amt * FEE - amt * (isEtfCode(t.code) ? TAX_ETF : TAX);
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
      p.realized += cashFlow({ side: "sell", shares: n, price: t.price, code: t.code }) - n * p.avgCost;
      p.shares -= n;
    }
    p.name = t.name || p.name;
    m.set(t.code, p);
  }
  return [...m.values()];
}

/**
 * 成交紀錄每一列的損益：
 * 賣出＝這筆賣出已實現的賺賠（賣出金額扣手續費與證交稅，減去當時的平均成本）；
 * 買進＝這檔還有持股時，用現價算的帳面損益（扣買進手續費）；已經賣光或沒有現價就不給。
 */
export function tradePnls(trades: EtfTrade[], price: (code: string) => number | undefined): Record<string, number | undefined> {
  const held = new Map<string, { shares: number; avgCost: number }>();
  const out: Record<string, number | undefined> = {};
  for (const t of [...trades].sort((a, b) => a.date.localeCompare(b.date))) {
    const p = held.get(t.code) ?? { shares: 0, avgCost: 0 };
    if (t.side === "buy") {
      const cost = p.avgCost * p.shares + t.shares * t.price * (1 + FEE);
      p.shares += t.shares;
      p.avgCost = p.shares ? cost / p.shares : 0;
    } else {
      const n = Math.min(t.shares, p.shares);
      out[t.id] = cashFlow({ side: "sell", shares: n, price: t.price, code: t.code }) - n * p.avgCost;
      p.shares -= n;
    }
    held.set(t.code, p);
  }
  for (const t of trades) {
    if (t.side !== "buy") continue;
    const px = price(t.code);
    out[t.id] = (held.get(t.code)?.shares ?? 0) > 0 && px !== undefined && Number.isFinite(px) ? (px - t.price * (1 + FEE)) * t.shares : undefined;
  }
  return out;
}

export interface Valuation {
  cash: number;
  marketValue: number;
  nav: number; // 現金＋股票市值
  ret: number; // 淨值報酬率（對起始資金）
  bench: number; // 同樣的錢買 0050 的淨值
  benchRet: number;
  missing: string[]; // 沒有現價的代號
  invested: number; // 實際投入的本金＝起始資金＋存入－提領
}

/** 時間加權報酬用的存提款（自組 ETF 用 navBefore、0050 對照用 benchBefore） */
export const flowsFor = (flows: EtfFlow[] = [], which: "nav" | "bench") =>
  flows.map((f) => ({ date: f.date, amount: f.amount, before: which === "nav" ? f.navBefore : f.benchBefore }));

/**
 * 時間加權報酬：把每次存提款前後切成一段一段，各段的漲跌連乘。存入、提領的錢不算賺賠，報酬率只反映操作好壞。
 * 存提款算在「該日（含）之後第一筆淨值紀錄」那天：那天的報酬＝當天淨值 ÷（前一筆淨值＋存提款）。
 * 沒有存提款時，連乘會剛好等於 淨值 ÷ 起始資金，和以前的算法完全一樣。
 */
export function twrSeries(points: { date: string; v: number }[], budget: number, flows: { date: string; amount: number; before?: number }[] = []): { date: string; cum: number; day: number }[] {
  const fl = [...flows].sort((a, b) => a.date.localeCompare(b.date));
  let k = 0, prev = budget, growth = 1;
  return points.map((p) => {
    // 有記下存提款前一刻的淨值：前一段＝前一刻淨值 ÷ 上一筆，後一段＝今天淨值 ÷（前一刻淨值＋存提款）
    let base = prev, factor = 1;
    while (k < fl.length && fl[k].date <= p.date) {
      const f = fl[k++];
      if (f.before !== undefined && f.before > 0 && base > 0) { factor *= f.before / base; base = f.before + f.amount; }
      else base += f.amount;
    }
    const day = base > 0 ? (factor * p.v) / base - 1 : 0;
    growth *= 1 + day;
    prev = p.v;
    return { date: p.date, cum: growth - 1, day };
  });
}

/** 除息日前一天收盤時持有的股數（除息日當天才買的不算，除息日開盤賣掉的仍算） */
export function sharesBefore(trades: EtfTrade[], code: string, date: string): number {
  let n = 0;
  for (const t of trades) if (t.code === code && t.date < date) n += t.side === "buy" ? t.shares : -t.shares;
  return Math.max(0, n);
}

/** 除息日前一天收盤時，0050 對照組持有的單位數（和 valuate 的對照組算法一致） */
function benchUnitsBefore(trades: EtfTrade[], date: string): number {
  let u = 0;
  for (const t of [...trades].sort((a, b) => a.date.localeCompare(b.date))) {
    if (t.date >= date || !(t.benchPrice > 0)) continue;
    const units = (t.shares * t.price) / t.benchPrice;
    u = t.side === "buy" ? u + units : u - Math.min(units, u);
  }
  return u;
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
      else { const u = Math.min(units, bUnits); bUnits -= u; bCash += cashFlow({ side: "sell", shares: u, price: t.benchPrice, code: BENCH }); }
    }
  }
  // 配息（沒有這兩個欄位就完全不影響）
  for (const d of etf.dividends ?? []) cash += d.amount;
  // 中途存入／提領：自組 ETF 和 0050 對照組同一天加減同樣的現金
  const flowSum = (etf.flows ?? []).reduce((a, f) => a + f.amount, 0);
  cash += flowSum; bCash += flowSum;
  for (const d of etf.benchDividends ?? []) bCash += benchUnitsBefore(etf.trades, d.date) * d.perShare;
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
  const invested = etf.budget + flowSum;
  if (!etf.flows?.length) return { cash, marketValue, nav, ret: nav / etf.budget - 1, bench, benchRet: bench / etf.budget - 1, missing, invested };
  // 有存提款：用時間加權報酬（過去每天的淨值紀錄，加上現在這一刻）
  const now = "99999999";
  const ret = twrSeries([...etf.nav.map((p) => ({ date: p.date, v: p.nav })), { date: now, v: nav }], etf.budget, flowsFor(etf.flows, "nav")).at(-1)!.cum;
  const benchRet = twrSeries([...etf.nav.map((p) => ({ date: p.date, v: p.bench })), { date: now, v: bench }], etf.budget, flowsFor(etf.flows, "bench")).at(-1)!.cum;
  return { cash, marketValue, nav, ret, bench, benchRet, missing, invested };
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
export interface PlanItem { code: string; side: "buy" | "sell"; shares: number; reason: string; stop?: number; rank?: number; cond?: string[] } // cond＝Claude 寫的「如果…就…」 // rank＝買進優先順位（1＝最先買）

/** 從 index 開始的 { 或 [ 往後找到對應的結尾（字串裡的括號不算），找不到回傳 -1 */
function matchEnd(text: string, start: number): number {
  let depth = 0, inStr = false;
  for (let k = start; k < text.length; k++) {
    const c = text[k];
    if (inStr) { if (c === "\\") k++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { if (--depth === 0) return k + 1; }
  }
  return -1;
}

/**
 * 找出回覆裡的買賣清單 JSON：優先用最後一個 ```json 區塊；
 * 從 Claude App 複製回覆常會掉掉 ``` 框，所以也認「沒有框的 JSON」（以 {"trades"、{"stops"、{"picks" 或 [{"code" 開頭，最後一段能解析的）。
 */
function findPlanJson(text: string): { json: string; start: number; end: number } | null {
  const re = /```json\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null, last: RegExpExecArray | null = null;
  while ((m = re.exec(text))) last = m;
  if (last) return { json: last[1], start: last.index, end: last.index + last[0].length };
  const starts = [...text.matchAll(/[{[]\s*(?:"(?:trades|picks|stops)"\s*:|\{\s*"code"\s*:)/g)].map((x) => x.index!);
  // 能解析的候選裡，取結尾最後面的；結尾相同取最外層（最前面開始），免得只抓到裡面那層陣列
  let best: { json: string; start: number; end: number } | null = null;
  for (const st of starts) {
    const end = matchEnd(text, st);
    if (end < 0 || (best && end <= best.end)) continue;
    try { JSON.parse(text.slice(st, end)); best = { json: text.slice(st, end), start: st, end }; } catch { /* 下一個 */ }
  }
  return best;
}

/** 從 Claude 回覆取出買賣清單；回傳清單與去掉 JSON 後的說明文字 */
export interface HoldNote { why?: string; cond: string[] }
const condList = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? [v] : []).map((x) => String(x).trim().replace(/^(如果|假如|若)\s*/, "")).filter(Boolean).slice(0, 3);

export function parsePlan(text: string): { items: PlanItem[]; body: string; stops: Record<string, number>; holds: Record<string, HoldNote> } {
  const last = findPlanJson(text);
  const holds: Record<string, HoldNote> = {};
  if (!last) return { items: [], body: text, stops: {}, holds };
  let items: PlanItem[] = [];
  const stops: Record<string, number> = {};
  try {
    const j = JSON.parse(last.json);
    const arr = Array.isArray(j) ? j : j.trades ?? j.picks ?? [];
    items = arr
      .filter((x: any) => /^(buy|sell|買|賣|買進|賣出)$/i.test(String(x?.side ?? "buy").trim())) // 「hold／不動」等不是委託，不能被當成買進
      .map((x: any) => ({
        code: String(x.code ?? "").trim().toUpperCase(),
        side: /^(sell|賣|賣出)$/i.test(String(x.side ?? "").trim()) ? "sell" : "buy",
        shares: Math.max(0, Math.round(Number(x.shares))),
        reason: String(x.reason ?? ""),
        stop: Number(x.stop) > 0 ? Number(x.stop) : undefined,
        rank: Number(x.rank ?? x.priority ?? x.順位) > 0 ? Math.round(Number(x.rank ?? x.priority ?? x.順位)) : undefined,
        cond: condList(x.cond ?? x.if ?? x.條件),
      }))
      .filter((x: PlanItem) => x.code && x.shares > 0);
    // 買進優先順位：有給 rank 就照 rank 排，沒給的照 JSON 裡的先後（Claude 被要求依優先順序列）；賣出排在前面
    const buys = items.filter((x) => x.side === "buy").map((x, i) => ({ x, i }));
    buys.sort((a, b) => (a.x.rank ?? 1e3 + a.i) - (b.x.rank ?? 1e3 + b.i));
    buys.forEach(({ x }, k) => { x.rank = k + 1; });
    items = [...items.filter((x) => x.side === "sell"), ...buys.map((b) => b.x)];
    // 停損價：每筆買進的 stop，加上檢視時對「不動」持股另外給的 stops
    if (j && typeof j.stops === "object" && !Array.isArray(j.stops))
      for (const [k, v] of Object.entries(j.stops)) if (Number(v) > 0) stops[k.trim().toUpperCase()] = Number(v);
    for (const it of items) if (it.stop) stops[it.code] = it.stop;
    // 不動的持股：Claude 寫的續抱理由與條件 {"holds":{"2412":{"why":"…","cond":["如果…就…"]}}}
    if (j && typeof j.holds === "object" && !Array.isArray(j.holds))
      for (const [k, v] of Object.entries(j.holds as Record<string, any>)) {
        const why = typeof v === "string" ? v : String(v?.why ?? v?.reason ?? "").trim() || undefined;
        holds[k.trim().toUpperCase()] = { why, cond: typeof v === "object" ? condList(v?.cond ?? v?.if) : [] };
      }
  } catch { /* JSON 壞掉就只顯示文字 */ }
  return { items, body: (text.slice(0, last.start) + text.slice(last.end)).trim(), stops, holds };
}

/** 給 Claude 的候選股：只取 App「買入」且成交金額在前一半的高分股，每個產業最多 perSector 檔、全部最多 max 檔，已持有的不重複列（持股那邊已有最新價格）。不夠 minCount 檔時用高分的「觀望」補 */
/** 買進的股票是否不在 App 選股的「買入」清單裡（ETF 只當參考、不評等，不算）；查不到資料也算不在 */
export function isOffList(s: { rating: string; refOnly?: boolean } | undefined): boolean {
  return s ? !s.refOnly && s.rating !== "買入" : true;
}

/** 候選股的成交金額門檻＝全部評分股票當日成交金額的中位數（只留成交金額在前一半的大型股；2 年回測：成交金額大的股票之後 20 日平均多賺約 2.5%、最穩定的因子） */
export const CANDIDATE_LIQUIDITY_PCT = 0.5;
export function liquidityCut(scored: { value?: number }[], pct = CANDIDATE_LIQUIDITY_PCT): number {
  const v = scored.map((x) => x.value).filter((x): x is number => Number.isFinite(x) && x! > 0).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * pct))] : 0;
}

export function pickCandidates<T extends { code: string; sector: string; rating: string; value?: number }>(scored: T[], held: Set<string>, max = 12, perSector = 3, minCount = 6, cut = liquidityCut(scored)): T[] {
  minCount = Math.min(minCount, max);
  // 成交金額沒有資料的（測試或少數情況）不擋；有資料的要達到門檻
  scored = scored.filter((x) => !(Number.isFinite(x.value) && (x.value as number) < cut));
  const out: T[] = [];
  const per = new Map<string, number>();
  const take = (list: T[], limit: number) => {
    for (const x of list) {
      if (out.length >= limit) break;
      if (held.has(x.code) || out.includes(x) || (per.get(x.sector) ?? 0) >= perSector) continue;
      out.push(x); per.set(x.sector, (per.get(x.sector) ?? 0) + 1);
    }
  };
  take(scored.filter((x) => x.rating === "買入"), max);
  if (out.length < minCount) take(scored.filter((x) => x.rating === "觀望"), minCount); // 只補到 minCount 檔
  return out;
}

/** 是不是 App 自己送給 Claude 的提問（貼錯時要擋下來，不能存成 Claude 的回覆） */
export function isOwnPrompt(text: string): boolean {
  const t = text.trim();
  return t.slice(0, 120).includes("我要用新台幣") && /【(候選股|持股)/.test(t);
}

/** 候選股依產業分組（組內分數高到低，組與組依最高分排序），給畫面顯示用 */
export function groupBySector<T extends { sector: string; score: number }>(list: T[]): { sector: string; items: T[] }[] {
  const m = new Map<string, T[]>();
  for (const x of list) m.set(x.sector, [...(m.get(x.sector) ?? []), x]);
  return [...m.entries()]
    .map(([sector, items]) => ({ sector, items: [...items].sort((a, b) => b.score - a.score) }))
    .sort((a, b) => b.items[0].score - a.items[0].score);
}

/** 剪貼簿裡的文字像不像 Claude 對自組 ETF 的回覆：有買賣清單，或明說維持不變；App 自己送出去的提問不算 */
export function looksLikePlanReply(text: string): { ok: boolean; items: number } {
  const t = text.trim();
  if (t.length < 80 || isOwnPrompt(t) || t.slice(0, 80).includes("我要用新台幣")) return { ok: false, items: 0 };
  const items = parsePlan(t).items.length;
  return { ok: items > 0 || (/維持不變/.test(t) && t.length > 150), items };
}

/** 依預算檢查：買進總額（含手續費）超過可用現金時，等比例縮小股數 */
export function fitBudget(items: PlanItem[], price: (code: string) => number | undefined, cash: number): PlanItem[] {
  const sells = items.filter((x) => x.side === "sell").reduce((a, x) => a + cashFlow({ side: "sell", shares: x.shares, price: price(x.code) ?? 0, code: x.code }), 0);
  const buys = items.filter((x) => x.side === "buy");
  const need = buys.reduce((a, x) => a + -cashFlow({ side: "buy", shares: x.shares, price: price(x.code) ?? 0 }), 0);
  const avail = cash + sells;
  if (need <= avail || need <= 0) return items;
  const k = avail / need;
  return items.map((x) => (x.side === "buy" ? { ...x, shares: Math.floor(x.shares * k) } : x)).filter((x) => x.shares > 0);
}

// ---------- 免費提醒：離場評等、跌破停損 ----------
export const DEFAULT_STOP = 0.1; // 沒設定停損價時，用平均成本 −10%

/** 這檔的停損價；沒設定就用預設（成本 −10%） */
export function stopOf(p: Pick<Position, "code" | "avgCost">, stops: Record<string, number> = {}): { stop: number; isDefault: boolean } {
  const s = stops[p.code];
  return s > 0 ? { stop: s, isDefault: false } : { stop: Math.round(p.avgCost * (1 - DEFAULT_STOP) * 100) / 100, isDefault: true };
}

export interface EtfAlert { code: string; name: string; kind: "stop" | "exit"; price?: number; stop?: number; isDefault?: boolean }

/** 目前持股中：跌破停損價、或被 App 評為「離場」的 */
export function etfAlerts(etf: AiEtf, price: (code: string) => number | undefined, rating: (code: string) => string | undefined): EtfAlert[] {
  const out: EtfAlert[] = [];
  for (const p of positions(etf.trades)) {
    if (p.shares <= 0) continue;
    const px = price(p.code);
    const { stop, isDefault } = stopOf(p, etf.stops);
    if (px !== undefined && Number.isFinite(px) && px <= stop) out.push({ code: p.code, name: p.name, kind: "stop", price: px, stop, isDefault });
    if (rating(p.code) === "離場") out.push({ code: p.code, name: p.name, kind: "exit", price: px });
  }
  return out;
}

// ---------- 拍照匯入：庫存截圖和目前自組 ETF 對帳 ----------
export interface PhotoRow { code: string; name: string; side: "buy" | "sell"; shares: number; price: number; suggested: boolean }

/**
 * 把庫存截圖辨識到的「股數、平均成本」和目前的自組 ETF 持股比對，算出要補記的買賣。
 * 多出來的股數記成買進（價格由截圖的平均成本反推，推不出來用現價）；變少的記成賣出（用現價）。
 * 截圖沒出現的持股不自動賣出（截圖可能只拍到一部分）。
 */
export function reconcilePhoto(
  etf: AiEtf,
  photo: { code: string; name: string; shares: number; cost: number }[],
  price: (code: string) => number | undefined,
  suggested: Set<string>,
): PhotoRow[] {
  const cur = new Map(positions(etf.trades).map((p) => [p.code, p]));
  const rows: PhotoRow[] = [];
  for (const h of photo) {
    const code = h.code.trim().toUpperCase();
    const p = cur.get(code);
    const have = p?.shares ?? 0;
    const diff = Math.round(h.shares) - have;
    if (!code || diff === 0) continue;
    const px = price(code);
    let fill = px ?? 0;
    if (diff > 0 && h.cost > 0) {
      // 截圖的平均成本 × 股數 − 已記錄的成本 = 這次買進花的錢
      const spent = h.cost * h.shares - (p ? p.avgCost * have : 0);
      const each = spent / diff;
      if (each > 0 && (!px || Math.abs(each / px - 1) < 0.3)) fill = Math.round(each * 100) / 100;
    }
    rows.push({ code, name: h.name || p?.name || code, side: diff > 0 ? "buy" : "sell", shares: Math.abs(diff), price: fill, suggested: suggested.has(code) || have > 0 });
  }
  return rows;
}

// ---------- 付費 API 與 Claude App（Pro）兩份建議的比較 ----------
export interface PlanCompare { code: string; api?: PlanItem; pro?: PlanItem; same: boolean }

/** 依代號並排兩份建議；方向與股數都一樣（股數差 10% 以內）才算相同 */
export function comparePlans(api: PlanItem[], pro: PlanItem[]): PlanCompare[] {
  const codes = [...new Set([...api.map((x) => x.code), ...pro.map((x) => x.code)])];
  return codes.map((code) => {
    const a = api.find((x) => x.code === code), b = pro.find((x) => x.code === code);
    const same = !!a && !!b && a.side === b.side && Math.abs(a.shares - b.shares) <= Math.max(a.shares, b.shares) * 0.1;
    return { code, api: a, pro: b, same };
  });
}

// ---------- 我的實單：每天自動的持股規則檢查（免費，不呼叫 Claude） ----------
export type HoldVerdict = "出場" | "減碼" | "續抱" | "可加碼";
export interface HoldCheck {
  code: string; name: string; shares: number; avgCost: number; price?: number;
  pnl?: number; weight?: number; stop: number; verdict: HoldVerdict; reasons: string[];
}
/** 評分資料（只用到這幾個欄位） */
export interface HoldScore { rating?: string; score?: number; ret1w?: number; ret1m?: number; foreignStreak?: number; foreign5?: number; refOnly?: boolean }

const VERDICT_ORDER: Record<HoldVerdict, number> = { 出場: 0, 減碼: 1, 可加碼: 2, 續抱: 3 };

/**
 * 規則：
 * - 出場：收盤（或即時價）跌破停損價，或 App 評為「離場」
 * - 減碼：外資連賣 3 天以上且近 1 週下跌、虧損超過 8%（接近預設 10% 停損）、近 1 月跌超過 10%、單一持股超過淨值 30%
 * - 可加碼：App 評為「買入」、分數 70 以上、目前賺錢、近 1 週漲幅還沒超過 15%
 * - 其餘續抱
 * 依嚴重程度排序（出場、減碼、可加碼、續抱）。
 */
export function dailyHoldingCheck(
  etf: AiEtf,
  price: (code: string) => number | undefined,
  score: (code: string) => HoldScore | undefined,
): HoldCheck[] {
  const v = valuate(etf, price);
  const out: HoldCheck[] = [];
  for (const p of positions(etf.trades)) {
    if (p.shares <= 0) continue;
    const px = price(p.code);
    const has = px !== undefined && Number.isFinite(px);
    const { stop } = stopOf(p, etf.stops);
    const s = score(p.code);
    const pnl = has && p.avgCost > 0 ? px! / p.avgCost - 1 : undefined;
    const weight = has && v.nav > 0 ? (px! * p.shares) / v.nav : undefined;
    const pct = (x: number) => `${x > 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
    const out1: string[] = [], warn: string[] = [], good: string[] = [];
    if (has && px! <= stop) out1.push(`價格 ${px} 跌破停損 ${stop}`);
    if (s?.rating === "離場") out1.push("App 評為「離場」（動能或籌碼轉弱）");
    if ((s?.foreignStreak ?? 0) <= -3 && (s?.ret1w ?? 0) < 0) warn.push(`外資連賣 ${-(s!.foreignStreak!)} 天、近 1 週 ${pct(s!.ret1w!)}`);
    if (pnl !== undefined && pnl <= -0.08 && !(has && px! <= stop)) warn.push(`虧損 ${pct(pnl)}，接近停損`);
    if ((s?.ret1m ?? 0) <= -0.1) warn.push(`近 1 月 ${pct(s!.ret1m!)}`);
    if (weight !== undefined && weight > 0.3) warn.push(`佔淨值 ${(weight * 100).toFixed(0)}%，太集中`);
    if (s?.rating === "買入" && (s.score ?? 0) >= 70 && (pnl ?? -1) > 0 && (s.ret1w ?? 1) < 0.15) good.push(`App 評為「買入」（${s.score} 分）、目前獲利 ${pct(pnl!)}、近 1 週還沒過熱`);
    const verdict: HoldVerdict = out1.length ? "出場" : warn.length ? "減碼" : good.length ? "可加碼" : "續抱";
    const reasons = out1.length ? [...out1, ...warn] : warn.length ? warn : good.length ? good : [s?.rating ? `App 評為「${s.rating}」${s.score !== undefined ? `（${s.score} 分）` : ""}，沒有觸發出場或減碼條件` : "沒有評分資料，只檢查停損"];
    out.push({ code: p.code, name: p.name, shares: p.shares, avgCost: p.avgCost, price: has ? px : undefined, pnl, weight, stop, verdict, reasons });
  }
  return out.sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || (b.weight ?? 0) - (a.weight ?? 0));
}

// ---------- 今日下單清單的「條件」：規則自動算的「如果…就…」 ----------
const px2 = (x: number) => (x >= 100 ? Math.round(x * 2) / 2 : x >= 10 ? Math.round(x * 20) / 20 : Math.round(x * 100) / 100);
const n = (x: number) => px2(x).toLocaleString("zh-TW", { maximumFractionDigits: 2 });

/** 買進：限價不追、停損、漲多後停損上移保本 */
export function buyConds(ref: number, stop?: number): string[] {
  const out = [`開盤高於 ${n(ref * 1.015)}（+1.5%）→ 不追，今天不買`];
  if (stop) out.push(`成交後收盤跌破 ${n(stop)} → 隔天開盤停損賣出`);
  out.push(`漲到 ${n(ref * 1.1)} 以上 → 停損價調高到買進價 ${n(ref)}：之後跌回這裡就賣，至少不虧`);
  return out;
}

/** 賣出：規則觸發的出場直接賣；Claude 建議的賣出遇到開盤急跌先不殺低；有剩下的寫續抱與停損 */
export function sellConds(o: { ref?: number; byRule: boolean; stopHit: boolean; held?: number; shares: number; stop?: number }): string[] {
  const out: string[] = [];
  if (o.stopHit) out.push("已跌破停損：開盤直接賣出，不等反彈");
  else if (o.ref && !o.byRule) {
    out.push(`開盤漲到 ${n(o.ref * 1.015)} 以上 → 照賣，等於賣在相對高點`);
    out.push(`開盤跌到 ${n(o.ref * 0.98)} 以下（−2%）→ 先不賣，收盤再看，不殺低`);
  } else if (o.ref) out.push(`規則減碼：開盤照賣；之後收盤站回 ${n(o.ref * 1.05)} 以上可考慮買回`);
  const left = (o.held ?? 0) - o.shares;
  if (left > 0) out.push(`剩下 ${left.toLocaleString()} 股續抱${o.stop ? `，停損 ${n(o.stop)}` : ""}`);
  else if (o.held !== undefined) out.push("全部賣出");
  return out;
}

/** 不動（續抱）：跌破停損賣出、接近停損或外資連賣減碼、漲多停損上移 */
export function holdConds(o: { price?: number; avgCost: number; stop: number; verdict: string }): string[] {
  const out = [`收盤跌破 ${n(o.stop)} → 隔天開盤全部賣出`];
  if (o.verdict === "可加碼" && o.price) out.push(`想加碼：限價不高於 ${n(o.price * 1.015)}，加碼後停損一樣 ${n(o.stop)}`);
  else out.push(`外資連賣 3 天且近 1 週下跌，或虧損達 8%（${n(o.avgCost * 0.92)}）→ 減碼一半`);
  if (o.price) {
    const up = o.price * 1.1, ns = Math.max(o.stop, o.price);
    if (ns > o.stop * 1.005) out.push(`漲到 ${n(up)} 以上 → 停損價從 ${n(o.stop)} 調高到 ${n(ns)}（現在的價格）：之後跌回這裡就賣，${ns >= o.avgCost ? "鎖住獲利" : "少虧一點"}`);
  }
  return out;
}
