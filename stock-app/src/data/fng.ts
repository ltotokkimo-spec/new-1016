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
  yearAgo?: number; // 一年前（美股 CNN 才有）
  parts?: { key: string; label: string; score: number; rating: string }[]; // 美股 CNN 的 7 項成分指標
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

// ---------- 美股恐懼貪婪指數（CNN Business，11/16 使用者要求） ----------
// 回應：{ fear_and_greed: { score, rating, timestamp, previous_close, previous_1_week, previous_1_month, previous_1_year },
//         fear_and_greed_historical: { data: [{ x: 毫秒, y: 分數, rating }] }, market_momentum_sp500: { score, rating }, ... }
export const CNN_FNG_BASE = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
export const cnnFngUrl = (now = Date.now()) => `${CNN_FNG_BASE}/${new Date(now - 370 * 86400_000).toISOString().slice(0, 10)}`;
export const CNN_PARTS: [string, string][] = [
  ["market_momentum_sp500", "市場動能（S&P 500 和 125 日均線的差距）"],
  ["stock_price_strength", "股價強度（創 52 週新高和新低的家數）"],
  ["stock_price_breadth", "市場廣度（上漲和下跌股票的成交量）"],
  ["put_call_options", "賣權／買權比（5 日平均）"],
  ["market_volatility_vix", "市場波動（VIX 和 50 日均線）"],
  ["safe_haven_demand", "避險需求（近 20 日股票和公債報酬差）"],
  ["junk_bond_demand", "垃圾債需求（垃圾債和投資級債的殖利率差）"],
];
const isoYmd = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10).replace(/-/g, "") : "");
export function parseCnnFng(json: any): Fng | undefined {
  const fg = json?.fear_and_greed;
  const score = Number(fg?.score);
  if (!Number.isFinite(score)) return undefined;
  const value = Math.round(score);
  const r = (x: unknown) => { const n = Number(x); return Number.isFinite(n) ? Math.round(n) : undefined; };
  const byDate = new Map<string, number>();
  for (const d of json?.fear_and_greed_historical?.data ?? []) { const dt = isoYmd(Number(d?.x)); const y = Number(d?.y); if (dt && Number.isFinite(y)) byDate.set(dt, Math.round(y)); }
  const date = isoYmd(Date.parse(String(fg?.timestamp ?? ""))) || [...byDate.keys()].sort().at(-1) || "";
  if (date) byDate.set(date, value);
  const hist = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, v]) => ({ date: d, value: v }));
  let high: Fng["high"], low: Fng["low"];
  for (const h of hist) {
    if (!high || h.value >= high.value) high = { value: h.value, date: h.date };
    if (!low || h.value <= low.value) low = { value: h.value, date: h.date };
  }
  let streak = 0;
  for (let i = hist.length - 1; i >= 0 && fngLabel(hist[i].value) === fngLabel(value); i--) streak++;
  const parts = CNN_PARTS.map(([key, label]) => ({ key, label, score: Number(json?.[key]?.score), rating: String(json?.[key]?.rating ?? "").toLowerCase() }))
    .filter((p) => Number.isFinite(p.score)).map((p) => ({ ...p, score: Math.round(p.score), rating: LABEL[p.rating] ?? fngLabel(p.score) }));
  return { value, label: LABEL[String(fg?.rating ?? "").toLowerCase()] ?? fngLabel(value), date, prev: r(fg?.previous_close), weekAgo: r(fg?.previous_1_week), monthAgo: r(fg?.previous_1_month), yearAgo: r(fg?.previous_1_year), hist, high, low, streak: Math.max(1, streak), parts };
}
