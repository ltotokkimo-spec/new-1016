// 公司資料：證交所／櫃買 OpenAPI（一天抓一次整份清單）＋ Yahoo 股市公司資料頁（主要經營業務）。抓不到的部分略過。
import { fetchJson, fetchText } from "../lib/net";
import { taipeiToday } from "../lib/dates";
import { profileFromRow, rowCode, yahooProfile, type CompanyProfile } from "../engine/companyProfile";

const lists: Record<string, { day: string; rows: Record<string, unknown>[] } | undefined> = {};
async function listOf(market: "TWSE" | "TPEX") {
  const day = taipeiToday();
  if (lists[market]?.day === day) return lists[market]!.rows;
  const json = await fetchJson(market === "TPEX" ? "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O" : "https://openapi.twse.com.tw/v1/opendata/t187ap03_L");
  const rows = Array.isArray(json) ? json : [];
  if (rows.length) lists[market] = { day, rows };
  return rows;
}

export const yahooProfileUrl = (code: string, market: string) => `https://tw.stock.yahoo.com/quote/${code}.${market === "TPEX" ? "TWO" : "TW"}/profile`;

export async function loadProfile(code: string, market: "TWSE" | "TPEX"): Promise<{ p: CompanyProfile; errors: string[] }> {
  const errors: string[] = [];
  const [a, b] = await Promise.allSettled([listOf(market), fetchText(yahooProfileUrl(code, market))]);
  let p: CompanyProfile = {};
  if (a.status === "fulfilled") { const row = a.value.find((r) => rowCode(r) === code); if (row) p = profileFromRow(row); else errors.push("基本資料查無此公司"); }
  else errors.push(`基本資料：${String(a.reason?.message ?? a.reason).slice(0, 40)}`);
  if (b.status === "fulfilled") p = { ...p, ...Object.fromEntries(Object.entries(yahooProfile(b.value)).filter(([, v]) => v)) };
  else errors.push(`Yahoo：${String(b.reason?.message ?? b.reason).slice(0, 40)}`);
  return { p, errors };
}
