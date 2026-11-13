// 個股頁「公司」分頁（11/13 使用者：做什麼產品、規模等）：
// - 證交所／櫃買 OpenAPI 公司基本資料（董事長、成立、上市、資本額、網址…），欄位名稱用關鍵字找（上市中文、上櫃英文）
// - Yahoo 股市公司資料頁的「主要經營業務」等（網頁文字：標題後面接內容）
export interface CompanyProfile {
  fullName?: string; chairman?: string; ceo?: string; founded?: string; listed?: string;
  capital?: number; // 實收資本額（元）
  website?: string; address?: string; phone?: string;
  business?: string; revenueMix?: string; employees?: string; // Yahoo
}

const pick = (row: Record<string, unknown>, re: RegExp, not?: RegExp) => {
  const k = Object.keys(row).find((key) => re.test(key) && !(not && not.test(key)));
  const v = k ? String(row[k] ?? "").trim() : "";
  return v && v !== "-" ? v : undefined;
};

/** 民國或西元日期（1150101、115/01/01、20260101）→ 2026/01/01 */
export function fmtDate(s?: string): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s/g, "");
  const m = /^(\d{2,4})[\/\-.]?(\d{2})[\/\-.]?(\d{2})$/.exec(t);
  if (!m) return s;
  let y = +m[1];
  if (y < 1911) y += 1911;
  return `${y}/${m[2]}/${m[3]}`;
}

export function profileFromRow(row: Record<string, unknown>): CompanyProfile {
  const cap = Number(String(pick(row, /實收資本|paid.?in.?capital/i) ?? "").replace(/,/g, ""));
  return {
    fullName: pick(row, /^(公司名稱|CompanyName)$/i),
    chairman: pick(row, /董事長|Chairman/i),
    ceo: pick(row, /總經理|GeneralManager/i),
    founded: fmtDate(pick(row, /成立日期|DateOfIncorporation|Incorporation/i)),
    listed: fmtDate(pick(row, /上市日期|上櫃日期|DateOfListing|Listing/i)),
    capital: cap > 0 ? cap : undefined,
    website: pick(row, /網址|WebAddress|Website/i),
    address: pick(row, /^(住址|地址|Address)$/i, /英文|English/i),
    phone: pick(row, /總機電話|Telephone|Phone/i),
  };
}

export const rowCode = (row: Record<string, unknown>) => String(row["公司代號"] ?? row["SecuritiesCompanyCode"] ?? "").trim();

const LABELS: [keyof CompanyProfile, RegExp][] = [
  ["business", /^主要經營業務$/],
  ["revenueMix", /^營收比重$/],
  ["employees", /^員工人數$/],
];

/** Yahoo 股市公司資料頁：網頁轉成一行一段文字，標題（主要經營業務…）的下一段就是內容 */
export function yahooProfile(html: string): Partial<CompanyProfile> {
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: Partial<CompanyProfile> = {};
  for (const [key, re] of LABELS) {
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0 && lines[i + 1] && !LABELS.some(([, r]) => r.test(lines[i + 1]))) (out as any)[key] = lines[i + 1].slice(0, 400);
  }
  // 網頁改版、內容放在 JSON 裡時的備援
  if (!out.business) { const m = /"mainBusiness"\s*:\s*"([^"]{4,600})"/.exec(html); if (m) out.business = m[1]; }
  return out;
}
