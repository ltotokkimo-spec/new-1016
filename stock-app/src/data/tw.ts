// 台股資料：證交所（上市）與櫃買中心（上櫃）的每日行情、三大法人買賣超、產業別。
// 格式依 2026/10 實際回應撰寫，測試用的樣本在 test/fixtures。

export type TwMarket = "TWSE" | "TPEX";

export interface Quote {
  code: string;
  name: string;
  market: TwMarket;
  close: number;
  change: number; // 漲跌（元）
  open: number;
  high: number;
  low: number;
  volume: number; // 成交股數
  value: number; // 成交金額（元）
}

export interface Flow {
  code: string;
  foreign: number; // 外資及陸資（不含外資自營商）買賣超股數
  trust: number; // 投信買賣超股數
  dealer: number; // 自營商買賣超股數
  total: number; // 三大法人合計
}

export interface MarketIndex {
  name: string;
  close: number;
  change: number;
  changePct: number;
}

/** "1,234.50" → 1234.5；"--"、"---"、空字串 → NaN */
export function num(s: unknown): number {
  if (typeof s === "number") return s;
  if (typeof s !== "string") return NaN;
  const t = s.replace(/<[^>]*>/g, "").replace(/,/g, "").trim();
  if (!t || /^-+$/.test(t) || t === "除權息" || t === "除息" || t === "除權") return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/** 一般股票：4 碼數字、不是 0 開頭（排除 ETF 0050、00632R 等）。 */
export function isCommonStock(code: string): boolean {
  return /^[1-9]\d{3}$/.test(code.trim());
}

/** ETF：00 開頭 4~6 碼，可帶一個英文字母（0050、00632R、00406A、006208）。 */
export function isEtf(code: string): boolean {
  return /^00\d{2,4}[A-Z]?$/.test(code.trim());
}

/** 行情與法人資料要保留的代號：一般股票＋ETF（排除權證、ETN 等） */
export function isTradable(code: string): boolean {
  return isCommonStock(code) || isEtf(code);
}

/** 依 ETF 名稱分類，當作 ETF 的「族群」 */
export function etfCategory(name: string): string {
  const n = name.replace(/\s/g, "");
  if (/正2|反1|反向|槓桿|2X|-1/i.test(n)) return "槓桿反向";
  if (/債|公司債|美債|投等|Bond/i.test(n)) return "債券";
  if (/^主動/.test(n)) return "主動式";
  if (/高息|高股息|股息|收益|息收|優息|月配|季配/.test(n)) return "高股息";
  if (/美國|美股|日本|日經|中國|上証|滬深|印度|越南|全球|NASDAQ|那斯達克|S&P|標普|費城|歐洲|韓國|新興|亞洲/i.test(n)) return "海外";
  if (/半導體|科技|電子|AI|5G|網通|IC|晶片|雲端|電動車|機器人|資安/i.test(n)) return "科技主題";
  if (/台灣50|臺灣50|台50|中型100|市值|MSCI|富時|加權|台灣領袖|寶島/i.test(n)) return "市值型";
  return "其他ETF";
}

const TWSE_SIGN = /color:\s*(green|red)/i;

function twseSignedChange(signCell: string, diff: string): number {
  const d = num(diff);
  if (!Number.isFinite(d)) return NaN;
  const m = TWSE_SIGN.exec(signCell || "");
  if (m) return m[1].toLowerCase() === "green" ? -d : d;
  const plain = (signCell || "").replace(/<[^>]*>/g, "").trim();
  return plain === "-" ? -d : d;
}

/** 證交所 MI_INDEX（type=ALLBUT0999）→ 個股行情；沒有資料（休市）回傳 null */
export function parseTwseQuotes(json: any): { date: string; quotes: Quote[]; indices: MarketIndex[] } | null {
  if (!json || json.stat !== "OK" || !Array.isArray(json.tables)) return null;
  const table = json.tables.find((t: any) => Array.isArray(t?.fields) && t.fields.includes("證券代號") && t.fields.includes("收盤價"));
  if (!table) return null;
  const f = (name: string) => table.fields.indexOf(name);
  const iCode = f("證券代號"), iName = f("證券名稱"), iVol = f("成交股數"), iVal = f("成交金額");
  const iOpen = f("開盤價"), iHigh = f("最高價"), iLow = f("最低價"), iClose = f("收盤價");
  const iSign = f("漲跌(+/-)"), iDiff = f("漲跌價差");
  const quotes: Quote[] = [];
  for (const r of table.data || []) {
    const code = String(r[iCode]).trim();
    if (!isTradable(code)) continue;
    const close = num(r[iClose]);
    if (!Number.isFinite(close)) continue; // 當日無成交
    quotes.push({
      code, name: String(r[iName]).trim(), market: "TWSE", close,
      change: twseSignedChange(r[iSign], r[iDiff]),
      open: num(r[iOpen]), high: num(r[iHigh]), low: num(r[iLow]),
      volume: num(r[iVol]), value: num(r[iVal]),
    });
  }
  const indices: MarketIndex[] = [];
  const idxTable = json.tables[0];
  if (idxTable?.fields?.[0] === "指數") {
    for (const r of idxTable.data || []) {
      const name = String(r[0]).trim();
      if (name !== "發行量加權股價指數" && name !== "臺灣50指數" && name !== "電子類指數" && name !== "金融保險類指數" && name !== "半導體類指數") continue;
      const pts = num(r[3]);
      const sign = /green/i.test(r[2]) || String(r[2]).replace(/<[^>]*>/g, "").trim() === "-" ? -1 : 1;
      indices.push({ name, close: num(r[1]), change: sign * pts, changePct: num(r[4]) });
    }
  }
  return { date: String(json.date || ""), quotes, indices };
}

/** 證交所 T86 三大法人買賣超日報 */
export function parseTwseFlows(json: any): Flow[] | null {
  if (!json || json.stat !== "OK" || !Array.isArray(json.fields)) return null;
  const f = (name: string) => json.fields.indexOf(name);
  const iCode = f("證券代號");
  const iForeign = f("外陸資買賣超股數(不含外資自營商)");
  const iTrust = f("投信買賣超股數");
  const iDealer = f("自營商買賣超股數");
  const iTotal = f("三大法人買賣超股數");
  if ([iCode, iForeign, iTrust, iDealer, iTotal].some((i) => i < 0)) return null;
  const out: Flow[] = [];
  for (const r of json.data || []) {
    const code = String(r[iCode]).trim();
    if (!isTradable(code)) continue;
    out.push({ code, foreign: num(r[iForeign]), trust: num(r[iTrust]), dealer: num(r[iDealer]), total: num(r[iTotal]) });
  }
  return out;
}

/** 櫃買中心 dailyQuotes（新版網站）→ 個股行情 */
export function parseTpexQuotes(json: any): { date: string; quotes: Quote[] } | null {
  const table = json?.tables?.[0];
  if (!table || !Array.isArray(table.fields) || !Array.isArray(table.data) || table.data.length === 0) return null;
  const f = (name: string) => table.fields.indexOf(name);
  const iCode = f("代號"), iName = f("名稱"), iClose = f("收盤"), iChg = f("漲跌");
  const iOpen = f("開盤"), iHigh = f("最高"), iLow = f("最低"), iVol = f("成交股數"), iVal = f("成交金額(元)");
  if ([iCode, iClose, iChg, iVol, iVal].some((i) => i < 0)) return null;
  const quotes: Quote[] = [];
  for (const r of table.data) {
    const code = String(r[iCode]).trim();
    if (!isTradable(code)) continue;
    const close = num(r[iClose]);
    if (!Number.isFinite(close)) continue;
    quotes.push({
      code, name: String(r[iName]).trim(), market: "TPEX", close,
      change: num(r[iChg]), open: num(r[iOpen]), high: num(r[iHigh]), low: num(r[iLow]),
      volume: num(r[iVol]), value: num(r[iVal]),
    });
  }
  return { date: String(json.date || ""), quotes };
}

/**
 * 櫃買中心三大法人明細。欄位名稱重複，依位置分組：
 * [2-4] 外資及陸資(不含外資自營商) 買/賣/超、[5-7] 外資自營商、[8-10] 外資合計、
 * [11-13] 投信、[14-16] 自營商(自行)、[17-19] 自營商(避險)、[20-22] 自營商合計、[23] 三大法人合計
 */
export function parseTpexFlows(json: any): Flow[] | null {
  const table = json?.tables?.[0];
  if (!table || !Array.isArray(table.data) || table.data.length === 0) return null;
  if (!Array.isArray(table.fields) || table.fields.length < 24 || table.fields[0] !== "代號") return null;
  const out: Flow[] = [];
  for (const r of table.data) {
    const code = String(r[0]).trim();
    if (!isTradable(code)) continue;
    out.push({ code, foreign: num(r[4]), trust: num(r[13]), dealer: num(r[22]), total: num(r[23]) });
  }
  return out;
}

export const INDUSTRY_NAMES: Record<string, string> = {
  "01": "水泥", "02": "食品", "03": "塑膠", "04": "紡織纖維", "05": "電機機械", "06": "電器電纜",
  "08": "玻璃陶瓷", "09": "造紙", "10": "鋼鐵", "11": "橡膠", "12": "汽車", "14": "建材營造",
  "15": "航運", "16": "觀光餐旅", "17": "金融保險", "18": "貿易百貨", "19": "綜合", "20": "其他",
  "21": "化學", "22": "生技醫療", "23": "油電燃氣", "24": "半導體", "25": "電腦週邊", "26": "光電",
  "27": "通信網路", "28": "電子零組件", "29": "電子通路", "30": "資訊服務", "31": "其他電子",
  "32": "文化創意", "33": "農業科技", "34": "電子商務", "35": "綠能環保", "36": "數位雲端",
  "37": "運動休閒", "38": "居家生活", "91": "存託憑證",
};

export interface Company {
  code: string;
  name: string;
  industry: string; // 產業名稱
}

/** 證交所 t187ap03_L 上市公司基本資料 */
export function parseTwseCompanies(json: any): Company[] {
  if (!Array.isArray(json)) return [];
  return json
    .filter((x) => x && isCommonStock(String(x["公司代號"] ?? "")))
    .map((x) => ({
      code: String(x["公司代號"]).trim(),
      name: String(x["公司簡稱"] ?? "").trim(),
      industry: INDUSTRY_NAMES[String(x["產業別"]).trim()] ?? "其他",
    }));
}

/** 櫃買中心 mopsfin_t187ap03_O 上櫃公司基本資料 */
export function parseTpexCompanies(json: any): Company[] {
  if (!Array.isArray(json)) return [];
  return json
    .filter((x) => x && isCommonStock(String(x.SecuritiesCompanyCode ?? "")))
    .map((x) => ({
      code: String(x.SecuritiesCompanyCode).trim(),
      name: String(x.CompanyAbbreviation ?? "").trim(),
      industry: INDUSTRY_NAMES[String(x.SecuritiesIndustryCode).trim()] ?? "其他",
    }));
}

// ---------- 網址 ----------
const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const slash = (d: Date) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;

export const twUrls = {
  twseQuotes: (d: Date) => `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd(d)}&type=ALLBUT0999&response=json`,
  twseFlows: (d: Date) => `https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd(d)}&selectType=ALLBUT0999&response=json`,
  tpexQuotes: (d: Date) => `https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${encodeURIComponent(slash(d))}&id=&response=json`,
  tpexFlows: (d: Date) => `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${encodeURIComponent(slash(d))}&response=json`,
  twseCompanies: () => "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
  tpexCompanies: () => "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
  esbLatest: () => "https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics",
};

/** "1151016"（民國年月日）→ "20261016" */
const esbDate = (s: string) => (/^\d{7}$/.test(s) ? `${Number(s.slice(0, 3)) + 1911}${s.slice(3)}` : "");

// ---------- 興櫃（沒有三大法人資料，只取報價算損益） ----------
export interface EsbQuote { code: string; name: string; close: number; date: string }

/** 櫃買中心 openapi 興櫃最新統計：最後成交價，沒有成交時用當日均價、再沒有用前日均價 */
export function parseEsbLatest(rows: any): EsbQuote[] {
  if (!Array.isArray(rows)) return [];
  const out: EsbQuote[] = [];
  for (const r of rows) {
    const code = String(r?.SecuritiesCompanyCode ?? "").trim();
    if (!code) continue;
    const close = [r.LatestPrice, r.Average, r.PreviousAveragePrice].map(num).find((x) => Number.isFinite(x) && x > 0);
    if (close === undefined) continue;
    out.push({ code, name: String(r.CompanyName ?? code).trim(), close, date: esbDate(String(r.Date ?? "")) });
  }
  return out;
}

// ---------- 個股歷史（月資料） ----------
export interface DayBar {
  date: string; // YYYYMMDD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // 股
}

/** 民國 "115/09/01" → "20260901" */
export function rocToYmd(s: string): string {
  const m = /^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/.exec(String(s).trim());
  return m ? `${Number(m[1]) + 1911}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}` : "";
}

/** 證交所 STOCK_DAY：fields 日期/成交股數/成交金額/開盤價/最高價/最低價/收盤價/漲跌價差/成交筆數 */
export function parseTwseStockDay(json: any): DayBar[] {
  if (!json || json.stat !== "OK" || !Array.isArray(json.data)) return [];
  const f = (n: string) => json.fields.indexOf(n);
  const iD = f("日期"), iV = f("成交股數"), iO = f("開盤價"), iH = f("最高價"), iL = f("最低價"), iC = f("收盤價");
  return json.data
    .map((r: any[]) => ({ date: rocToYmd(r[iD]), open: num(r[iO]), high: num(r[iH]), low: num(r[iL]), close: num(r[iC]), volume: num(r[iV]) }))
    .filter((b: DayBar) => b.date && Number.isFinite(b.close));
}

/** 櫃買 tradingStock：日期/成交仟股/成交仟元/開盤/最高/最低/收盤/漲跌/筆數 */
export function parseTpexStockHist(json: any): DayBar[] {
  const rows = json?.tables?.[0]?.data;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r: any[]) => ({ date: rocToYmd(r[0]), open: num(r[3]), high: num(r[4]), low: num(r[5]), close: num(r[6]), volume: num(r[1]) * 1000 }))
    .filter((b: DayBar) => b.date && Number.isFinite(b.close));
}

export const twHistUrls = {
  twse: (code: string, yyyymm01: string) => `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${yyyymm01}&stockNo=${code}&response=json`,
  tpex: (code: string, yyyymm01: string) =>
    `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${encodeURIComponent(`${yyyymm01.slice(0, 4)}/${yyyymm01.slice(4, 6)}/01`)}&id=&response=json`,
};
