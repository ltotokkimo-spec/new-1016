// 主動式 ETF 個股買賣超：每天抓各主動式 ETF 的完整持股（MoneyDJ「全部持股」頁，各投信每日公布的持股），
// 和同一檔 ETF 前一份持股比對股數，得到每檔 ETF 買賣了哪些股票；全部主動式 ETF 加總就是個股的主動式 ETF 買賣超。
// 只算台股個股（4 碼代號），期貨、現金、國外股票不算。股數變化也包含投資人申購買回造成的同比例買賣，那也是 ETF 實際的買賣。

/** 一份持股：資料日（YYYYMMDD）與各股股數 */
export interface HoldingSnap { date: string; shares: Record<string, number> }
/** 各 ETF 的歷史持股（保留最近幾份，用來比對） */
export interface ActiveHist { version: 1; etfs: Record<string, { name: string; snaps: HoldingSnap[] }> }
/** 某一天某檔股票的主動式 ETF 買賣：s 合計股數，b 各 ETF 的增減 [ETF 代號, 股數]（依增減大小排序） */
export interface ActiveFlow { s: number; b: [string, number][] }
export interface ActiveDay { date: string; prev: Record<string, string>; flows: Record<string, ActiveFlow> }
export interface ActiveEtfData {
  version: 1;
  updatedAt: string;
  etfs: { code: string; name: string; date: string; n: number }[]; // n = 持有台股檔數
  days: ActiveDay[]; // 新到舊
  latest?: Record<string, HoldingSnap>; // 各 ETF 最新一份持股（App 自己抓到更新的持股時，用來比對）
  live?: string; // App 自己向 MoneyDJ 補抓到的資料日（有的話）
}

const num = (s: string) => Number(s.replace(/,/g, ""));
const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim();

/** 解析 MoneyDJ「個別ETF-全部持股」頁（Basic0007B） */
export function parseMoneyDjHoldings(html: string): { code: string; name: string; date: string; shares: Record<string, number> } | undefined {
  const dm = /資料日期[：:]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(html);
  const nm = /([^\s>〈(]+)[〈(](\d{4,6}[A-Z]?)\.TW[〉)]\s*-\s*全部持股/.exec(stripTags(html));
  if (!dm || !nm) return undefined;
  const date = `${dm[1]}${dm[2].padStart(2, "0")}${dm[3].padStart(2, "0")}`;
  const shares: Record<string, number> = {};
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/g) ?? []) {
    const td = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1]));
    if (td.length < 3) continue;
    const cm = /\(([1-9]\d{3})\.TWO?\)\s*$/.exec(td[0]);
    const sh = num(td[2]);
    if (!cm || !Number.isFinite(sh)) continue;
    shares[cm[1]] = (shares[cm[1]] ?? 0) + sh;
  }
  return { code: nm[2], name: nm[1], date, shares };
}

/** 把新抓到的持股加進歷史；同一天的覆蓋，只留最近 keep 份 */
export function addSnap(hist: ActiveHist, code: string, name: string, snap: HoldingSnap, keep = 12): ActiveHist {
  const cur = hist.etfs[code]?.snaps ?? [];
  const snaps = [...cur.filter((s) => s.date !== snap.date), snap].sort((a, b) => a.date.localeCompare(b.date)).slice(-keep);
  return { ...hist, etfs: { ...hist.etfs, [code]: { name, snaps } } };
}

/** 從歷史持股算每天的主動式 ETF 個股買賣超：每檔 ETF 相鄰兩份持股的股數差，算在後一份的日期 */
export function buildActiveDays(hist: ActiveHist, maxDays = 10): ActiveDay[] {
  const byDate = new Map<string, ActiveDay>();
  for (const [etf, { snaps }] of Object.entries(hist.etfs)) {
    for (let i = 1; i < snaps.length; i++) {
      const p = snaps[i - 1], d = snaps[i];
      const day = byDate.get(d.date) ?? { date: d.date, prev: {}, flows: {} };
      byDate.set(d.date, day);
      day.prev[etf] = p.date;
      for (const code of new Set([...Object.keys(p.shares), ...Object.keys(d.shares)])) {
        const delta = (d.shares[code] ?? 0) - (p.shares[code] ?? 0);
        if (!delta) continue;
        const f = (day.flows[code] ??= { s: 0, b: [] });
        f.s += delta;
        f.b.push([etf, delta]);
      }
    }
  }
  const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, maxDays);
  for (const d of days) for (const f of Object.values(d.flows)) f.b.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
  return days;
}

export function buildActiveData(hist: ActiveHist, updatedAt: string): ActiveEtfData {
  const etfs = Object.entries(hist.etfs)
    .map(([code, e]) => { const last = e.snaps[e.snaps.length - 1]; return { code, name: e.name, date: last?.date ?? "", n: last ? Object.keys(last.shares).length : 0 }; })
    .filter((e) => e.n > 0)
    .sort((a, b) => a.code.localeCompare(b.code));
  const latest: Record<string, HoldingSnap> = {};
  for (const [code, e] of Object.entries(hist.etfs)) { const last = e.snaps[e.snaps.length - 1]; if (last && Object.keys(last.shares).length) latest[code] = last; }
  return { version: 1, updatedAt, etfs, days: buildActiveDays(hist), latest };
}

/** App 自己抓到的最新持股（比 GitHub 那份新的）併進資料：和 latest 那份比對，算出新的日子；同一天已經有的 ETF 不重複算 */
export function mergeLive(data: ActiveEtfData, fresh: { code: string; name: string; date: string; shares: Record<string, number> }[]): ActiveEtfData {
  const latest = { ...(data.latest ?? {}) };
  let hist: ActiveHist = { version: 1, etfs: {} };
  const names = new Map(data.etfs.map((e) => [e.code, e.name]));
  let changed = false;
  for (const f of fresh) {
    const prev = latest[f.code];
    if (!prev || f.date <= prev.date || !Object.keys(f.shares).length) continue;
    hist = addSnap(hist, f.code, f.name, prev);
    hist = addSnap(hist, f.code, f.name, { date: f.date, shares: f.shares });
    latest[f.code] = { date: f.date, shares: f.shares };
    names.set(f.code, f.name);
    changed = true;
  }
  if (!changed) return data;
  const byDate = new Map(data.days.map((d) => [d.date, { date: d.date, prev: { ...d.prev }, flows: Object.fromEntries(Object.entries(d.flows).map(([c, f]) => [c, { s: f.s, b: [...f.b] }])) }]));
  for (const nd of buildActiveDays(hist, 99)) {
    const day = byDate.get(nd.date) ?? { date: nd.date, prev: {}, flows: {} };
    byDate.set(nd.date, day);
    const add = new Set(Object.keys(nd.prev).filter((e) => !(e in day.prev)));
    for (const e of add) day.prev[e] = nd.prev[e];
    for (const [code, f] of Object.entries(nd.flows)) for (const [e, v] of f.b) {
      if (!add.has(e)) continue;
      const t = (day.flows[code] ??= { s: 0, b: [] });
      t.s += v; t.b.push([e, v]); t.b.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
    }
  }
  const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
  const etfs = Object.entries(latest).map(([code, l]) => ({ code, name: names.get(code) ?? code, date: l.date, n: Object.keys(l.shares).length })).sort((a, b) => a.code.localeCompare(b.code));
  const live = Object.values(latest).reduce((m, l) => (l.date > m ? l.date : m), "");
  return { ...data, etfs, days, latest, live };
}

/** 取最近 n 個持股日。「最新一天」只取公布家數過半的那天：各投信公布時間不一，最新那天常常只有 1～2 檔先公布，不能拿來當整天的買賣超 */
export function pickDays(data: ActiveEtfData | undefined, n: number): { used: ActiveDay[]; partial?: { date: string; n: number; of: number } } {
  const days = data?.days ?? [];
  if (n !== 1) return { used: days.slice(0, n) };
  const total = Math.max(data?.etfs.length ?? 0, ...days.map((d) => Object.keys(d.prev).length));
  const i = days.findIndex((d) => Object.keys(d.prev).length * 2 >= total);
  if (i < 0) return { used: days.slice(0, 1) };
  return { used: [days[i]], partial: i > 0 ? { date: days[0].date, n: Object.keys(days[0].prev).length, of: total } : undefined };
}

export interface ActiveRankRow<T> { item: T; shares: number; amount: number; buyers: [string, number][] }

/** 主動式 ETF 個股買賣超排名：最近 days 天合計，依金額（股數 × 收盤價）取買超、賣超前 n 名 */
export function activeRank<T extends { close: number }>(data: ActiveEtfData | undefined, days: number, lookup: (code: string) => T | undefined, n = 20): { buy: ActiveRankRow<T>[]; sell: ActiveRankRow<T>[]; used: ActiveDay[]; partial?: { date: string; n: number; of: number } } {
  const { used, partial } = pickDays(data, days);
  const sum = new Map<string, { s: number; by: Map<string, number> }>();
  for (const d of used) for (const [code, f] of Object.entries(d.flows)) {
    const x = sum.get(code) ?? { s: 0, by: new Map() };
    sum.set(code, x);
    x.s += f.s;
    for (const [etf, v] of f.b) x.by.set(etf, (x.by.get(etf) ?? 0) + v);
  }
  const rows: ActiveRankRow<T>[] = [];
  for (const [code, x] of sum) {
    const item = lookup(code);
    if (!item || !(item.close > 0) || !x.s) continue;
    const buyers = [...x.by].filter(([, v]) => v !== 0).sort((a, b) => (x.s > 0 ? b[1] - a[1] : a[1] - b[1]));
    rows.push({ item, shares: x.s, amount: x.s * item.close, buyers });
  }
  return {
    buy: rows.filter((r) => r.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, n),
    sell: rows.filter((r) => r.amount < 0).sort((a, b) => a.amount - b.amount).slice(0, n),
    used,
    partial,
  };
}

export interface EtfWho { etf: string; name: string; delta: number; before: number; after: number; perDay: [string, number][] }

/** 某檔股票在最近 days 天，是哪幾檔主動式 ETF 買賣：每檔合計增減、持股前後（股）與每天明細，依增減大小排序 */
export function etfBreakdown(data: ActiveEtfData | undefined, code: string, days: number): { rows: EtfWho[]; used: ActiveDay[] } {
  const { used } = pickDays(data, days);
  const names = new Map((data?.etfs ?? []).map((e) => [e.code, e.name]));
  const by = new Map<string, [string, number][]>();
  for (const d of used) for (const [etf, v] of d.flows[code]?.b ?? []) by.set(etf, [...(by.get(etf) ?? []), [d.date, v]]);
  const rows: EtfWho[] = [];
  for (const [etf, perDay] of by) {
    const delta = perDay.reduce((a, [, v]) => a + v, 0);
    if (!delta) continue;
    const after = data?.latest?.[etf]?.shares[code] ?? 0;
    rows.push({ etf, name: names.get(etf) ?? etf, delta, before: Math.max(0, after - delta), after, perDay });
  }
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { rows, used };
}

export interface EtfMove { code: string; delta: number; before: number; after: number; perDay: [string, number][] }
export interface EtfHold { code: string; shares: number; delta: number }

/** 某檔主動式 ETF 最近 days 天買賣了哪些股票（含新增、清倉）與目前完整持股（台股個股）；沒有這檔就回傳 undefined */
export function etfHoldings(data: ActiveEtfData | undefined, etf: string, days: number): { name: string; date: string; n: number; moves: EtfMove[]; hold: EtfHold[]; used: string[] } | undefined {
  const latest = data?.latest?.[etf];
  const info = data?.etfs.find((e) => e.code === etf);
  if (!latest || !info) return undefined;
  const used = (data?.days ?? []).filter((d) => etf in d.prev).slice(0, days);
  const by = new Map<string, [string, number][]>();
  for (const d of used) for (const [code, f] of Object.entries(d.flows)) for (const [e, v] of f.b) if (e === etf) by.set(code, [...(by.get(code) ?? []), [d.date, v]]);
  const moves: EtfMove[] = [];
  for (const [code, perDay] of by) {
    const delta = perDay.reduce((a, [, v]) => a + v, 0);
    if (!delta) continue;
    const after = latest.shares[code] ?? 0;
    moves.push({ code, delta, before: Math.max(0, after - delta), after, perDay });
  }
  moves.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const delta = new Map(moves.map((m) => [m.code, m.delta]));
  const hold = Object.entries(latest.shares).map(([code, shares]) => ({ code, shares, delta: delta.get(code) ?? 0 })).sort((a, b) => b.shares - a.shares);
  return { name: info.name, date: latest.date, n: hold.length, moves, hold, used: used.map((d) => d.date) };
}
