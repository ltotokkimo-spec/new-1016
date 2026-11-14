// 歷史月營收（公開資訊觀測站「上市／上櫃公司每月營業收入彙總表」t21sc03，每月一頁、全部公司）。
// 給「雙引擎」觀察組合的成長組用（使用者 11/14 同意上線）。純計算：下載與快取在 tools/backtest.ts。
// 時間規則：N 月營收在 N+1 月 10 日前公布，保守起見每月 11 日起才使用（避免回測偷看還沒公布的數字）。

/** [代號, 當月營收, 去年同月營收]（千元） */
export type RevEntry = [string, number, number];
export interface RevRow { rev: number; lastYear: number }
/** 西元 YYYYMM → 代號 → 營收 */
export type RevTable = Map<string, Map<string, RevRow>>;

/** 解析 t21sc03 的 HTML（已轉成字串）：每列是 代號、名稱、當月營收、上月營收、去年當月營收、… */
export function parseRevHtml(html: string): RevEntry[] {
  const out: RevEntry[] = [];
  for (const tr of html.split(/<tr/i)) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, "").replace(/[,\s]/g, ""));
    if (tds.length < 7 || !/^\d{4}$/.test(tds[0])) continue;
    const rev = Number(tds[2]), ly = Number(tds[4]);
    if (tds[2] !== "" && Number.isFinite(rev)) out.push([tds[0], rev, tds[4] !== "" && Number.isFinite(ly) ? ly : NaN]);
  }
  return out;
}

export function revTable(months: { ym: string; rows: RevEntry[] }[]): RevTable {
  const t: RevTable = new Map();
  for (const { ym, rows } of months) {
    const m = t.get(ym) ?? new Map<string, RevRow>();
    for (const [code, rev, lastYear] of rows) m.set(code, { rev, lastYear });
    t.set(ym, m);
  }
  return t;
}

export function prevYm(ym: string, k = 1): string {
  let y = Number(ym.slice(0, 4)), m = Number(ym.slice(4)) - k;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}${String(m).padStart(2, "0")}`;
}

/** 交易日 date（YYYYMMDD）當天已經可以用的最新營收月份：11 日起用上個月，10 日以前用上上個月 */
export function knownYm(date: string): string {
  return prevYm(date.slice(0, 6), Number(date.slice(6)) >= 11 ? 1 : 2);
}

export interface RevFactors {
  ym: string; // 用的是哪個月的營收
  yoy3: number; // 近 3 個月合計營收年增率
  newHigh: number; // 最新月營收是近 12 個月最高：1／不是：0（月數不足 6 個月：NaN）
}
/** 某檔股票在 date 那天已公布的營收指標；近 3 個月有缺就回傳 undefined */
export function revFactors(t: RevTable, code: string, date: string): RevFactors | undefined {
  const ym = knownYm(date);
  const get = (k: number) => t.get(prevYm(ym, k))?.get(code);
  const r = [get(0), get(1), get(2)];
  if (!r.every((x) => x && x.rev > 0 && x.lastYear > 0)) return undefined;
  const yoy3 = (r[0]!.rev + r[1]!.rev + r[2]!.rev) / (r[0]!.lastYear + r[1]!.lastYear + r[2]!.lastYear) - 1;
  let hi = 0, n = 0;
  for (let k = 1; k < 12; k++) { const x = get(k); if (x && x.rev > 0) { hi = Math.max(hi, x.rev); n++; } }
  return { ym, yoy3, newHigh: n >= 6 ? (r[0]!.rev > hi ? 1 : 0) : NaN };
}
