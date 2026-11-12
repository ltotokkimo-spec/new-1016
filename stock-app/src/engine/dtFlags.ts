// 當沖排行的標示（11/12 使用者）：處置股（不能當沖）、不可現股當沖、暫停先賣後買。
// 各來源格式不一（OpenAPI 物件陣列、證交所 tables/fields/data），用欄位名稱和內容認出代號、期間、註記。
export interface DtFlag { disposal?: { period: string; reason?: string }; noDayTrade?: boolean; noSellFirst?: boolean }
export interface DtLists { disposal: Map<string, { period: string; reason?: string }>; eligible: { TWSE?: Map<string, boolean>; TPEX?: Map<string, boolean> } }

const CODE = /^\d{4,6}[A-Z]?$/;
type Row = Record<string, unknown>;

/** 不管是物件陣列、{data: [...]}、{fields, data} 或 {tables: [{fields, data}]}，都轉成「欄名→值」的物件陣列 */
export function rowsOf(json: any): Row[] {
  if (!json) return [];
  if (Array.isArray(json)) return json.length && Array.isArray(json[0]) ? [] : json.filter((x) => x && typeof x === "object");
  const tables: any[] = Array.isArray(json.tables) ? json.tables : [json];
  const out: Row[] = [];
  for (const t of tables) {
    if (Array.isArray(t?.fields) && Array.isArray(t?.data)) {
      for (const r of t.data) if (Array.isArray(r)) out.push(Object.fromEntries(t.fields.map((f: string, i: number) => [String(f), r[i]])));
    } else if (Array.isArray(t?.data)) {
      out.push(...rowsOf(t.data));
    } else if (Array.isArray(t?.aaData)) {
      out.push(...rowsOf(t.aaData));
    }
  }
  return out;
}

const codeOf = (r: Row): string | undefined => {
  const ks = Object.keys(r);
  const k = ks.find((k) => /(證券代號|股票代號|有價證券代號|代號|^Code$|SecuritiesCompanyCode|StockNo|Symbol)/i.test(k) && CODE.test(String(r[k] ?? "").trim()));
  if (k) return String(r[k]).trim();
  const v = Object.values(r).map((x) => String(x ?? "").trim()).find((x) => CODE.test(x));
  return v;
};

/** 民國或西元日期 → YYYYMMDD（115/11/12、1151112、2026-11-12、20261112） */
export function toYmd(s: string): string | undefined {
  const t = s.trim();
  const c = /^(\d{3,4})(\d\d)(\d\d)$/.exec(t);
  const m = c ?? /^(\d{3,4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/.exec(t);
  if (!m) return undefined;
  let y = +m[1];
  if (y < 1911) y += 1911;
  return `${y}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}`;
}

const DATE = String.raw`(?:\d{3,4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}|\d{7,8})`;
/** 處置期間「115/11/12～115/11/25」「1151112~1151118」→ [起, 迄] */
export function periodOf(s: string): [string, string] | undefined {
  const m = new RegExp(`(${DATE})\\s*[~～至\\-－]+\\s*(${DATE})`).exec(s);
  if (!m) return undefined;
  const a = toYmd(m[1]), b = toYmd(m[2]);
  return a && b ? [a, b] : undefined;
}

/** 處置股名單：只留今天在處置期間內的（沒寫期間的視為仍在處置）；權證、可轉債（5～6 位數代號）略過 */
export function parseDisposal(json: any, today: string): Map<string, { period: string; reason?: string }> {
  const out = new Map<string, { period: string; reason?: string }>();
  for (const r of rowsOf(json)) {
    const code = codeOf(r);
    if (!code || !/^\d{4}[A-Z]?$/.test(code)) continue;
    const vals = Object.entries(r).map(([k, v]) => [k, String(v ?? "")] as const);
    const pk = vals.find(([k, v]) => /(處置期間|DispositionPeriod|Period)/i.test(k) || periodOf(v));
    const p = pk ? periodOf(pk[1]) : undefined;
    if (p && (today < p[0] || today > p[1])) continue;
    const reason = vals.find(([k]) => /(處置條件|處置原因|Reason)/i.test(k))?.[1]?.trim();
    out.set(code, { period: p ? `${+p[0].slice(4, 6)}/${+p[0].slice(6)}～${+p[1].slice(4, 6)}/${+p[1].slice(6)}` : "", reason: reason || undefined });
  }
  return out;
}

/** 可現股當沖標的清單：代號→是否「暫停先賣後買」；清單太短（抓錯表）回 undefined，不拿來判斷 */
export function parseEligible(json: any): Map<string, boolean> | undefined {
  const out = new Map<string, boolean>();
  for (const r of rowsOf(json)) {
    const code = codeOf(r);
    if (!code) continue;
    const mk = Object.keys(r).find((k) => /(暫停|註記|Suspen)/i.test(k));
    const v = mk ? String(r[mk] ?? "").trim() : "";
    out.set(code, !!v && !/^(-|N|否|無|0)$/i.test(v));
  }
  return out.size >= 200 ? out : undefined;
}

/** 一檔的標示；eligible 沒抓到的市場不判斷「不可當沖」 */
export function flagOf(code: string, market: string | undefined, lists: DtLists | undefined): DtFlag {
  if (!lists) return {};
  const f: DtFlag = {};
  const d = lists.disposal.get(code);
  if (d) f.disposal = d;
  const el = market === "TPEX" ? lists.eligible.TPEX : market === "TWSE" ? lists.eligible.TWSE : undefined;
  if (el) { if (!el.has(code)) f.noDayTrade = true; else if (el.get(code)) f.noSellFirst = true; }
  return f;
}
