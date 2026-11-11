// 持股分析與建議（11/9 使用者：「引導我將負損益做到正損益」）：只用規則計算，不呼叫 Claude、不花錢。
// 對每一檔虧損的持股算出「回本價」與還要漲多少，再依 App 評等給一個動作：
//   停損換股：評等「離場」或虧損已達 10% 停損線 → 賣掉，資金轉到目前評分最高的「買入」標的（ETF 換分數最高的 ETF）
//   攤平：評等「買入」（動能、籌碼仍強）→ 算出加碼多少股能讓回本所需漲幅減半，金額不超過目前持股市值
//   續抱設條件：其他（觀望、只供參考、沒有評等）→ 給回本價與停損價，轉為「買入」再考慮攤平
// 不是投資建議：攤平會增加這檔的部位與風險，停損換股也不保證新標的會漲。

import type { HoldingView, Scored } from "./score";
import { STOP_LOSS } from "./score";

export type RecoveryAction = "停損換股" | "攤平" | "續抱設條件";

export interface RecoveryItem {
  code: string; name: string; market: HoldingView["market"];
  shares: number; cost: number; price: number; pnl: number; pnlPct: number;
  rating: HoldingView["rating"];
  breakEven: number; // 含買賣手續費與證交稅的回本價
  needPct: number; // 從現價要漲多少才回本
  stopPrice: number; // 成本 −10%
  action: RecoveryAction;
  avg?: { addShares: number; addCost: number; newCost: number; newBreakEven: number; newNeedPct: number };
  swap?: { code: string; name: string; score: number; proceeds: number };
  lines: string[];
  sections: { title: string; lines: string[] }[]; // 詳細理由（技術面支撐壓力、籌碼與分數、原股 vs 換股標的、什麼情況可以不換）
  swapCodes?: string[]; // 推薦與備選的代號（畫面用來下載它們的日 K 算支撐壓力）
}

/** 由日 K 算出的價位（11/9 使用者：「需要詳細的理由來決定換股」） */
export interface Levels { ma20: number; ma60: number; low20: number; hi120: number; lo120: number }

export function levelsOf(bars: { close: number; high?: number; low?: number }[]): Levels | undefined {
  if (bars.length < 20) return undefined;
  const sma = (n: number) => (bars.length >= n ? bars.slice(-n).reduce((a, b) => a + b.close, 0) / n : NaN);
  const r = bars.slice(-120);
  return {
    ma20: sma(20), ma60: sma(60),
    low20: Math.min(...bars.slice(-20).map((b) => b.low ?? b.close)),
    hi120: Math.max(...r.map((b) => b.high ?? b.close)), lo120: Math.min(...r.map((b) => b.low ?? b.close)),
  };
}

const pctS = (x: number | undefined) => (x !== undefined && Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%` : "—");

/** 一檔股票的技術面描述：趨勢、支撐（現價以下）、壓力（現價以上） */
function techLines(price: number, lv: Levels | undefined, px: (x: number) => string, be?: number): string[] {
  if (!lv) return ["日 K 還在下載或資料不足，暫時無法判斷支撐與壓力"];
  const out: string[] = [];
  const { ma20, ma60 } = lv;
  const trend = Number.isFinite(ma60)
    ? price > ma20 && ma20 > ma60 ? "多頭排列（股價 > 20 日線 > 60 日線），趨勢向上"
      : price < ma20 && ma20 < ma60 ? "空頭排列（股價 < 20 日線 < 60 日線），趨勢向下"
        : price > ma20 ? "站上 20 日線、還在整理，短線轉強" : "在 20 日線之下，短線偏弱"
    : price > ma20 ? "站上 20 日線，短線轉強" : "在 20 日線之下，短線偏弱";
  out.push(`趨勢：${trend}`);
  const named = [["20 日線", ma20], ["60 日線", ma60], ["近 20 日低點", lv.low20], ["半年高點", lv.hi120], ["半年低點", lv.lo120]] as [string, number][];
  const ok = named.filter(([, x]) => Number.isFinite(x));
  const sup = ok.filter(([n, x]) => x < price && n !== "半年高點").sort((a, b) => b[1] - a[1]);
  const res = ok.filter(([n, x]) => x > price * 1.002 && n !== "半年低點" && n !== "近 20 日低點").sort((a, b) => a[1] - b[1]);
  out.push(sup.length ? `支撐：${sup.slice(0, 3).map(([n, x]) => `${n} ${px(x)}（${pctS(x / price - 1)}）`).join("、")}` : "支撐：現價已在半年低點附近，下方沒有明顯支撐");
  out.push(res.length ? `壓力：${res.slice(0, 3).map(([n, x]) => `${n} ${px(x)}（${pctS(x / price - 1)}）`).join("、")}` : "壓力：現價在半年高點之上或附近，上方沒有明顯壓力");
  if (be !== undefined) {
    const first = res[0];
    if (be > lv.hi120) out.push(`回本價 ${px(be)} 比半年高點 ${px(lv.hi120)} 還高：等於要創半年新高才回本，難度高`);
    else if (first && be > first[1] * 1.002) {
      const pass = res.filter(([, x]) => x < be).map(([n, x]) => `${n} ${px(x)}`);
      out.push(`回本前要先突破 ${pass.join("、")}，壓力越多越難回本`);
    } else out.push("回本價在第一道壓力之前，技術面上回本相對容易");
  }
  return out;
}

/** 分數與籌碼描述 */
function scoreLine(s: Scored | undefined, us: boolean): string {
  if (!s) return "沒有評分資料（成交金額低於門檻或還在載入）";
  const f = us ? (s.aboveMa50 ? "站上 50 日均線" : "跌破 50 日均線")
    : s.foreignStreak !== undefined && s.foreignStreak !== 0 ? `外資連續${s.foreignStreak > 0 ? "買" : "賣"}超 ${Math.abs(s.foreignStreak)} 天` : "外資沒有連續買賣超";
  const f5 = !us && s.foreign5 !== undefined ? `、外資 5 日 ${s.foreign5 >= 0 ? "+" : ""}${Math.round(s.foreign5 / 1000).toLocaleString("zh-TW")} 張` : "";
  return `分數 ${s.score}（動能 ${Math.round(s.momentum * 100)}、${us ? "趨勢" : "籌碼"} ${Math.round(s.flow * 100)}、族群 ${Math.round(s.sectorScore * 100)}）・近1週 ${pctS(s.ret1w)}、近1月 ${pctS(s.ret1m)}、近3月 ${pctS(s.ret3m)}・${f}${f5}`;
}

export interface RecoverySummary {
  losers: number; winners: number;
  loss: number; // 虧損持股的損益合計（負數，台股台幣；美股另計）
  cutProceeds: number; // 停損換股可收回的金額
  avgCash: number; // 攤平需要的金額
  lines: string[];
}

const FEE = 0.001425; // 台股手續費（未打折）
const taxOf = (code: string, market: string) => (market === "US" ? 0 : /^00/.test(code) ? 0.001 : 0.003);

/** 含手續費、證交稅的回本價：賣出淨得 ≥ 買進總成本 */
export function breakEvenPrice(cost: number, code: string, market: string): number {
  const fee = market === "US" ? 0.001 : FEE;
  return (cost * (1 + fee)) / (1 - fee - taxOf(code, market));
}

/** 加碼 n 股（現價）讓回本所需漲幅降到 targetNeed；回傳需要的股數（不超過 maxShares） */
export function sharesToAverage(shares: number, cost: number, price: number, k: number, targetNeed: number, maxShares: number): number {
  const cStar = (price * (1 + targetNeed)) / k; // 新均價目標
  if (!(cStar > price) || !(cStar < cost)) return 0;
  const n = Math.ceil((shares * (cost - cStar)) / (cStar - price));
  return Math.max(0, Math.min(n, maxShares));
}

/** 台股加碼股數：滿 1 張就取整張（較省手續費），不滿 1 張用零股 */
const roundTw = (n: number) => (n >= 1000 ? Math.floor(n / 1000) * 1000 : n);

export function recoveryPlan(views: HoldingView[], picks: { stocks: Scored[]; etfs: Scored[]; us: Scored[] }, levels: Record<string, Levels | undefined> = {}): { items: RecoveryItem[]; summary: RecoverySummary } {
  const held = new Set(views.map((v) => v.code));
  // 每檔停損推薦不同的標的（11/9 使用者：每一檔建議買的都一樣）：虧最多的先分到評分最高的，已推薦過的不再推薦；另附 2 檔備選
  const used = new Set<string>();
  const ranked = (list: Scored[], buyOnly: boolean) => list.filter((s) => !held.has(s.code) && !used.has(s.code) && (!buyOnly || s.rating === "買入")).sort((a, b) => b.score - a.score);
  const items: RecoveryItem[] = [];
  let winners = 0, twWinPnl = 0;
  for (const v of [...views].sort((a, b) => (a.pnl || 0) - (b.pnl || 0))) {
    if (!Number.isFinite(v.price) || !(v.cost > 0) || !(v.shares > 0)) continue;
    if (!(v.pnl < 0)) { if (v.pnl > 0) { winners++; if (v.market !== "US") twWinPnl += v.pnl; } continue; }
    const us = v.market === "US", etf = !us && /^00/.test(v.code);
    const be = breakEvenPrice(v.cost, v.code, v.market);
    const k = be / v.cost;
    const needPct = be / v.price - 1;
    const stopPrice = v.cost * (1 + STOP_LOSS);
    const unit = us ? "$" : "";
    const px = (x: number) => `${unit}${x >= 100 ? x.toFixed(1) : x.toFixed(2)}`;
    const money = (x: number) => `${us ? "$" : ""}${Math.round(x).toLocaleString("zh-TW")}${us ? "" : " 元"}`;
    const base = { code: v.code, name: v.name, market: v.market, shares: v.shares, cost: v.cost, price: v.price, pnl: v.pnl, pnlPct: v.pnlPct, rating: v.rating, breakEven: be, needPct, stopPrice };
    const lines = [`回本價 ${px(be)}（含手續費與證交稅），現價還要漲 ${(needPct * 100).toFixed(1)}%`];
    const hitStop = v.pnlPct <= STOP_LOSS;
    if (v.rating === "離場" || hitStop) {
      const cand = ranked(us ? picks.us : etf ? picks.etfs : picks.stocks, !etf);
      const s = cand[0], alts = cand.slice(1, 3);
      if (s) used.add(s.code);
      const proceeds = v.shares * v.price * (1 - (us ? 0.001 : FEE) - taxOf(v.code, v.market));
      lines.push(hitStop ? `虧損 ${(v.pnlPct * 100).toFixed(1)}% 已達 10% 停損線` : "App 評等「離場」：動能與籌碼都轉弱，等它回本的機會較低");
      lines.push(`建議賣出 ${v.shares.toLocaleString()} 股，約可收回 ${money(proceeds)}`);
      if (s) lines.push(`轉買${etf ? "分數高的 ETF" : "評分高的「買入」標的"}：${s.name} ${s.code}（分數 ${s.score}）${alts.length ? `；備選 ${alts.map((a) => `${a.name} ${a.code}（${a.score}）`).join("、")}` : ""}。同樣要賺回 ${(needPct * 100).toFixed(1)}%，放在走強的股票上機會較大；每檔推薦不同標的，換股後不會全集中在同一檔`);
      lines.push("如果不想停損：至少不要再加碼，等評等轉回「觀望」或「買入」再說");
      const lv = levels[v.code];
      const sections = [
        { title: `${v.name}的技術面（支撐與壓力）`, lines: techLines(v.price, lv, px, be) },
        { title: `${v.name}的分數與籌碼`, lines: [scoreLine(v.scored, us), ...(v.scored?.reasons ?? []).slice(0, 2)] },
      ];
      if (s) {
        const sp = (x: number) => `${unit}${x >= 100 ? x.toFixed(1) : x.toFixed(2)}`;
        sections.push({ title: `換股標的：${s.name} ${s.code}`, lines: [scoreLine(s, us), ...techLines(s.close, levels[s.code], sp), ...(s.reasons ?? []).slice(0, 2)] });
        const cmp: string[] = [];
        cmp.push(`分數：${v.name} ${v.scored?.score ?? "—"} → ${s.name} ${s.score}；評等：${v.rating} → ${s.rating}`);
        cmp.push(`近1月：${pctS(v.scored?.ret1m)} → ${pctS(s.ret1m)}`);
        if (!us) cmp.push(`外資：${v.scored?.foreignStreak ? `${v.scored.foreignStreak > 0 ? "連買" : "連賣"} ${Math.abs(v.scored.foreignStreak)} 天` : "—"} → ${s.foreignStreak ? `${s.foreignStreak > 0 ? "連買" : "連賣"} ${Math.abs(s.foreignStreak)} 天` : "—"}`);
        const vTrendUp = lv ? v.price > lv.ma20 : undefined, sl = levels[s.code], sTrendUp = sl ? s.close > sl.ma20 : undefined;
        if (vTrendUp !== undefined && sTrendUp !== undefined) cmp.push(`20 日線：${v.name}${vTrendUp ? "之上" : "之下"} → ${s.name}${sTrendUp ? "之上" : "之下"}`);
        cmp.push(`結論：${(s.score - (v.scored?.score ?? 0)) >= 20 ? "新標的分數明顯較高，換股的理由充分" : "兩者分數差距不大，換股的理由較弱，可以只停損、資金先留現金"}；換股後新標的要漲 ${(needPct * 100).toFixed(1)}% 就能補回這筆虧損`);
        sections.push({ title: "原股 vs 換股標的", lines: cmp });
      }
      const wait: string[] = [];
      if (lv) wait.push(`可以先不換的情況：收盤站回 20 日線 ${px(lv.ma20)}${us ? "" : "且外資轉為買超"}，評等可能回到「觀望」，再重新評估`);
      if (lv) wait.push(`一定要走的情況：收盤跌破近 20 日低點 ${px(lv.low20)}，代表跌勢延續，不要再等`);
      wait.push(`換股也要設停損：新標的買進後跌 10% 一樣停損，不要變成第二檔套牢`);
      sections.push({ title: "決定前的檢查", lines: wait });
      items.push({ ...base, action: "停損換股", swap: s ? { code: s.code, name: s.name, score: s.score, proceeds } : undefined, swapCodes: [s, ...alts].filter(Boolean).map((x) => x!.code), lines, sections });
    } else if (v.rating === "買入") {
      // 加碼股數不超過目前持股（最多加倍），避免單檔越攤越大
      let n = sharesToAverage(v.shares, v.cost, v.price, k, needPct / 2, v.shares);
      if (!us) n = roundTw(n);
      if (n > 0) {
        const newCost = (v.shares * v.cost + n * v.price) / (v.shares + n), nbe = newCost * k, nn = nbe / v.price - 1;
        lines.push(`App 評等「買入」：動能、籌碼仍強，可以考慮攤平`);
        lines.push(`在 ${px(v.price)} 附近加碼 ${n.toLocaleString()} 股（約 ${money(n * v.price)}）→ 均價 ${px(newCost)}、回本價 ${px(nbe)}，只要漲 ${(nn * 100).toFixed(1)}% 就回本`);
        lines.push(`攤平會加大這檔的部位：跌破 ${px(stopPrice)}（原成本 −10%）一樣要停損`);
        const lv = levels[v.code];
        if (lv && Number.isFinite(lv.ma20)) lines.push(v.price > lv.ma20 * 1.03 ? `現價高於 20 日線 ${px(lv.ma20)} 超過 3%：建議分批，等拉回 20 日線附近再加碼，不要追高` : `現價接近 20 日線支撐 ${px(lv.ma20)}，是相對合理的加碼位置`);
        items.push({ ...base, action: "攤平", avg: { addShares: n, addCost: n * v.price, newCost, newBreakEven: nbe, newNeedPct: nn }, lines,
          sections: [{ title: `${v.name}的技術面（支撐與壓力）`, lines: techLines(v.price, lv, px, nbe) }, { title: `${v.name}的分數與籌碼`, lines: [scoreLine(v.scored, us), ...(v.scored?.reasons ?? []).slice(0, 2)] }] });
      } else {
        lines.push("App 評等「買入」，虧損很小，續抱等回本即可");
        lines.push(`跌破 ${px(stopPrice)}（成本 −10%）就停損`);
        items.push({ ...base, action: "續抱設條件", lines, sections: [{ title: `${v.name}的技術面（支撐與壓力）`, lines: techLines(v.price, levels[v.code], px, be) }, { title: `${v.name}的分數與籌碼`, lines: [scoreLine(v.scored, us)] }] });
      }
    } else {
      lines.push(v.rating === "觀望" ? "App 評等「觀望」：訊號分歧，先不加碼也不急著賣" : v.rating === "參考" ? `ETF 只供參考（分數 ${v.scored?.score ?? "—"}）：先不加碼` : "沒有評等：先不加碼");
      lines.push(`跌破 ${px(stopPrice)}（成本 −10%）就停損；評等轉為「買入」再考慮攤平`);
      items.push({ ...base, action: "續抱設條件", lines, sections: [{ title: `${v.name}的技術面（支撐與壓力）`, lines: techLines(v.price, levels[v.code], px, be) }, { title: `${v.name}的分數與籌碼`, lines: [scoreLine(v.scored, us), ...(v.scored?.reasons ?? []).slice(0, 2)] }] });
    }
  }
  // 停損換股的排最前面（最需要處理），其次攤平，最後續抱；同一類虧損金額大的在前
  const order: Record<RecoveryAction, number> = { 停損換股: 0, 攤平: 1, 續抱設條件: 2 };
  items.sort((a, b) => order[a.action] - order[b.action] || a.pnl - b.pnl);
  const tw = items.filter((x) => x.market !== "US");
  const loss = tw.reduce((a, x) => a + x.pnl, 0);
  const cuts = tw.filter((x) => x.action === "停損換股"), avgs = tw.filter((x) => x.action === "攤平");
  const cutProceeds = cuts.reduce((a, x) => a + (x.swap?.proceeds ?? x.shares * x.price), 0);
  const avgCash = avgs.reduce((a, x) => a + (x.avg?.addCost ?? 0), 0);
  const lines: string[] = [];
  if (!items.length) lines.push(winners ? "目前沒有虧損的持股，照各檔的停利、停損條件續抱即可。" : "還沒有可計算的持股。");
  else {
    const n0 = (x: number) => Math.round(x).toLocaleString("zh-TW");
    const sg = (x: number) => (x > 0 ? "+" : "") + n0(x);
    lines.push(`${items.length} 檔虧損${tw.length ? `，台股虧損合計 ${n0(loss)} 元` : ""}；${winners} 檔獲利${twWinPnl > 0 ? `，台股獲利合計 ${sg(twWinPnl)} 元` : ""}。`);
    if (tw.length && twWinPnl > 0) lines.push(`台股虧損 ${n0(loss)} ＋ 獲利 ${sg(twWinPnl)} ＝ 累計損益 ${sg(loss + twWinPnl)} 元（和上面市值卡片的台股累計損益相同）。`);
    if (cuts.length) lines.push(`先處理 ${cuts.length} 檔「停損換股」：${cuts.map((x) => x.name).join("、")}，約可收回 ${Math.round(cutProceeds).toLocaleString("zh-TW")} 元，轉到走強的標的。`);
    if (avgs.length) lines.push(`${avgs.length} 檔評等仍是「買入」可以攤平：${avgs.map((x) => x.name).join("、")}，約需 ${Math.round(avgCash).toLocaleString("zh-TW")} 元；停損換股收回的錢可以優先用在這裡。`);
    const holdN = items.filter((x) => x.action === "續抱設條件").length;
    if (holdN) lines.push(`${holdN} 檔續抱設條件：照回本價與停損價觀察，不加碼。`);
  }
  return { items, summary: { losers: items.length, winners, loss, cutProceeds, avgCash, lines } };
}
