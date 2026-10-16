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
    if (!isCommonStock(code)) continue;
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
    if (!isCommonStock(code)) continue;
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
    if (!isCommonStock(code)) continue;
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
    if (!isCommonStock(code)) continue;
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
};
