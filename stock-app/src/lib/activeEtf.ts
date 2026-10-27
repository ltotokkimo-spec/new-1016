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
  return { version: 1, updatedAt, etfs, days: buildActiveDays(hist) };
}

export interface ActiveRankRow<T> { item: T; shares: number; amount: number; buyers: [string, number][] }

/** 主動式 ETF 個股買賣超排名：最近 days 天合計，依金額（股數 × 收盤價）取買超、賣超前 n 名 */
export function activeRank<T extends { close: number }>(data: ActiveEtfData | undefined, days: number, lookup: (code: string) => T | undefined, n = 20): { buy: ActiveRankRow<T>[]; sell: ActiveRankRow<T>[]; used: ActiveDay[] } {
  const used = (data?.days ?? []).slice(0, days);
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
  };
}
