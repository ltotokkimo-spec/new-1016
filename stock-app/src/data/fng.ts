// 虛擬幣恐懼貪婪指數（alternative.me 免費 API，每天更新一次）。0 = 極度恐懼、100 = 極度貪婪。
// 回應格式：{"name":"Fear and Greed Index","data":[{"value":"40","value_classification":"Fear","timestamp":"1551157200"}, ...]}，最新的在最前面。

export const FNG_URL = "https://api.alternative.me/fng/?limit=31";

export interface Fng {
  value: number; // 今天
  label: string; // 中文分級
  date: string; // YYYYMMDD（UTC 日期）
  prev?: number; // 昨天
  weekAgo?: number; // 7 天前
  monthAgo?: number; // 30 天前
}

const LABEL: Record<string, string> = { "extreme fear": "極度恐懼", fear: "恐懼", neutral: "中立", greed: "貪婪", "extreme greed": "極度貪婪" };

/** 分數 → 中文分級（API 沒給分級時用；切點和 alternative.me 一樣） */
export function fngLabel(v: number): string {
  return v <= 24 ? "極度恐懼" : v <= 44 ? "恐懼" : v <= 55 ? "中立" : v <= 75 ? "貪婪" : "極度貪婪";
}

export function parseFng(json: any): Fng | undefined {
  const list = json?.data;
  if (!Array.isArray(list) || !list.length) return undefined;
  const val = (i: number) => { const x = Number(list[i]?.value); return Number.isFinite(x) ? x : undefined; };
  const value = val(0);
  if (value === undefined) return undefined;
  const ts = Number(list[0]?.timestamp);
  const date = Number.isFinite(ts) ? new Date(ts * 1000).toISOString().slice(0, 10).replace(/-/g, "") : "";
  const cls = String(list[0]?.value_classification ?? "").toLowerCase();
  return { value, label: LABEL[cls] ?? fngLabel(value), date, prev: val(1), weekAgo: val(7), monthAgo: val(30) };
}
