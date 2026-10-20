// 美股即時報價（CNBC restQuote，realTime）：盤中是最新成交價，收盤後是收盤價，另外附盤前／盤後成交。
// 格式依 2026/10 GitHub Actions 實測回應撰寫（tools/probe/usquote.mjs）。
import { cnbcUrl } from "./us";
import { taipeiClock } from "../lib/dates";
import type { LiveQuote } from "./twLive";

export const usLiveUrl = (symbols: string[]) => cnbcUrl(symbols);

const num = (s: unknown) => { const n = parseFloat(String(s ?? "").replace(/[,%+]/g, "")); return Number.isFinite(n) ? n : NaN; };
/** "2026-10-19T16:00:00.000-0400" → 紐約日期 20261019 與時間戳 */
function parseTime(s: unknown): { ymd: string; t: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?([+-]\d{2})(\d{2})$/.exec(String(s ?? ""));
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}${m[5]}:${m[6]}`);
  return Number.isFinite(t) ? { ymd: `${m[1]}${m[2]}${m[3]}`, t } : null;
}

export function parseUsLive(json: any): Record<string, LiveQuote> {
  let list = json?.FormattedQuoteResult?.FormattedQuote;
  if (!list) return {};
  if (!Array.isArray(list)) list = [list];
  const out: Record<string, LiveQuote> = {};
  for (const q of list) {
    if (!q || q.code !== 0) continue;
    const price = num(q.last), prev = num(q.previous_day_closing), at = parseTime(q.last_time);
    if (!(price > 0) || !at) continue;
    const status = String(q.curmktstatus ?? "");
    const lq: LiveQuote = {
      code: String(q.symbol), name: String(q.name ?? q.symbol), price, prevClose: prev > 0 ? prev : NaN,
      open: num(q.open), high: num(q.high), low: num(q.low), date: at.ymd, time: taipeiClock(at.t), final: status !== "REG_MKT",
    };
    const x = q.ExtendedMktQuote, xt = parseTime(x?.last_time), xp = num(x?.last);
    // 只在盤前／盤後時段顯示延長交易，避免正常交易時段還掛著昨天的盤後價
    if ((status === "PRE_MKT" || status === "POST_MKT") && x?.type === status && xt && xp > 0)
      // 漲跌自己算（對照正常盤的價格），不用 CNBC 的 change_pct：避免盤後價低於收盤卻顯示成紅色
      lq.ext = { label: status === "PRE_MKT" ? "盤前" : "盤後", price: xp, chg: xp / price - 1, time: taipeiClock(xt.t) };
    out[lq.code] = lq;
  }
  return out;
}
