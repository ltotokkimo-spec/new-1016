// 免費解析：不呼叫 Claude，用 App 已有的資料（行情、日K、法人、族群、營收）依規則寫成報告。
// 和 Claude 解析的差別：這裡沒有新聞、法說會與國際經濟數據。
import type { Holding, Scored } from "./score";
import { STOP_LOSS } from "./score";
import type { Revenue } from "../data/revenue";

export interface FreeBar { date: string; close: number; volume?: number; high?: number; low?: number }

const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "無資料");
const px = (x: number, us: boolean) => (Number.isFinite(x) ? (us ? x.toFixed(2) : x >= 100 ? x.toFixed(1) : x.toFixed(2)) : "—");
const lots = (sh?: number) => (sh === undefined ? "無資料" : `${sh >= 0 ? "+" : ""}${Math.round(sh / 1000).toLocaleString()} 張`);

function sma(bars: FreeBar[], n: number, end = bars.length) {
  if (end < n) return NaN;
  let s = 0;
  for (let i = end - n; i < end; i++) s += bars[i].close;
  return s / n;
}
function rsi(bars: FreeBar[], n = 14) {
  if (bars.length <= n) return NaN;
  let g = 0, l = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    if (d > 0) g += d; else l -= d;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function stdev(xs: number[]) {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

export function freeReport(p: { s: Scored; bars: FreeBar[]; revenue?: Revenue; holding?: Holding; today: string }): string {
  const { s, revenue, holding } = p;
  // 日K最後一天的價格和今天差太多（資料錯誤或對不上），就不拿來算技術指標
  const lb = p.bars[p.bars.length - 1];
  const bars = lb && Math.abs(lb.close / p.s.close - 1) <= 0.25 ? p.bars : [];
  const us = s.market === "US";
  const ref = !!s.refOnly;
  const out: string[] = [];
  const last = bars[bars.length - 1];
  const close = s.close;
  const ma20 = sma(bars, 20), ma60 = sma(bars, 60);
  const r14 = rsi(bars);
  const recent = bars.slice(-120);
  const hi = recent.length ? Math.max(...recent.map((b) => b.high ?? b.close)) : NaN;
  const lo = recent.length ? Math.min(...recent.map((b) => b.low ?? b.close)) : NaN;
  const low20 = bars.length >= 20 ? Math.min(...bars.slice(-20).map((b) => b.low ?? b.close)) : NaN;
  const rets = bars.slice(-21).map((b, i, a) => (i ? b.close / a[i - 1].close - 1 : NaN)).filter(Number.isFinite);
  const vol20 = rets.length >= 10 ? stdev(rets) : NaN;
  const v5 = bars.slice(-5).map((b) => b.volume ?? NaN).filter(Number.isFinite);
  const v20 = bars.slice(-20).map((b) => b.volume ?? NaN).filter(Number.isFinite);
  const volRatio = v5.length && v20.length ? v5.reduce((a, b) => a + b, 0) / v5.length / (v20.reduce((a, b) => a + b, 0) / v20.length) : NaN;

  // ---------- 1. 結論 ----------
  out.push(`評等：${ref ? "參考" : s.rating}`);
  out.push("", "### 1. 結論");
  const parts: string[] = [];
  parts.push(s.momentum >= 0.7 ? "股價動能強" : s.momentum <= 0.3 ? "股價動能弱" : "股價動能普通");
  if (!us) parts.push(s.flow >= 0.65 ? "外資籌碼偏多" : s.flow <= 0.35 ? "外資籌碼偏空" : "外資籌碼中性");
  else parts.push(s.aboveMa50 ? "站在 50 日均線之上" : "跌破 50 日均線");
  parts.push(s.sectorScore >= 0.6 ? "族群強勢" : s.sectorScore <= 0.4 ? "族群偏弱" : "族群持平");
  out.push(`- App 分數 **${s.score}/100**（動能 ${Math.round(s.momentum * 100)}、${us ? "趨勢" : "籌碼"} ${Math.round(s.flow * 100)}、族群 ${Math.round(s.sectorScore * 100)}）：${parts.join("、")}。`);
  if (ref) out.push("- ETF 只給分數當參考，不給買賣評等（回測顯示這套短線規則對 ETF 分辨不出好壞）。");
  else if (s.rating === "買入") out.push("- 規則評為「買入」：動能、籌碼、族群同時偏多，而且一週漲幅還沒過熱。但這只是依規則整理的現況：App 回測（約 6 個月）顯示「買入」股票之後一個月並沒有贏過全部股票的平均，約一半會下跌，不能當作會漲的保證，務必設停損。");
  else if (s.rating === "離場") out.push("- 規則評為「離場」：分數偏低，或近一個月跌深且外資賣超，短期不宜進場，持有者要考慮減碼。");
  else out.push(`- 規則評為「觀望」：訊號分歧${s.score >= 70 ? "（分數夠高，但外資沒有買超或一週漲幅已過熱）" : `（分數 ${s.score} 未達買入門檻 70）`}，可以放進觀察名單等待更明確的訊號。`);

  // ---------- 2. 趨勢與技術面 ----------
  out.push("", "### 2. 趨勢與技術面");
  out.push(`- 報酬：近1週 ${pct(s.ret1w)}、近1月 ${pct(s.ret1m)}、近3月 ${pct(s.ret3m)}。`);
  if (bars.length >= 20) {
    const pos = close > ma20 && ma20 > ma60 ? "多頭排列（股價 > 20日線 > 60日線），趨勢向上" :
      close < ma20 && ma20 < ma60 ? "空頭排列（股價 < 20日線 < 60日線），趨勢向下" :
      close > ma20 ? "股價站上 20 日線，短線轉強" : "股價在 20 日線之下，短線偏弱";
    out.push(`- 均線：20 日線 ${px(ma20, us)}${Number.isFinite(ma60) ? `、60 日線 ${px(ma60, us)}` : ""}，${pos}。`);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      out.push(`- 近半年區間 ${px(lo, us)} ～ ${px(hi, us)}，目前距離高點 ${pct(close / hi - 1)}、距離低點 ${pct(close / lo - 1)}${close >= hi * 0.97 ? "，接近半年新高" : close <= lo * 1.05 ? "，接近半年低點" : ""}。`);
    }
    if (Number.isFinite(r14)) out.push(`- RSI(14) ${r14.toFixed(0)}：${r14 >= 75 ? "短線過熱，追高風險大" : r14 >= 60 ? "偏強" : r14 <= 25 ? "短線超賣，可能有反彈" : r14 <= 40 ? "偏弱" : "中性"}。`);
    if (Number.isFinite(volRatio)) out.push(`- 成交量：近5日均量是20日均量的 ${volRatio.toFixed(1)} 倍${volRatio >= 1.5 ? "，量能明顯放大" : volRatio <= 0.7 ? "，量縮" : ""}。`);
    if (Number.isFinite(vol20)) out.push(`- 波動：近20日日報酬標準差 ${(vol20 * 100).toFixed(1)}%${vol20 >= 0.04 ? "，波動很大，部位要小" : vol20 <= 0.015 ? "，波動小" : ""}。`);
  } else {
    out.push("- 日K資料不足，無法計算均線與技術指標。");
  }

  // ---------- 3. 籌碼 ----------
  if (!us) {
    out.push("", "### 3. 法人籌碼");
    const streak = s.foreignStreak ?? 0;
    out.push(`- 外資近5日 ${lots(s.foreign5)}、近10日 ${lots(s.foreign10)}${streak > 0 ? `，連續買超 ${streak} 天` : streak < 0 ? `，連續賣超 ${-streak} 天` : ""}。`);
    if (s.foreignRatio5 !== undefined && Number.isFinite(s.foreignRatio5)) out.push(`- 外資5日買賣超約佔成交金額 ${pct(s.foreignRatio5)}${Math.abs(s.foreignRatio5) >= 0.1 ? "，力道很強" : Math.abs(s.foreignRatio5) <= 0.02 ? "，影響不大" : ""}。`);
    if (s.foreign5 !== undefined && s.foreign10 !== undefined && s.foreign10 !== 0) {
      const recentShare = s.foreign5 / s.foreign10;
      if (s.foreign10 > 0 && recentShare < 0.4) out.push("- 外資10日是買超，但大部分買在前一週，最近5天力道減弱。");
      else if (s.foreign10 > 0 && recentShare > 0.8) out.push("- 外資買盤集中在最近5天，有加速跡象。");
    }
    out.push(`- 投信近5日 ${lots(s.trust5)}。`);
  }

  // ---------- 4. 族群 ----------
  out.push("", `### ${us ? 3 : 4}. 族群`);
  out.push(`- 所屬「${s.sector}」，族群分數 ${Math.round(s.sectorScore * 100)}${s.sectorScore >= 0.6 ? "，資金正在流入這個族群" : s.sectorScore <= 0.4 ? "，族群整體偏弱，個股要逆勢上漲比較難" : ""}。`);
  const secReason = s.reasons.find((r) => r.startsWith(`${s.sector}族群`));
  if (secReason) out.push(`- ${secReason}`);

  // ---------- 5. 營收 ----------
  let n = us ? 4 : 5;
  if (revenue && Number.isFinite(revenue.revenue)) {
    out.push("", `### ${n++}. 每月營收（${revenue.ym ? `${revenue.ym.slice(0, 4)}年${+revenue.ym.slice(4)}月` : "最新"}）`);
    out.push(`- 當月營收 ${(revenue.revenue / 1e5).toFixed(2)} 億元，月增 ${pct(revenue.mom)}、年增 ${pct(revenue.yoy)}、累計年增 ${pct(revenue.cumYoy)}。`);
    const y = revenue.yoy;
    if (Number.isFinite(y)) out.push(`- ${y >= 0.2 ? "營收高成長，基本面支持股價" : y >= 0 ? "營收小幅成長" : y >= -0.1 ? "營收小幅衰退" : "營收明顯衰退，要留意股價是否已反映"}。`);
  }

  // ---------- 6. 風險與觀察點 ----------
  out.push("", `### ${n++}. 支撐、壓力與觀察重點`);
  if (Number.isFinite(ma20)) out.push(`- 支撐：20 日線 ${px(ma20, us)}${Number.isFinite(low20) ? `、近20日低點 ${px(low20, us)}` : ""}${Number.isFinite(ma60) ? `、60 日線 ${px(ma60, us)}` : ""}。`);
  if (Number.isFinite(hi)) out.push(`- 壓力：近半年高點 ${px(hi, us)}${close >= hi * 0.97 ? "（正在挑戰，突破後才確認續強）" : ""}。`);
  if (!ref) {
    if (s.rating === "買入") out.push(`- 什麼情況要降級：${us ? "跌破 50 日均線" : "外資轉為賣超"}，或收盤跌破 20 日線 ${px(ma20, us)}。`);
    else if (s.rating === "觀望") out.push(`- 什麼情況會轉買入：分數升到 70 以上${us ? "" : "、外資轉為買超"}，且一週漲幅不超過 20%。`);
    else out.push("- 什麼情況會轉觀望：分數回到 40 以上，且近一個月不再大跌、外資停止賣超。");
  }

  // ---------- 7. 持股 ----------
  if (holding && holding.cost > 0) {
    const pnl = close / holding.cost - 1;
    const stop = holding.cost * (1 + STOP_LOSS);
    out.push("", `### ${n++}. 我的持股`);
    out.push(`- 持有 ${holding.shares.toLocaleString()} 股，成本 ${px(holding.cost, us)}，目前損益 ${pct(pnl)}（${us ? "US$" : ""}${Math.round((close - holding.cost) * holding.shares).toLocaleString()}${us ? "" : " 元"}）。`);
    out.push(`- 10% 停損價 ${px(stop, us)}${close <= stop ? "，**已經跌破，請考慮停損**" : `，距離目前 ${pct(stop / close - 1)}`}。`);
    if (ref) out.push("- ETF 適合用定期定額或長期持有的角度看，短線分數僅供參考。");
    else if (s.rating === "買入") out.push("- 規則仍偏多，可續抱，停損設在上面的價位。");
    else if (s.rating === "觀望") out.push("- 訊號分歧，可續抱但不加碼，跌破 20 日線或停損價要處理。");
    else out.push("- 規則轉弱，考慮減碼；若跌破停損價應出場。");
  }

  out.push("", "---", `資料日期 ${last ? `${last.date.slice(4, 6)}/${last.date.slice(6)}` : ""}。免費解析由 App 依固定規則自動產生，不含新聞、法說會與國際經濟數據；需要這些請用「Claude AI 解析」。以上為研究參考，非投資建議。`);
  return out.join("\n");
}
