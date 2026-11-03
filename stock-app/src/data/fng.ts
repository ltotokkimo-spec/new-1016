// 虛擬幣恐懼貪婪指數（alternative.me 免費 API，每天更新一次）。0 = 極度恐懼、100 = 極度貪婪。
// 回應格式：{"name":"Fear and Greed Index","data":[{"value":"40","value_classification":"Fear","timestamp":"1551157200"}, ...]}，最新的在最前面。

export const FNG_URL = "https://api.alternative.me/fng/?limit=366"; // 一次抓近一年：卡片用最新幾天，詳情頁畫走勢

export interface Fng {
  value: number; // 今天
  label: string; // 中文分級
  date: string; // YYYYMMDD（UTC 日期）
  prev?: number; // 昨天
  weekAgo?: number; // 7 天前
  monthAgo?: number; // 30 天前
  // 詳情頁用（近一年）
  hist?: { date: string; value: number }[]; // 由舊到新
  high?: { value: number; date: string }; // 一年內最高
  low?: { value: number; date: string }; // 一年內最低
  streak?: number; // 連續幾天在目前這個分級（含今天）
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
  const date = ymd(ts);
  const cls = String(list[0]?.value_classification ?? "").toLowerCase();
  const label = LABEL[cls] ?? fngLabel(value);
  const hist = list
    .map((x: any) => ({ date: ymd(Number(x?.timestamp)), value: Number(x?.value) }))
    .filter((x: { date: string; value: number }) => x.date && Number.isFinite(x.value))
    .reverse();
  let high: Fng["high"], low: Fng["low"];
  for (const h of hist) {
    if (!high || h.value >= high.value) high = { value: h.value, date: h.date }; // 同分取最近一次
    if (!low || h.value <= low.value) low = { value: h.value, date: h.date };
  }
  let streak = 0;
  for (let i = hist.length - 1; i >= 0 && fngLabel(hist[i].value) === fngLabel(value); i--) streak++;
  return { value, label, date, prev: val(1), weekAgo: val(7), monthAgo: val(30), hist, high, low, streak: Math.max(1, streak) };
}

const ymd = (ts: number) => (Number.isFinite(ts) ? new Date(ts * 1000).toISOString().slice(0, 10).replace(/-/g, "") : "");
