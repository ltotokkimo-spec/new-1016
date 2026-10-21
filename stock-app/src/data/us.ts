// 美股（Nasdaq 官方 API）與國際指標（CNBC 報價）。格式依 2026/10 實際回應撰寫。
import { num } from "./tw";

export interface Bar {
  date: string; // YYYYMMDD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** "10/15/2026" → "20261015" */
function usDate(s: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}${m[1].padStart(2, "0")}${m[2].padStart(2, "0")}` : "";
}

const money = (s: unknown) => num(typeof s === "string" ? s.replace("$", "") : s);

/** Nasdaq historical → 由舊到新的日K */
export function parseNasdaqHistory(json: any): Bar[] {
  const rows = json?.data?.tradesTable?.rows;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r: any) => ({
      date: usDate(String(r.date ?? "")),
      open: money(r.open), high: money(r.high), low: money(r.low), close: money(r.close), volume: num(r.volume),
    }))
    .filter((b: Bar) => b.date && Number.isFinite(b.close))
    .sort((a: Bar, b: Bar) => a.date.localeCompare(b.date));
}

export function nasdaqUrl(symbol: string, assetclass: "stocks" | "etf", from: string, to: string) {
  // Nasdaq 的代號用「.」（BRK.B）；from/to 為 YYYY-MM-DD
  return `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=${assetclass}&fromdate=${from}&limit=400&todate=${to}`;
}

// ---------- 使用者自己加的美股（不在預設清單裡的代號） ----------
export interface UsExtra { symbol: string; name: string; sector: string; etf: boolean }

export const nasdaqInfoUrl = (symbol: string, assetclass: "stocks" | "etf") =>
  `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=${assetclass}`;
export const nasdaqSummaryUrl = (symbol: string, assetclass: "stocks" | "etf") =>
  `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/summary?assetclass=${assetclass}`;

/** Nasdaq info → 公司名稱（去掉 "Common Stock" 之類的字） */
export function parseNasdaqName(json: any): string {
  const n = String(json?.data?.companyName ?? "").trim();
  return n.replace(/\s+(Common Stock|Common Shares|Ordinary Shares|American Depositary Shares).*$/i, "").replace(/,?\s+(Inc\.?|Corp\.?|Corporation|Ltd\.?|plc)$/i, "").trim();
}

const NASDAQ_SECTOR: Record<string, string> = {
  technology: "科技", telecommunications: "通訊服務", "consumer discretionary": "非必需消費", "consumer staples": "必需消費",
  energy: "能源", finance: "金融", "health care": "醫療保健", industrials: "工業", "basic materials": "原物料",
  utilities: "公用事業", "real estate": "房地產",
};

/** Nasdaq summary → 對應到 App 的產業名稱；查不到就歸「自選」 */
export function parseNasdaqSector(json: any): string {
  const v = json?.data?.summaryData?.Sector?.value ?? json?.data?.summaryData?.sector?.value;
  return NASDAQ_SECTOR[String(v ?? "").trim().toLowerCase()] ?? "自選";
}

export const isUsSymbol = (s: string) => /^[A-Z][A-Z.\-]{0,6}$/.test(s);

export interface MacroQuote {
  symbol: string;
  name: string;
  last: number;
  change: number;
  changePct: number;
  time: string;
}

/** CNBC restQuote → 指標報價 */
export function parseCnbcQuotes(json: any): MacroQuote[] {
  let list = json?.FormattedQuoteResult?.FormattedQuote;
  if (!list) return [];
  if (!Array.isArray(list)) list = [list];
  return list
    .filter((q: any) => q && q.code === 0 && q.last !== undefined)
    .map((q: any) => ({
      symbol: String(q.symbol),
      name: String(q.name ?? q.shortName ?? q.symbol),
      last: num(String(q.last).replace("%", "")),
      change: num(String(q.change ?? "").replace("%", "")),
      changePct: num(String(q.change_pct ?? "").replace("%", "")),
      time: String(q.last_time ?? q.last_timedate ?? ""),
    }))
    .filter((q: MacroQuote) => Number.isFinite(q.last));
}

export const MACRO_SYMBOLS: { symbol: string; label: string; group: "美股" | "利率匯率" | "原物料" | "亞洲" }[] = [
  { symbol: ".SPX", label: "S&P 500", group: "美股" },
  { symbol: ".IXIC", label: "那斯達克", group: "美股" },
  { symbol: ".SOX", label: "費城半導體", group: "美股" },
  { symbol: ".DJI", label: "道瓊", group: "美股" },
  { symbol: ".VIX", label: "VIX 恐慌指數", group: "美股" },
  { symbol: "US10Y", label: "美債 10 年殖利率", group: "利率匯率" },
  { symbol: "US2Y", label: "美債 2 年殖利率", group: "利率匯率" },
  { symbol: ".DXY", label: "美元指數", group: "利率匯率" },
  { symbol: "TWD=", label: "美元兌台幣", group: "利率匯率" },
  { symbol: "JPY=", label: "美元兌日圓", group: "利率匯率" },
  { symbol: "@CL.1", label: "WTI 原油", group: "原物料" },
  { symbol: "@GC.1", label: "黃金", group: "原物料" },
  { symbol: ".N225", label: "日經 225", group: "亞洲" },
  { symbol: ".KS11", label: "韓國 KOSPI", group: "亞洲" },
];

export const cnbcUrl = (symbols: string[]) =>
  `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(symbols.join("|"))}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`;

// ---------- 美股選股範圍：大型股＋產業 ETF ----------
export const US_SECTOR_ETF: Record<string, string> = {
  科技: "XLK", 通訊服務: "XLC", 非必需消費: "XLY", 必需消費: "XLP", 能源: "XLE", 金融: "XLF",
  醫療保健: "XLV", 工業: "XLI", 原物料: "XLB", 公用事業: "XLU", 房地產: "XLRE",
};

export const US_UNIVERSE: { symbol: string; name: string; sector: string }[] = [
  { symbol: "AAPL", name: "蘋果", sector: "科技" }, { symbol: "MSFT", name: "微軟", sector: "科技" },
  { symbol: "NVDA", name: "輝達", sector: "科技" }, { symbol: "AVGO", name: "博通", sector: "科技" },
  { symbol: "AMD", name: "超微", sector: "科技" }, { symbol: "TSM", name: "台積電ADR", sector: "科技" },
  { symbol: "ORCL", name: "甲骨文", sector: "科技" }, { symbol: "CRM", name: "Salesforce", sector: "科技" },
  { symbol: "ADBE", name: "Adobe", sector: "科技" }, { symbol: "QCOM", name: "高通", sector: "科技" },
  { symbol: "MU", name: "美光", sector: "科技" }, { symbol: "INTC", name: "英特爾", sector: "科技" },
  { symbol: "ASML", name: "艾司摩爾", sector: "科技" }, { symbol: "ARM", name: "安謀", sector: "科技" },
  { symbol: "PLTR", name: "Palantir", sector: "科技" }, { symbol: "ANET", name: "Arista", sector: "科技" },
  { symbol: "NOW", name: "ServiceNow", sector: "科技" }, { symbol: "SMCI", name: "美超微", sector: "科技" },
  { symbol: "GOOGL", name: "Alphabet", sector: "通訊服務" }, { symbol: "META", name: "Meta", sector: "通訊服務" },
  { symbol: "NFLX", name: "Netflix", sector: "通訊服務" }, { symbol: "DIS", name: "迪士尼", sector: "通訊服務" },
  { symbol: "AMZN", name: "亞馬遜", sector: "非必需消費" }, { symbol: "TSLA", name: "特斯拉", sector: "非必需消費" },
  { symbol: "HD", name: "家得寶", sector: "非必需消費" }, { symbol: "NKE", name: "Nike", sector: "非必需消費" },
  { symbol: "MCD", name: "麥當勞", sector: "非必需消費" }, { symbol: "UBER", name: "Uber", sector: "工業" },
  { symbol: "COST", name: "好市多", sector: "必需消費" }, { symbol: "WMT", name: "沃爾瑪", sector: "必需消費" },
  { symbol: "PG", name: "寶僑", sector: "必需消費" }, { symbol: "KO", name: "可口可樂", sector: "必需消費" },
  { symbol: "PEP", name: "百事", sector: "必需消費" },
  { symbol: "XOM", name: "埃克森美孚", sector: "能源" }, { symbol: "CVX", name: "雪佛龍", sector: "能源" },
  { symbol: "JPM", name: "摩根大通", sector: "金融" }, { symbol: "BAC", name: "美國銀行", sector: "金融" },
  { symbol: "GS", name: "高盛", sector: "金融" }, { symbol: "MS", name: "摩根士丹利", sector: "金融" },
  { symbol: "V", name: "Visa", sector: "金融" }, { symbol: "MA", name: "萬事達", sector: "金融" },
  { symbol: "BRK.B", name: "波克夏", sector: "金融" },
  { symbol: "LLY", name: "禮來", sector: "醫療保健" }, { symbol: "UNH", name: "聯合健康", sector: "醫療保健" },
  { symbol: "JNJ", name: "嬌生", sector: "醫療保健" }, { symbol: "ABBV", name: "艾伯維", sector: "醫療保健" },
  { symbol: "MRK", name: "默克", sector: "醫療保健" }, { symbol: "PFE", name: "輝瑞", sector: "醫療保健" },
  { symbol: "CAT", name: "開拓重工", sector: "工業" }, { symbol: "GE", name: "奇異航太", sector: "工業" },
  { symbol: "BA", name: "波音", sector: "工業" }, { symbol: "LIN", name: "林德", sector: "原物料" },
  { symbol: "NEE", name: "新紀元能源", sector: "公用事業" }, { symbol: "PLD", name: "安博", sector: "房地產" },
];

// ---------- 由日K算指標 ----------
export function sma(bars: Bar[], n: number, endIdx = bars.length - 1): number {
  if (endIdx + 1 < n) return NaN;
  let s = 0;
  for (let i = endIdx - n + 1; i <= endIdx; i++) s += bars[i].close;
  return s / n;
}

/** 往回 n 個交易日的報酬（小數） */
export function retN(bars: Bar[], n: number): number {
  const last = bars.length - 1;
  if (last - n < 0) return NaN;
  return bars[last].close / bars[last - n].close - 1;
}

export function rsi(bars: Bar[], n = 14): number {
  if (bars.length <= n) return NaN;
  let gain = 0, loss = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    if (d > 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}
