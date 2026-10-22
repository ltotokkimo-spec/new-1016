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
export interface AiEtf {
  budget: number; // 起始資金
  trades: EtfTrade[];
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
      out[t.id] = cashFlow({ side: "sell", shares: n, price: t.price }) - n * p.avgCost;
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
export interface PlanItem { code: string; side: "buy" | "sell"; shares: number; reason: string; stop?: number }

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
export function parsePlan(text: string): { items: PlanItem[]; body: string; stops: Record<string, number> } {
  const last = findPlanJson(text);
  if (!last) return { items: [], body: text, stops: {} };
  let items: PlanItem[] = [];
  const stops: Record<string, number> = {};
  try {
    const j = JSON.parse(last.json);
    const arr = Array.isArray(j) ? j : j.trades ?? j.picks ?? [];
    items = arr
      .map((x: any) => ({
        code: String(x.code ?? "").trim().toUpperCase(),
        side: x.side === "sell" ? "sell" : "buy",
        shares: Math.max(0, Math.round(Number(x.shares))),
        reason: String(x.reason ?? ""),
        stop: Number(x.stop) > 0 ? Number(x.stop) : undefined,
      }))
      .filter((x: PlanItem) => x.code && x.shares > 0);
    // 停損價：每筆買進的 stop，加上檢視時對「不動」持股另外給的 stops
    if (j && typeof j.stops === "object" && !Array.isArray(j.stops))
      for (const [k, v] of Object.entries(j.stops)) if (Number(v) > 0) stops[k.trim().toUpperCase()] = Number(v);
    for (const it of items) if (it.stop) stops[it.code] = it.stop;
  } catch { /* JSON 壞掉就只顯示文字 */ }
  return { items, body: (text.slice(0, last.start) + text.slice(last.end)).trim(), stops };
}

/** 給 Claude 的候選股：只取 App「買入」的高分股，每個產業最多 perSector 檔、全部最多 max 檔，已持有的不重複列（持股那邊已有最新價格）。不夠 minCount 檔時用高分的「觀望」補 */
/** 買進的股票是否不在 App 選股的「買入」清單裡（ETF 只當參考、不評等，不算）；查不到資料也算不在 */
export function isOffList(s: { rating: string; refOnly?: boolean } | undefined): boolean {
  return s ? !s.refOnly && s.rating !== "買入" : true;
}

export function pickCandidates<T extends { code: string; sector: string; rating: string }>(scored: T[], held: Set<string>, max = 12, perSector = 3, minCount = 6): T[] {
  minCount = Math.min(minCount, max);
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
  const sells = items.filter((x) => x.side === "sell").reduce((a, x) => a + cashFlow({ side: "sell", shares: x.shares, price: price(x.code) ?? 0 }), 0);
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
