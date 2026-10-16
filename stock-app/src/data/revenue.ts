// 每月營收：證交所／櫃買中心 openapi（上市櫃公司每月營業收入彙總表），免費公開資料。
// 欄位名稱兩邊不完全一樣，用關鍵字找欄位，找不到就略過。
export interface Revenue { code: string; ym: string; revenue: number; mom: number; yoy: number; cumYoy: number }

export const revenueUrls = {
  twse: "https://openapi.twse.com.tw/v1/opendata/t187ap05_L",
  tpex: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O",
};

const n = (v: unknown) => {
  const x = Number(String(v ?? "").replace(/,/g, "").trim());
  return String(v ?? "").trim() === "" ? NaN : x;
};

function pick(row: Record<string, unknown>, ...must: string[][]): unknown {
  for (const words of must) {
    const k = Object.keys(row).find((key) => words.every((w) => key.includes(w)));
    if (k) return row[k];
  }
  return undefined;
}

/** 資料年月可能是民國 "11509" 或西元 "202609" */
function ymOf(v: unknown): string {
  const s = String(v ?? "").replace(/\D/g, "");
  if (s.length === 5) return `${Number(s.slice(0, 3)) + 1911}${s.slice(3)}`;
  if (s.length === 6) return s;
  return "";
}

export function parseRevenue(rows: unknown): Revenue[] {
  if (!Array.isArray(rows)) return [];
  const out: Revenue[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const code = String(pick(r, ["公司代號"], ["CompanyCode"], ["SecuritiesCompanyCode"]) ?? "").trim();
    const revenue = n(pick(r, ["當月營收"], ["MonthlyRevenue"], ["Revenue", "Current"]));
    if (!code || !Number.isFinite(revenue)) continue;
    out.push({
      code,
      ym: ymOf(pick(r, ["資料年月"], ["DataYearMonth"], ["YearMonth"])),
      revenue,
      mom: n(pick(r, ["上月比較增減"], ["上月", "增減"], ["LastMonth", "Percent"], ["MoM"])) / 100,
      yoy: n(pick(r, ["去年同月增減"], ["去年同月", "增減"], ["LastYear", "Percent"], ["YoY"])) / 100,
      cumYoy: n(pick(r, ["前期比較增減"], ["累計", "增減"], ["Accumulated", "Percent"])) / 100,
    });
  }
  return out;
}
