// 推薦績效追蹤：每天收盤後把 App 的「買入」名單記下來（只新增、不覆蓋），之後每天更新每筆推薦持有 5／10／20 個交易日的報酬，
// 和同期加權指數、0050 比較。由 GitHub Actions 的每日回測（tools/backtest.ts）計算，App 只下載結果顯示。
//
// 報酬算法：
// - 每天的漲跌用證交所／櫃買公布的「漲跌」連乘（對除權息後的參考價計算），配息、除權不會被算成下跌（和回測一樣）。
// - 試算金額每筆 1 萬元，股數＝1 萬 ÷ 推薦價（無條件捨去，可以是零股）；手續費 0.1425%，整股最低 20 元、零股最低 1 元；
//   賣出證交稅股票 0.3%、ETF 0.1%。淨報酬＝（賣出金額 − 手續費 − 證交稅）÷（買進金額＋手續費）− 1。
// - 停損：推薦價 −8%。資料只有每日收盤（沒有盤中最低價），所以「觸及停損」用收盤價判斷，並以那天收盤價出場試算。
// - 加權指數、0050 的報酬是不含成本的同期漲跌；超額報酬＝推薦的淨報酬 − 基準報酬。

export const PICK_HORIZONS = [5, 10, 20] as const;
export type PickH = (typeof PICK_HORIZONS)[number];
export const PICK_NOTIONAL = 10_000; // 每筆試算金額（元）
export const PICK_STOP = 0.08; // 停損：推薦價 −8%
export const FEE_RATE = 0.001425;
export const FEE_MIN_LOT = 20; // 整股最低手續費
export const FEE_MIN_ODD = 1; // 零股最低手續費
export const TAX_STOCK = 0.003;
export const TAX_ETF = 0.001;
// 美股（使用者 11/7 指定）：每筆 1,000 美元、可買小數股；複委託手續費買賣各 0.1%、沒有最低；美國沒有證交稅；不含匯差
export const US_NOTIONAL = 1_000;
export const US_FEE_RATE = 0.001;
export const ETF_TOP_N = 10; // ETF 沒有「買入」評等：記下每天分數最高的 10 檔（使用者 11/7 指定）

/** 三本推薦紀錄：台股個股「買入」、台股 ETF 分數前 10 名、美股「買入」 */
export type PickBook = "TW" | "ETF" | "US";
export const PICK_BOOKS: PickBook[] = ["TW", "ETF", "US"];
export const BOOK_INFO: Record<PickBook, { label: string; source: "買入" | "分數前10"; rule: string; files: { log: string; perf: string; csv: string }; bench: [string, string]; currency: "TWD" | "USD" }> = {
  TW: { label: "台股", source: "買入", rule: "每個交易日收盤後，記下 App 評為「買入」的全部股票（不含 ETF）；推薦價為當日收盤，停損為推薦價 −8%。", files: { log: "picks.json", perf: "picks-perf.json", csv: "picks.csv" }, bench: ["加權指數", "0050"], currency: "TWD" },
  ETF: { label: "ETF", source: "分數前10", rule: `ETF 沒有「買入」評等，每個交易日收盤後記下 ETF 分數最高的 ${ETF_TOP_N} 檔（只當參考）；推薦價為當日收盤，停損為推薦價 −8%。`, files: { log: "picks-etf.json", perf: "picks-perf-etf.json", csv: "picks-etf.csv" }, bench: ["加權指數", "0050"], currency: "TWD" },
  US: { label: "美股", source: "買入", rule: "每個美股交易日收盤後，記下 App 評為「買入」的全部美股（App 內建的美股清單）；推薦價為當日收盤，停損為推薦價 −8%。", files: { log: "picks-us.json", perf: "picks-perf-us.json", csv: "picks-us.csv" }, bench: ["S&P 500（SPY）", "那斯達克 100（QQQ）"], currency: "USD" },
};

/** 一筆推薦（記下來之後永遠不改） */
export interface PickRec {
  id: string; // 日期-代號
  date: string; // 推薦日（資料日）YYYYMMDD
  code: string;
  name: string;
  market: "TWSE" | "TPEX" | "US";
  price: number; // 推薦價＝推薦日收盤
  stop: number; // 停損價
  score: number;
  reasons: string[];
  dataDate: string; // 評分用的資料日（行情與三大法人）
  source: "買入" | "分數前10";
}

export interface PickLog {
  version: 1;
  start: string; // 第一天記錄的日期
  rule: string; // 記錄規則說明（顯示在 App）
  picks: PickRec[];
}

export const emptyLog = (book: PickBook = "TW"): PickLog => ({ version: 1, start: "", rule: BOOK_INFO[book].rule, picks: [] });

/** 當天的推薦加進紀錄：同一天已經記過就不重記；既有紀錄一筆都不改、不刪 */
export function appendPicks(log: PickLog, date: string, picks: Omit<PickRec, "id" | "date" | "stop" | "source">[], source: PickRec["source"] = "買入"): { log: PickLog; added: number } {
  if (!picks.length || log.picks.some((p) => p.date === date)) return { log, added: 0 };
  if (log.picks.length && date < log.picks[log.picks.length - 1].date) return { log, added: 0 }; // 只往後新增，不補過去的日子
  const add: PickRec[] = picks.map((p) => ({ ...p, id: `${date}-${p.code}`, date, stop: Math.round(p.price * (1 - PICK_STOP) * 100) / 100, source }));
  return { log: { ...log, start: log.start || date, picks: [...log.picks, ...add] }, added: add.length };
}

/** 確認新紀錄包含舊紀錄的每一筆而且內容沒變（防止程式錯誤覆蓋或刪除舊紀錄） */
export function assertAppendOnly(before: PickLog, after: PickLog): void {
  const m = new Map(after.picks.map((p) => [p.id, JSON.stringify(p)]));
  for (const p of before.picks) if (m.get(p.id) !== JSON.stringify(p)) throw new Error(`推薦紀錄 ${p.id} 被改動或刪除`);
}

/** 試算一筆買賣的淨報酬（含手續費、證交稅；零股最低手續費 1 元、整股 20 元） */
export function netReturn(buy: number, sell: number, etf = false, notional = PICK_NOTIONAL): { shares: number; net: number } {
  const shares = Math.max(1, Math.floor(notional / buy));
  const fee = (v: number) => Math.max(shares >= 1000 ? FEE_MIN_LOT : FEE_MIN_ODD, Math.round(v * FEE_RATE));
  const bv = buy * shares, sv = sell * shares;
  const cost = bv + fee(bv);
  const back = sv - fee(sv) - Math.round(sv * (etf ? TAX_ETF : TAX_STOCK));
  return { shares, net: back / cost - 1 };
}

/** 美股：1,000 美元買小數股，買賣各收 0.1% 手續費（沒有最低），沒有證交稅 */
export function netReturnUs(buy: number, sell: number, notional = US_NOTIONAL): { shares: number; net: number } {
  const shares = notional / buy;
  const bv = buy * shares, sv = sell * shares;
  return { shares, net: (sv - sv * US_FEE_RATE) / (bv + bv * US_FEE_RATE) - 1 };
}

const netOf = (p: Pick<PickRec, "code" | "market">, buy: number, sell: number) => (p.market === "US" ? netReturnUs(buy, sell).net : netReturn(buy, sell, /^00\d/.test(p.code)).net);

/** 一檔股票從推薦日之後每個交易日的「累積漲跌倍數」（相對推薦價，已排除除權息） */
export interface PathPoint { date: string; f: number } // f：相對推薦日收盤的倍數（1.05＝+5%）

export interface HorizonResult {
  ret: number; // 持有到第 h 天收盤的毛報酬（不含成本）
  net: number; // 淨報酬（扣成本）
  taiex?: number; // 同期加權指數報酬
  b0050?: number; // 同期 0050 報酬
  exTaiex?: number; // 超額報酬（淨報酬 − 加權）
  ex0050?: number;
  stopHit: boolean; // 期間收盤曾跌破停損
  stopNet?: number; // 照停損出場的淨報酬（第一次跌破那天收盤賣）；沒觸及＝持有到期的淨報酬
  stopDate?: string;
}
export interface PickPerf extends PickRec {
  elapsed: number; // 推薦後已經過幾個交易日
  lastDate?: string;
  curRet?: number; // 到最新收盤的毛報酬
  curNet?: number;
  h: Partial<Record<PickH, HorizonResult>>; // 只有已經滿 h 天的才有
}

/** 算一筆推薦的績效；path 是推薦日之後（不含推薦日）依日期排列的累積倍數，bench 同理 */
export function evaluatePick(p: PickRec, path: PathPoint[], taiex: Map<string, number>, b0050: Map<string, number>): PickPerf {
  const out: PickPerf = { ...p, elapsed: path.length, h: {} };
  if (path.length) {
    const last = path[path.length - 1];
    out.lastDate = last.date;
    out.curRet = last.f - 1;
    out.curNet = netOf(p, p.price, p.price * last.f);
  }
  const stopF = p.stop / p.price;
  for (const h of PICK_HORIZONS) {
    if (path.length < h) continue;
    const seg = path.slice(0, h), end = seg[h - 1];
    const hit = seg.find((x) => x.f <= stopF + 1e-9);
    const net = netOf(p, p.price, p.price * end.f);
    const t = taiex.get(end.date), b = b0050.get(end.date);
    out.h[h] = {
      ret: end.f - 1, net,
      ...(t !== undefined ? { taiex: t, exTaiex: net - t } : {}),
      ...(b !== undefined ? { b0050: b, ex0050: net - b } : {}),
      stopHit: !!hit,
      stopNet: hit ? netOf(p, p.price, p.price * hit.f) : net,
      ...(hit ? { stopDate: hit.date } : {}),
    };
  }
  return out;
}

export interface PerfStat {
  n: number; // 已滿 h 天的筆數
  win: number; // 淨報酬 > 0 的比例
  avg: number; // 平均淨報酬
  avgExTaiex?: number;
  avgEx0050?: number;
  worst?: { id: string; name: string; code: string; date: string; net: number }; // 最大單筆虧損（淨報酬最低）
  stopRate: number; // 期間收盤曾跌破停損的比例
  avgStopNet: number; // 照停損出場的平均淨報酬
  benchTaiex?: number; // 同期加權平均報酬
  bench0050?: number;
}

/**
 * 首次推薦：連續好幾天都在買入名單的股票，只算進入名單的第一天；掉出名單後再回來，算新的一次。
 * 判斷方式：前一個記錄日的名單裡沒有這檔（第一個記錄日全部算首次）。
 */
export function firstPickIds(rows: Pick<PickRec, "id" | "date" | "code">[]): Set<string> {
  const byDate = new Map<string, Set<string>>();
  for (const r of rows) { let s = byDate.get(r.date); if (!s) byDate.set(r.date, (s = new Set())); s.add(r.code); }
  const dates = [...byDate.keys()].sort();
  const prevOf = new Map(dates.map((d, i) => [d, i ? byDate.get(dates[i - 1])! : undefined]));
  return new Set(rows.filter((r) => !prevOf.get(r.date)?.has(r.code)).map((r) => r.id));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function perfStats(rows: PickPerf[], h: PickH, from?: string, to?: string): PerfStat {
  const rs = rows.filter((r) => r.h[h] && (!from || r.date >= from) && (!to || r.date <= to));
  const H = rs.map((r) => r.h[h]!);
  const nets = H.map((x) => x.net);
  let worst: PerfStat["worst"];
  rs.forEach((r) => { const x = r.h[h]!.net; if (!worst || x < worst.net) worst = { id: r.id, name: r.name, code: r.code, date: r.date, net: x }; });
  const def = (xs: (number | undefined)[]) => { const v = xs.filter((x): x is number => x !== undefined); return v.length ? mean(v) : undefined; };
  return {
    n: rs.length,
    win: rs.length ? nets.filter((x) => x > 0).length / rs.length : NaN,
    avg: mean(nets),
    avgExTaiex: def(H.map((x) => x.exTaiex)),
    avgEx0050: def(H.map((x) => x.ex0050)),
    worst: worst && worst.net < 0 ? worst : undefined,
    stopRate: rs.length ? H.filter((x) => x.stopHit).length / rs.length : NaN,
    avgStopNet: mean(H.map((x) => x.stopNet ?? x.net)),
    benchTaiex: def(H.map((x) => x.taiex)),
    bench0050: def(H.map((x) => x.b0050)),
  };
}

/** 給 App 下載的結果 */
export interface PickPerfFile {
  version: 1;
  generatedAt: number;
  start: string; // 開始記錄的日期
  dataTo: string; // 最新資料日
  rule: string;
  source: string; // 資料來源說明
  book?: PickBook; // 沒有＝台股（1.0.286 以前的檔案）
  bench?: [string, string]; // 兩個對照基準的名稱；沒有＝加權指數、0050
  currency?: "TWD" | "USD";
  cost: { notional: number; feeRate: number; feeMinLot: number; feeMinOdd: number; taxStock: number; taxEtf: number; stop: number };
  rows: PickPerf[]; // 新到舊
}

/** 推薦列表與 CSV 的順序：新的日期在前；同一天依分數高到低（和選股頁「買入」名單同順序），同分維持原順序 */
export function sortPerfRows<T extends Pick<PickRec, "date" | "score">>(rows: T[]): T[] {
  return rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.date < b.r.date ? 1 : a.r.date > b.r.date ? -1 : b.r.score - a.r.score || a.i - b.i)).map((x) => x.r);
}

const pct = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? "" : (x * 100).toFixed(2));

/** CSV（Excel 可直接開：UTF-8 BOM、逗號分隔、文字有逗號就加引號） */
export function toCsv(f: PickPerfFile): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const [bA, bB] = (f.bench ?? ["加權", "0050"]).map((x) => q(x.replace(/指數$/, "")));
  const head = ["推薦日", "代號", "名稱", "市場", "推薦價", "停損價", "分數", "推薦理由", "資料日", "首次推薦", "已過交易日", "最新資料日", "至今報酬%", "至今淨報酬%"];
  for (const h of PICK_HORIZONS) head.push(`${h}日報酬%`, `${h}日淨報酬%`, `${h}日${bA}%`, `${h}日${bB}%`, `${h}日超額(${bA})%`, `${h}日超額(${bB})%`, `${h}日觸及停損`, `${h}日停損出場淨報酬%`);
  const lines = [head.join(",")];
  const first = firstPickIds(f.rows);
  for (const r of sortPerfRows(f.rows)) {
    const cells = [r.date, r.code, q(r.name), r.market === "TPEX" ? "上櫃" : r.market === "US" ? "美股" : "上市", String(r.price), String(r.stop), String(r.score), q(r.reasons.join("；")), r.dataDate, first.has(r.id) ? "是" : "否", String(r.elapsed), r.lastDate ?? "", pct(r.curRet), pct(r.curNet)];
    for (const h of PICK_HORIZONS) {
      const x = r.h[h];
      cells.push(pct(x?.ret), pct(x?.net), pct(x?.taiex), pct(x?.b0050), pct(x?.exTaiex), pct(x?.ex0050), x ? (x.stopHit ? "是" : "否") : "", pct(x?.stopNet));
    }
    lines.push(cells.join(","));
  }
  return "﻿" + lines.join("\n") + "\n";
}
