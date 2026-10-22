// 「自組ETF」分頁：請 Claude 建議要買什麼、買幾股，照著實際下單後填入成交，追蹤淨值並和 0050 比較。
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  addEtfTrades, hideEtfTrade, offListNow, refreshLive, refreshVirtual, etfAdviceInput, etfRating, recordSpend, saveProReply, setEtfFillFrom, etfAlertsNow, etfPrice, getState, resetAiEtf, setEtfBudget, setEtfStop, snapshotEtfNav, startEtfAdvice, useStore,
} from "../store";
import { aiEtfPrompt, claudeAppUrl, explainError, holdingsFromImage, shrinkImage } from "../ai/claude";
import type { Scored } from "../engine/score";
import { type EtfTrade, comparePlans, DEFAULT_STOP, fitBudget, groupBySector, isOwnPrompt, looksLikePlanReply, parsePlan, positions, tradePnls, reconcilePhoto, stopOf, type PhotoRow, valuate, type EtfAlert, type PlanItem, type Position } from "../engine/aiEtf";
import { orderDay, pretty, prettyW, taipeiToday } from "../lib/dates";
import { beforeTopUp, CASH_BASE, CASH_MAX, CASH_STEPS, cashLevel, type CashPlan } from "../engine/virtualEtf";
import { marketOpen, type LiveQuote } from "../data/twLive";
import { cls, fmtMoney, fmtPct, fmtPrice } from "./common";
import { AiProgressView, AiReportView, BalanceHint, copyText } from "./screens";

/** 帶正負號的台幣金額：+1,234／-567／0 */
const signedMoney = (x: number) => `${x < 0 ? "-" : x > 0 ? "+" : ""}${Math.round(Math.abs(x)).toLocaleString("zh-TW")}`;

/** 報酬率下一行的總損益（現在的淨值減起始資金，賺紅賠綠，顏色跟著外層） */
function TotalPnl({ now, budget }: { now: number; budget: number }) {
  const x = now - budget;
  return <div style={{ whiteSpace: "nowrap" }}>總損益 {signedMoney(x)}</div>;
}

/** 持股損益用台幣金額顯示：+1,234／-567（賺紅賠綠）；還沒有現價就不顯示 */
function TwdPnl({ shares, avgCost, price }: { shares: number; avgCost: number; price: number | undefined }) {
  if (price === undefined || !Number.isFinite(price)) return null;
  const x = (price - avgCost) * shares;
  return <><span class={cls(x)} style={{ whiteSpace: "nowrap" }}>損益 {x < 0 ? "-" : x > 0 ? "+" : ""}{Math.round(Math.abs(x)).toLocaleString("zh-TW")}</span>・</>;
}

/** 不在選股「買入」清單的提醒（只警告，不阻擋） */
function OffTag() {
  return <span class="warn-tag" data-testid="off-list">非選股清單</span>;
}

/** 成交紀錄一列：日期 買／賣 名稱 股數・成交價・損益（賣出＝已實現，買進＝現價帳面，賺紅賠綠） */
function TradeLine({ t, pnl }: { t: EtfTrade; pnl?: number }) {
  return (
    <span class="num" style={{ minWidth: 0 }}>
      {pretty(t.date)} <span class={t.side === "buy" ? "up" : "down"}>{t.side === "buy" ? "買" : "賣"}</span> {t.name}{t.offList && <OffTag />} {t.shares.toLocaleString()} 股・成交價 {fmtPrice(t.price)}
      {pnl !== undefined && Number.isFinite(pnl) && <>・<span class={cls(pnl)} style={{ whiteSpace: "nowrap" }}>損益 {signedMoney(pnl)}</span></>}
    </span>
  );
}

const TRADE_HINT = "賣出的損益是這筆已實現的賺賠（已扣手續費與證交稅）；買進的損益用現價計算，這檔賣光後就不顯示。";

/** 兩條線：我的組合 vs 0050（報酬率 %） */
function NavChart({ points, budget, mine = "我的自組 ETF" }: { points: { date: string; nav: number; bench: number }[]; budget: number; mine?: string }) {
  if (points.length < 2) return null;
  const W = 340, H = 150, pad = 28;
  const a = points.map((p) => p.nav / budget - 1), b = points.map((p) => p.bench / budget - 1);
  const lo = Math.min(...a, ...b, 0), hi = Math.max(...a, ...b, 0), span = hi - lo || 0.01;
  const x = (i: number) => pad + (i / (points.length - 1)) * (W - pad - 6);
  const y = (v: number) => 8 + (1 - (v - lo) / span) * (H - 28);
  const line = (vs: number[]) => vs.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <div class="card" style={{ padding: "10px" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="自組 ETF 與 0050 報酬率走勢">
        <line x1={pad} x2={W - 6} y1={y(0)} y2={y(0)} stroke="var(--line)" stroke-dasharray="3 3" />
        <text x={2} y={y(hi) + 4} font-size="10" fill="var(--muted)">{fmtPct(hi)}</text>
        <text x={2} y={y(lo) + 4} font-size="10" fill="var(--muted)">{fmtPct(lo)}</text>
        <path d={line(b)} fill="none" stroke="var(--muted)" stroke-width="1.5" />
        <path d={line(a)} fill="none" stroke="var(--accent)" stroke-width="2.2" />
        <text x={pad} y={H - 4} font-size="10" fill="var(--muted)">{pretty(points[0].date)}</text>
        <text x={W - 6} y={H - 4} font-size="10" fill="var(--muted)" text-anchor="end">{pretty(points[points.length - 1].date)}</text>
      </svg>
      <div class="row" style={{ fontSize: "12px", gap: "14px" }}>
        <span><b style={{ color: "var(--accent)" }}>━</b> {mine}</span><span class="muted">━ 同樣的錢買 0050</span>
      </div>
    </div>
  );
}

/** 資金水位：一條 0~100% 的橫條，看股票佔多少、目標在哪、還能不能加碼；下面一張小表列出規劃，目前所在的那一段標出來 */
export function CashGauge({ plan, nav, marketValue, pendingNet = 0 }: { plan?: CashPlan; nav: number; marketValue: number; pendingNet?: number }) {
  const lv = cashLevel(plan, nav, marketValue);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const after = nav > 0 ? (marketValue + pendingNet) / nav : 0; // 已排定的委託成交後
  const left = lv.room - pendingNet;
  const near = Math.abs(left) < nav * 0.02; // 差不到 2% 就算到位
  const status = near ? "已到目標水位" : left > 0 ? `還可加碼約 ${fmtMoney(left)}` : `超出目標約 ${fmtMoney(-left)}，反彈時減碼`;
  const rows = [
    { k: "平常", v: `${Math.round(CASH_BASE * 10)} 成股票・${Math.round((1 - CASH_BASE) * 10)} 成現金`, t: CASH_BASE },
    ...CASH_STEPS.map((x) => ({ k: `大盤跌 ${Math.round(x.dd * 100)}%`, v: `股票最多 ${Math.round(x.target * 10)} 成`, t: x.target })),
  ];
  return (
    <div class="card stack" style={{ marginTop: "12px" }} data-testid="cash-gauge">
      <div class="row" style={{ justifyContent: "space-between" }}>
        <b>資金水位</b>
        <span class="num" style={{ fontSize: "14px" }}>股票 <b>{pct(lv.stock)}</b>・現金 <b>{pct(lv.cash)}</b></span>
      </div>
      <div style={{ position: "relative", height: "22px", borderRadius: "6px", background: "var(--surface-2, var(--line))", overflow: "hidden" }}>
        {/* 跌深加碼區（7~9 成）與保留現金區（9 成以上，斜線） */}
        <div style={{ position: "absolute", left: pct(CASH_BASE), width: pct(CASH_MAX - CASH_BASE), top: 0, bottom: 0, background: "var(--hold-bg)" }} />
        <div style={{ position: "absolute", left: pct(CASH_MAX), right: 0, top: 0, bottom: 0, background: "repeating-linear-gradient(45deg, transparent 0 4px, var(--line) 4px 6px)" }} />
        {pendingNet > 0 && <div style={{ position: "absolute", left: 0, width: pct(Math.min(1, after)), top: "5px", bottom: "5px", borderRadius: "0 4px 4px 0", border: "1.5px dashed var(--accent)", boxSizing: "border-box" }} />}
        <div style={{ position: "absolute", left: 0, width: pct(Math.min(1, Math.max(0, lv.stock))), top: "5px", bottom: "5px", borderRadius: "0 4px 4px 0", background: "var(--accent)" }} />
        <div style={{ position: "absolute", left: pct(lv.target), top: 0, bottom: 0, width: "2px", marginLeft: "-1px", background: "var(--fg)" }} />
      </div>
      <div class="num muted" style={{ position: "relative", height: "14px", fontSize: "11px", marginTop: "-6px" }}>
        <span style={{ position: "absolute", left: 0 }}>0</span>
        <span style={{ position: "absolute", left: pct(CASH_BASE), transform: "translateX(-50%)" }}>7 成</span>
        <span style={{ position: "absolute", left: pct(CASH_MAX), transform: "translateX(-50%)" }}>9 成</span>
      </div>
      <div style={{ fontSize: "14px", lineHeight: 1.6 }} data-testid="cash-status">
        目標股票 <b class="num">{pct(lv.target)}</b>（{lv.label}）・<b>{status}</b>
        {pendingNet !== 0 && <div class="muted" style={{ fontSize: "12px" }}>已排定委託 {pendingNet > 0 ? "淨買進" : "淨賣出"}約 {fmtMoney(Math.abs(pendingNet))}，成交後股票約 {pct(after)}（虛線）</div>}
        {plan && <div class="muted" style={{ fontSize: "12px" }}>{prettyW(plan.date)} 判斷：加權指數距近 20 日最高收盤 <span class={cls(plan.drawdown)}>{fmtPct(plan.drawdown, 1)}</span>。{plan.reason}</div>}
      </div>
      <div style={{ fontSize: "13px" }}>
        {rows.map((r) => {
          const on = Math.abs(r.t - lv.target) < 1e-9;
          return (
            <div class="row" style={{ justifyContent: "space-between", padding: "4px 8px", borderRadius: "6px", background: on ? "var(--hold-bg)" : "transparent", fontWeight: on ? 700 : 400 }}>
              <span>{on ? "▶ " : ""}{r.k}</span><span class="num">{r.v}</span>
            </div>
          );
        })}
        <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6, marginTop: "4px" }}>至少留 1 成現金（斜線區不動用）。反彈站回 20 日線後，分批降回 7 成。Claude 每天收盤後自動判斷並調整。</div>
      </div>
    </div>
  );
}

/** 免費提醒：跌破停損、被 App 評為離場（每次更新行情就重新比對，不花錢） */
function AlertCard({ alerts, onAsk, canAsk, asOf }: { alerts: EtfAlert[]; onAsk: () => void; canAsk: boolean; asOf?: string }) {
  if (!alerts.length) return null;
  // 同一檔的多個提醒合併成一行
  const codes = [...new Set(alerts.map((a) => a.code))];
  const toPro = () => document.querySelector('[data-testid="pro-review"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <div class="card stack alert-card" data-testid="etf-alerts">
      <b>⚠ 有 {codes.length} 檔需要注意</b>
      {codes.map((code) => {
        const as = alerts.filter((a) => a.code === code);
        const stop = as.find((a) => a.kind === "stop"), exit = as.some((a) => a.kind === "exit");
        return (
          <div style={{ fontSize: "14px", lineHeight: 1.6 }}>
            <b>{as[0].name}</b> <span class="muted num" style={{ marginRight: "8px" }}>{code}</span>
            {stop && <>現價 <span class="num down">{fmtPrice(stop.price!)}</span> 跌破停損價 <span class="num">{fmtPrice(stop.stop!)}</span>{stop.isDefault ? `（預設成本 −${DEFAULT_STOP * 100}%）` : ""}</>}
            {stop && exit && "；"}
            {exit && <>App 今天評為<span class="down">「離場」</span>（動能或籌碼轉弱）</>}
          </div>
        );
      })}
      <DateHint asOf={asOf} what="提醒" />
      <div class="muted" style={{ fontSize: "12px" }}>這是 App 用收盤價自動比對的免費提醒，不代表一定要賣。可以請 Claude 檢視後再決定：</div>
      {canAsk && <button class="btn block" onClick={onAsk}>請 Claude 檢視調整（API 付費，約台幣 20～30 元）</button>}
      <button class="btn secondary block" onClick={toPro} data-testid="alert-pro">用 Claude Pro 檢視（免費，用你的訂閱）</button>
    </div>
  );
}

/** 持股列上的停損價：點一下可以修改 */
function StopEdit({ p, stops }: { p: Position; stops?: Record<string, number> }) {
  const { stop, isDefault } = stopOf(p, stops);
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState("");
  if (!edit) return <button class="linkbtn num" onClick={() => { setText(isDefault ? "" : String(stop)); setEdit(true); }} data-testid="stop-edit">停損 {fmtPrice(stop)}{isDefault ? "（預設）" : ""} ✎</button>;
  const save = async () => { await setEtfStop(p.code, Number(text) > 0 ? Number(text) : undefined); setEdit(false); };
  return (
    <span class="row" style={{ gap: "6px", flexWrap: "nowrap" }}>
      <input class="mini-input" inputMode="decimal" placeholder={`空白＝成本 −${DEFAULT_STOP * 100}%`} value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} data-testid="stop-input" />
      <button class="btn secondary mini" onClick={save} data-testid="stop-save">儲存</button>
    </span>
  );
}

/** 這份判斷用的是哪天的收盤資料、建議哪天下單 */
function DateHint({ asOf, latest, what = "這份建議" }: { asOf?: string; latest?: string; what?: string }) {
  if (!asOf) return null;
  return (
    <div class="date-hint" data-testid="date-hint">
      📅 {what}根據 <b>{prettyW(asOf)}</b> 收盤資料，建議 <b>{prettyW(orderDay(asOf))}</b> 盤中下單（9:00～13:30，用限價單；遇國定假日順延）
      {latest && latest > asOf && <div class="down" style={{ marginTop: "4px" }}>之後已經有 {prettyW(latest)} 的新資料，價格可能變了，下單前可以再檢視一次。</div>}
    </div>
  );
}

const fmtAt = (t: number) => new Date(t).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

// 去 Claude App 之前記一筆旗標；回到掃雷專區時，如果剪貼簿裡有 Claude 的回覆就問要不要載入，不用自己貼
const PRO_KEY = "proPending";
const PRO_TTL = 24 * 3600_000; // 按過按鈕後 24 小時內，回到 App 都會自動偵測剪貼簿
const proFlag = {
  get: () => { try { const t = Number(localStorage.getItem(PRO_KEY)); return t && Date.now() - t < PRO_TTL ? t : 0; } catch { return 0; } },
  set: () => { try { localStorage.setItem(PRO_KEY, String(Date.now())); } catch { /* 不重要 */ } },
  clear: () => { try { localStorage.removeItem(PRO_KEY); } catch { /* 不重要 */ } },
};
let proIgnored = ""; // 按過「略過」或已載入的那份回覆，不再重複問

/** 從 Claude App 回來：偵測剪貼簿的回覆，按一下載入並整理（讀不到剪貼簿就請你按「貼上並載入」） */
function ProResume() {
  const [pending, setPending] = useState(() => proFlag.get() > 0);
  const [found, setFound] = useState<{ text: string; items: number } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const check = async () => {
    if (!proFlag.get()) { setPending(false); return; }
    setPending(true);
    try {
      const text = await navigator.clipboard.readText();
      const r = looksLikePlanReply(text);
      if (r.ok && text.trim() !== proIgnored) { setFound({ text, items: r.items }); setMsg(""); }
    } catch { /* 沒有權限或畫面還沒回到前景：用下面的按鈕，按下去就有權限 */ }
  };
  useEffect(() => {
    check();
    const on = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    return () => { document.removeEventListener("visibilitychange", on); window.removeEventListener("focus", on); };
  }, []);
  const load = async (text: string, items: number) => {
    setBusy(true);
    await saveProReply(text);
    proIgnored = text.trim();
    proFlag.clear();
    setFound(null); setPending(false); setBusy(false);
    setMsg(`已載入 Claude 的建議（${items ? `${items} 筆買賣` : "維持不變"}），往下看整理好的結果${items ? "與填成交表單" : ""}。`);
  };
  const pasteAndLoad = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const r = looksLikePlanReply(text);
      if (!r.ok) return setMsg("剪貼簿裡還沒有 Claude 的回覆。請到 Claude App 長按回覆 →「複製」，再回來按一次。");
      await load(text, r.items);
    } catch {
      setMsg("這支手機不讓 App 讀剪貼簿，請用下面的「貼上 Claude App 的回覆」手動貼上。");
      document.querySelector('[data-testid="pro-text"]')?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };
  const skip = () => { if (found) proIgnored = found.text.trim(); setFound(null); };
  const cancel = () => { proFlag.clear(); setPending(false); setFound(null); };
  if (found) return (
    <div class="card stack" style={{ borderColor: "var(--accent)", marginBottom: "12px" }} data-testid="pro-found">
      <b>偵測到 Claude 的回覆（{found.items ? `${found.items} 筆買賣` : "維持不變"}）</b>
      <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>{parsePlan(found.text).body.replace(/\s+/g, " ").slice(0, 80)}…</div>
      <button class="btn block" onClick={() => load(found.text, found.items)} disabled={busy} data-testid="pro-found-load">載入並整理</button>
      <button class="linkbtn" onClick={skip}>這不是，略過</button>
    </div>
  );
  if (pending) return (
    <div class="card stack" style={{ borderColor: "var(--accent)", marginBottom: "12px" }} data-testid="pro-resume">
      <b>從 Claude App 回來了嗎？</b>
      <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>在 Claude App 長按回覆 →「複製」，回來按下面的按鈕，App 會自動整理並帶出填成交表單。</div>
      <button class="btn block" onClick={pasteAndLoad} data-testid="pro-resume-paste">貼上 Claude 的回覆並載入</button>
      {msg && <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>{msg}</div>}
      <button class="linkbtn" onClick={cancel}>不用了</button>
    </div>
  );
  return msg ? <div class="notice" style={{ marginBottom: "12px" }} data-testid="pro-loaded">{msg}</div> : null;
}

/** 用 Claude App（Pro 訂閱）檢視：帶同一份數據與提問過去，回覆貼回來比較，不扣 API 額度 */
function ProReview({ disabled, review }: { disabled: boolean; review: boolean }) {
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const prompt = disabled ? "" : aiEtfPrompt(etfAdviceInput(), true);
  const PROMPT_MSG = "⚠ 這是 App 送給 Claude 的提問，不是 Claude 的回覆。按「在 Claude App 檢視調整」時剪貼簿會被換成提問，所以要先到 Claude 那邊（Claude App 或正在對話的視窗）長按「它的回覆」→ 複製，再回來貼上。";
  const onText = (v: string) => { setText(v); setErr(isOwnPrompt(v) ? PROMPT_MSG : ""); };
  const bad = isOwnPrompt(text);
  const save = async () => {
    if (text.trim().length < 20) return setErr("請把 Claude App 的整段回覆貼上來");
    if (bad) return setErr(PROMPT_MSG);
    if (!parsePlan(text).items.length && !/維持不變/.test(text)) setErr("回覆最後沒有找到 JSON 買賣清單，仍會存下文字；可以請 Claude 補上 JSON 區塊再貼一次");
    else setErr("");
    await saveProReply(text);
    setText("");
  };
  return (
    <div class="card stack" data-testid="pro-review">
      <b>用 Claude Pro 檢視（免費，用你的訂閱）</b>
      <ol class="steps muted" style={{ fontSize: "12.5px", lineHeight: 1.7, margin: 0, paddingLeft: "18px" }} data-testid="pro-steps">
        <li>按下面的按鈕，會自動複製提問並打開 Claude App。</li>
        <li>在 Claude App 的輸入框<b>貼上並送出</b>，等它回答完。</li>
        <li>按回覆<b>下方的「複製」圖示</b>（複製整段回覆；不用全選整個對話）。</li>
        <li>回到這個 App，最上面會跳出「偵測到 Claude 的回覆」，按<b>「載入並整理」</b>就完成。</li>
      </ol>
      <a class="btn secondary block" aria-disabled={disabled} href={prompt ? claudeAppUrl(prompt) : undefined} target="_blank" rel="noreferrer"
        onClick={() => { if (prompt) { proFlag.set(); copyText(prompt, (ok) => setCopied(ok ? "ok" : "fail")); } }} data-testid="pro-open">
        在 Claude App {review ? "檢視調整" : "建議建倉"}
      </a>
      {copied === "ok" && <div class="muted" style={{ fontSize: "12px" }} data-testid="pro-copied">已複製提問。Claude 沒有自動帶入的話，在輸入框長按「貼上」再送出。</div>}
      {copied === "fail" && <div class="muted" style={{ fontSize: "12px" }}>沒辦法自動複製提問，請再按一次。</div>}
      <label class="field">偵測不到時，手動貼上 Claude 的回覆
        <textarea rows={4} value={text} onInput={(e) => onText((e.target as HTMLTextAreaElement).value)} placeholder="在 Claude App 長按回覆 →「複製」，再貼到這裡" data-testid="pro-text" />
      </label>
      {err && <div class="error" data-testid="pro-err">{err}</div>}
      {text && <button class="linkbtn" style={{ alignSelf: "flex-start" }} onClick={() => onText("")} data-testid="pro-clear">清除重貼</button>}
      <button class="btn secondary block" disabled={!text.trim() || bad} onClick={save} data-testid="pro-save">儲存並整理（有付費版時一併比較）</button>
    </div>
  );
}

/** 候選股表：依產業分組，5 個窄欄位（股票、收盤、分數、月、外資張） */
export function CandidateTable({ candidates }: { candidates: Scored[] }) {
  const groups = groupBySector(candidates);
  const lots = (x: number | undefined) => (x === undefined ? "—" : `${x >= 0 ? "+" : ""}${Math.round(x / 1000).toLocaleString("en-US")}`);
  return (
    <table class="cand">
      <thead><tr><th>股票</th><th>收盤</th><th>分數</th><th>月</th><th>外資張</th></tr></thead>
      <tbody>
        {groups.map((g) => (
          <>
            <tr class="grp"><td colSpan={5}>{g.sector}</td></tr>
            {g.items.map((s) => (
              <tr>
                <td><span class="muted num">{s.code}</span> {s.name}</td>
                <td class="num">{fmtPrice(s.close)}</td>
                <td class="num">{s.score}</td>
                <td class={`num ${cls(s.ret1m)}`}>{fmtPct(s.ret1m, 1)}</td>
                <td class={`num ${cls(s.foreign5)}`}>{lots(s.foreign5)}</td>
              </tr>
            ))}
          </>
        ))}
      </tbody>
    </table>
  );
}

/** 候選股一覽：App 篩出、準備交給 Claude 的清單；純給你看，不用複製貼上 */
function CandidateCard() {
  const input = etfAdviceInput();
  const [open, setOpen] = useState(true);
  if (!input.candidates.length) return null;
  return (
    <div class="card stack" data-testid="candidates">
      <div class="row" style={{ justifyContent: "space-between" }}>
        <b>候選股一覽（{input.candidates.length} 檔）</b>
        <button class="linkbtn" onClick={() => setOpen(!open)}>{open ? "收起" : "展開"}</button>
      </div>
      {open && (
        <>
          <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>App 篩出的「買入」高分股，依產業分組、每產業最多 3 檔，已持有的不列；{input.minValue ? `只留當日成交金額 ≥ ${(input.minValue / 1e8).toFixed(1)} 億的大型股（全市場前一半）；` : ""}請 Claude 建議時就是用這份清單。</div>
          <CandidateTable candidates={input.candidates} />
        </>
      )}
    </div>
  );
}

/** 兩份建議逐檔並排 */
function CompareCard({ api, pro, fillFrom, apiAt, proAt }: { api: PlanItem[]; pro: PlanItem[]; fillFrom: "api" | "pro"; apiAt: number; proAt: number }) {
  const rows = comparePlans(api, pro);
  const same = rows.filter((r) => r.same).length;
  const cell = (x?: PlanItem) => x ? <span class={x.side === "buy" ? "up" : "down"}>{x.side === "buy" ? "買" : "賣"} {x.shares.toLocaleString()} 股</span> : <span class="muted">—</span>;
  const name = (c: string) => getState().prices[c]?.name ?? c;
  return (
    <div class="card stack" data-testid="plan-compare">
      <b>付費 API vs Claude Pro：{rows.length} 檔中 {same} 檔一致、{rows.length - same} 檔不同</b>
      <div class="muted" style={{ fontSize: "12px" }}>付費版 {fmtAt(apiAt)}・Pro 版 {fmtAt(proAt)}{Math.abs(apiAt - proAt) > 6 * 3600_000 ? "（兩份時間差很多，持股可能已經變了，比較時要注意）" : ""}</div>
      <table class="cmp">
        <thead><tr><th>股票</th><th>付費 API</th><th>Claude Pro</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr class={r.same ? "" : "diff"}>
              <td>{name(r.code)} <span class="muted num">{r.code}</span></td>
              <td class="num">{cell(r.api)}</td>
              <td class="num">{cell(r.pro)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="muted" style={{ fontSize: "12px" }}>底色標示的是兩邊不同的。「—」表示那一份沒有建議這檔。下面可以切換看兩份報告的理由。</div>
      <div class="seg" role="group">
        <button aria-pressed={fillFrom === "api"} onClick={() => setEtfFillFrom("api")}>照付費版下單</button>
        <button aria-pressed={fillFrom === "pro"} onClick={() => setEtfFillFrom("pro")} data-testid="fill-pro">照 Pro 版下單</button>
      </div>
    </div>
  );
}

/** 照 Claude 的清單填入實際成交 */
function PlanFill({ items, planKey, cash, stops, source, asOf }: { items: PlanItem[]; planKey: string; cash: number; stops: Record<string, number>; source: string; asOf?: string }) {
  const fitted = useMemo(() => fitBudget(items, etfPrice, cash), [items]);
  const [rows, setRows] = useState(() => fitted.map((it) => ({ ...it, keep: !!etfPrice(it.code), price: String(etfPrice(it.code) ?? ""), shares: String(it.shares), stopText: it.stop ? String(it.stop) : "" })));
  const [err, setErr] = useState("");
  const upd = (i: number, p: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const total = rows.filter((r) => r.keep).reduce((a, r) => a + (r.side === "buy" ? 1 : -1) * Number(r.shares) * Number(r.price), 0);
  const save = async () => {
    const ok = rows.filter((r) => r.keep);
    if (!ok.length) return setErr("請至少勾選一筆");
    if (ok.some((r) => !(Number(r.shares) > 0) || !(Number(r.price) > 0))) return setErr("股數和成交價都要大於 0");
    const today = taipeiToday();
    // 停損價：Claude 對「不動」持股給的，加上這次每筆買進填的
    const st = { ...stops };
    for (const r of ok) if (r.side === "buy" && Number(r.stopText) > 0) st[r.code] = Number(r.stopText);
    await addEtfTrades(ok.map((r) => ({ date: today, code: r.code, name: getState().prices[r.code]?.name ?? r.code, side: r.side, shares: Number(r.shares), price: Number(r.price) })), planKey, st);
  };
  return (
    <div class="card stack" data-testid="plan-fill">
      <b>照 {source} 的建議下單後，在這裡填入實際成交</b>
      {asOf && <div class="muted" style={{ fontSize: "12px" }}>預填的成交價是 {prettyW(asOf)} 收盤價，請改成你 {prettyW(orderDay(asOf))} 實際成交的價格。</div>}
      <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>已帶入建議股數與最新收盤價，請改成你實際的成交價與股數；沒買的取消勾選。{fitted.some((x, i) => x.shares !== items[i]?.shares) ? "（建議超過可用現金，股數已等比例調低）" : ""}</div>
      {rows.map((r, i) => (
        <div class="import-row" style={{ padding: "8px 0" }}>
          <label class="check"><input type="checkbox" checked={r.keep} onChange={(e) => upd(i, { keep: (e.target as HTMLInputElement).checked })} />
            <span class={r.side === "buy" ? "up" : "down"}>{r.side === "buy" ? "買進" : "賣出"}</span> {getState().prices[r.code]?.name ?? r.code} <span class="muted num">{r.code}</span>{r.side === "buy" && offListNow(r.code) && <OffTag />}</label>
          <label class="field">股數<input inputMode="numeric" value={r.shares} onInput={(e) => upd(i, { shares: (e.target as HTMLInputElement).value })} /></label>
          <label class="field">成交價<input inputMode="decimal" value={r.price} onInput={(e) => upd(i, { price: (e.target as HTMLInputElement).value })} /></label>
          {r.side === "buy" && <label class="field" style={{ gridColumn: "1 / -1" }}>停損價（跌破會提醒，空白＝成本 −10%）<input inputMode="decimal" value={r.stopText} onInput={(e) => upd(i, { stopText: (e.target as HTMLInputElement).value })} data-testid="plan-stop" /></label>}
          {r.reason && <div class="muted" style={{ gridColumn: "1 / -1", fontSize: "12px" }}>{r.reason}</div>}
        </div>
      ))}
      <div class="num" style={{ fontSize: "13px" }}>淨買進金額約 {fmtMoney(total)}（不含手續費）・可用現金 {fmtMoney(cash)}</div>
      {err && <div class="error">{err}</div>}
      <button class="btn block" onClick={save} data-testid="plan-save">我已照這樣成交，儲存</button>
    </div>
  );
}

/** 拍證券 App 的庫存畫面：Claude 辨識後和自組 ETF 對帳，補記買賣 */
function PhotoImport({ suggested, planKey }: { suggested: Set<string>; planKey?: string }) {
  const apiKey = useStore((s) => s.settings.apiKey);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [rows, setRows] = useState<(PhotoRow & { keep: boolean; sharesText: string; priceText: string })[] | null>(null);
  const [note, setNote] = useState("");

  const recognize = async (b64: string, type: "image/jpeg" | "image/png") => {
    setBusy(true); setErr(""); setRows(null);
    try {
      const r = await holdingsFromImage(apiKey, b64, type);
      await recordSpend(r.costUsd, "照片辨識");
      const tw = r.holdings.filter((h) => h.market !== "US");
      if (!tw.length) return setErr("照片裡沒有辨識到台股持股，請換一張清楚的庫存截圖");
      const diff = reconcilePhoto(getState().aiEtf, tw, etfPrice, suggested);
      if (!diff.length) return setErr("截圖和自組 ETF 的持股一樣，不用補記");
      setRows(diff.map((d) => ({ ...d, keep: d.suggested, sharesText: String(d.shares), priceText: d.price ? String(d.price) : "" })));
      setNote(r.note);
    } catch (e) { setErr(explainError(e)); }
    finally { setBusy(false); }
  };
  // 自動測試用：把產生的截圖直接送進同一套流程
  useEffect(() => {
    (window as any).__srEtfImportBase64 = (b64: string) => recognize(b64, "image/png");
    return () => { delete (window as any).__srEtfImportBase64; };
  });
  const onPhoto = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const img = await shrinkImage(file).catch(() => null);
    if (!img) return setErr("讀不到這張照片，請再試一次");
    await recognize(img.base64, img.mediaType);
  };
  const upd = (i: number, p: Partial<NonNullable<typeof rows>[number]>) => setRows(rows!.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const save = async () => {
    const ok = rows!.filter((r) => r.keep);
    if (!ok.length) return setErr("請至少勾選一筆");
    if (ok.some((r) => !(Number(r.sharesText) > 0) || !(Number(r.priceText) > 0))) return setErr("股數和成交價都要大於 0");
    const today = taipeiToday();
    const pending = planKey && getState().aiEtf.appliedKey !== planKey ? planKey : undefined;
    await addEtfTrades(ok.map((r) => ({ date: today, code: r.code, name: getState().prices[r.code]?.name ?? r.name, side: r.side, shares: Number(r.sharesText), price: Number(r.priceText) })), pending);
    setRows(null); setErr("");
  };

  return (
    <>
      <label class="btn secondary block" aria-disabled={busy || !apiKey}>
        {busy ? "Claude 辨識中…" : "拍照匯入成交（庫存截圖・API 付費）"}
        <input type="file" accept="image/*" hidden disabled={busy || !apiKey} onChange={onPhoto} data-testid="etf-photo" />
      </label>
      {err && <div class="error">{err}</div>}
      {rows && (
        <div class="card stack" data-testid="etf-photo-review">
          <b>和截圖對帳後，要補記這些成交</b>
          <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>
            多出來的股數記成買進、變少的記成賣出；成交價由截圖的平均成本推算，請對照證券 App 的成交紀錄修正。不在 Claude 建議裡的股票（可能是你其他的持股）預設不勾。截圖沒出現的股票不會自動賣出。
          </div>
          {note && <div class="muted" style={{ fontSize: "12px" }}>Claude 備註：{note}</div>}
          {rows.map((r, i) => (
            <div class="import-row" style={{ padding: "8px 0" }}>
              <label class="check"><input type="checkbox" checked={r.keep} onChange={(e) => upd(i, { keep: (e.target as HTMLInputElement).checked })} />
                <span class={r.side === "buy" ? "up" : "down"}>{r.side === "buy" ? "買進" : "賣出"}</span> {r.name} <span class="muted num">{r.code}</span>{!r.suggested && <span class="muted" style={{ fontSize: "12px" }}>（不在建議裡）</span>}</label>
              <label class="field">股數<input inputMode="numeric" value={r.sharesText} onInput={(e) => upd(i, { sharesText: (e.target as HTMLInputElement).value })} /></label>
              <label class="field">成交價<input inputMode="decimal" value={r.priceText} onInput={(e) => upd(i, { priceText: (e.target as HTMLInputElement).value })} /></label>
            </div>
          ))}
          <div class="row"><button class="btn" style={{ flex: 1 }} onClick={save} data-testid="etf-photo-save">儲存勾選的成交</button><button class="btn secondary" onClick={() => setRows(null)}>取消</button></div>
        </div>
      )}
    </>
  );
}

export interface SellDraft { code: string; shares: number; price?: number; n: number }

function ManualTrade({ draft }: { draft?: SellDraft }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState(""), [side, setSide] = useState<"buy" | "sell">("buy"), [shares, setShares] = useState(""), [price, setPrice] = useState("");
  const [err, setErr] = useState("");
  // 按持股列的「賣出」：打開表單，帶入代號、全部股數與現價，捲到表單
  useEffect(() => {
    if (!draft) return;
    setOpen(true); setSide("sell"); setCode(draft.code); setShares(String(draft.shares)); setPrice(draft.price ? String(draft.price) : ""); setErr("");
    setTimeout(() => document.querySelector('[data-testid="etf-trade-form"]')?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
  }, [draft?.n]);
  if (!open) return <button class="btn secondary block" onClick={() => { setSide("buy"); setCode(""); setShares(""); setPrice(""); setErr(""); setOpen(true); }}>手動新增一筆成交</button>;
  const save = async () => {
    const c = code.trim().toUpperCase();
    if (!c || !(Number(shares) > 0) || !(Number(price) > 0)) return setErr("請填代號、股數與成交價");
    const pos = positions(getState().aiEtf.trades).find((p) => p.code === c);
    const held = pos?.shares ?? 0;
    if (side === "sell" && Number(shares) > held) return setErr(held ? `你只有 ${held.toLocaleString()} 股，賣出股數不能超過` : "目前沒有這檔持股可以賣");
    await addEtfTrades([{ date: taipeiToday(), code: c, name: getState().prices[c]?.name ?? pos?.name ?? c, side, shares: Number(shares), price: Number(price) }]);
    setOpen(false); setCode(""); setShares(""); setPrice(""); setErr("");
  };
  return (
    <div class="card stack" data-testid="etf-trade-form">
      <div class="seg" role="group"><button aria-pressed={side === "buy"} onClick={() => setSide("buy")}>買進</button><button aria-pressed={side === "sell"} onClick={() => setSide("sell")}>賣出</button></div>
      <div class="formgrid">
        <label class="field">代號<input id="etf-code" value={code} onInput={(e) => { const v = (e.target as HTMLInputElement).value; setCode(v); const p = etfPrice(v.trim().toUpperCase()); if (p && !price) setPrice(String(p)); }} placeholder="例如 2330" /></label>
        <label class="field">股數<input id="etf-shares" inputMode="numeric" value={shares} onInput={(e) => setShares((e.target as HTMLInputElement).value)} /></label>
        <label class="field">成交價<input id="etf-price" inputMode="decimal" value={price} onInput={(e) => setPrice((e.target as HTMLInputElement).value)} /></label>
      </div>
      {side === "sell" && <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>在券商 App 賣掉之後，把實際成交的股數和價格填在這裡；這裡只是記錄，不會真的下單。</div>}
      {err && <div class="error">{err}</div>}
      <div class="row"><button class="btn" style={{ flex: 1 }} onClick={save} data-testid="etf-trade-save">儲存</button><button class="btn secondary" onClick={() => setOpen(false)}>取消</button></div>
    </div>
  );
}

/** 自組 ETF 分頁：Claude 虛擬操作（預設）／我的實單紀錄 */
export function AiEtfScreen() {
  const [mode, setMode] = useState<"virtual" | "real">(() => { try { return (localStorage.getItem("aietfMode") as "real") || "virtual"; } catch { return "virtual"; } });
  const pick = (m: "virtual" | "real") => { setMode(m); try { localStorage.setItem("aietfMode", m); } catch { /* 不重要 */ } };
  return (
    <div>
      <div class="seg" role="group" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", marginBottom: "10px" }}>
        <button aria-pressed={mode === "virtual"} onClick={() => pick("virtual")} data-testid="mode-virtual">Claude 虛擬操作</button>
        <button aria-pressed={mode === "real"} onClick={() => pick("real")} data-testid="mode-real">我的實單紀錄</button>
      </div>
      {mode === "virtual" ? <VirtualView /> : <RealEtfScreen />}
    </div>
  );
}

/** Claude 每個交易日自動操作的虛擬資金（唯讀） */
function VirtualView() {
  const vt = useStore((s) => s.virtual);
  const live = useStore((s) => s.live);
  const [busy, setBusy] = useState(false);
  const reload = async () => { setBusy(true); await refreshVirtual(); setBusy(false); };
  useEffect(() => { if (!vt || Date.now() - vt.fetchedAt > 10 * 60_000) reload(); }, []);
  // 即時價：打開時抓一次，交易時段每 30 秒更新
  const codes = vt ? [...positions(vt.data.trades).filter((p) => p.shares > 0).map((p) => p.code), ...vt.data.pending.map((o) => o.code), "0050"] : [];
  const codeKey = codes.join(",");
  useEffect(() => {
    if (!codes.length) return;
    refreshLive(codes);
    const t = setInterval(() => { if (marketOpen()) refreshLive(codes); }, 30_000);
    return () => clearInterval(t);
  }, [codeKey]);
  if (!vt) return <div class="empty">{busy ? "下載 Claude 的虛擬操作紀錄中…" : "還沒有下載到 Claude 的虛擬操作紀錄，請確認網路後按右上角重新整理。"}</div>;
  const v = vt.data;
  // 即時報價比 Claude 最後一次收盤更新還新，就用即時價（盤中＝現價，收盤後＝當天收盤）
  const fresh = (c: string): LiveQuote | undefined => { const q = live[c]; return q && q.date && q.date >= (v.asOf || v.start) ? q : undefined; };
  const px = (c: string) => fresh(c)?.price ?? v.last[c]?.close;
  const intraday = Object.values(live).find((q) => q.date === taipeiToday() && !q.final && codes.includes(q.code));
  const val = valuate(v, px);
  const tradePnl = tradePnls(v.trades, px);
  const pos = positions(v.trades).filter((p) => p.shares > 0);
  const nextDay = v.asOf ? orderDay(v.asOf) : undefined;
  const notes = [...v.notes].reverse();
  return (
    <div data-testid="virtual-view">
      <div class="card stack" data-testid="virtual-summary">
        <div class="row" style={{ justifyContent: "space-between" }}>
          <b>Claude 虛擬自組 ETF</b>
          <span class="muted" style={{ fontSize: "12px" }}>虛擬資金 {fmtMoney(v.budget)}・{pretty(v.start)} 開始</span>
        </div>
        <div class="grid2">
          <div class="metric"><div class="k">淨值（現金＋股票）</div><div class="v num">{fmtMoney(val.nav)}</div><div class={`d num ${cls(val.ret)}`}>報酬 {fmtPct(val.ret, 2)}<TotalPnl now={val.nav} budget={v.budget} /></div></div>
          <div class="metric"><div class="k">同樣的錢買 0050</div><div class="v num">{fmtMoney(val.bench)}</div><div class={`d num ${cls(val.benchRet)}`}>報酬 {fmtPct(val.benchRet, 2)}<TotalPnl now={val.bench} budget={v.budget} /></div></div>
        </div>
        <div style={{ fontSize: "14px" }}>
          {val.missing.length ? <span class="muted">收盤價更新後再比較輸贏</span> : val.ret >= val.benchRet ? <span class="up">贏過 0050 {fmtPct(val.ret - val.benchRet, 2)}</span> : <span class="down">落後 0050 {fmtPct(val.ret - val.benchRet, 2)}</span>}
          <span class="muted">・現金 {fmtMoney(val.cash)}・股票市值 {fmtMoney(val.marketValue)}</span>
        </div>
        {(() => {
          const b = beforeTopUp(v);
          return b && <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }} data-testid="virtual-topup">
            💰 {prettyW(b.date)} 起資金由 {fmtMoney(b.from)} 加到 {fmtMoney(b.to)}（加入的錢之前算閒置現金，所以上面的報酬率會被稀釋）。加碼前 {b.days} 天以 {fmtMoney(b.from)} 操作：組合 <span class={cls(b.ret)}>{fmtPct(b.ret, 2)}</span>、0050 <span class={cls(b.benchRet)}>{fmtPct(b.benchRet, 2)}</span>
          </div>;
        })()}
        {intraday && <div class="date-hint" data-testid="virtual-live">⏱ 盤中即時估算（{intraday.time.slice(0, 5)}），每 30 秒更新；收盤後改用收盤價</div>}
        <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>
          {v.asOf ? <>資料日 {prettyW(v.asOf)} 收盤・</> : <>今天收盤後第一次更新・</>}Claude 每個交易日收盤後自動更新（約 18:00）。虛擬成交規則：前一天收盤後下單，隔天買進以開盤價成交（開盤高於限價就等盤中碰到限價，沒碰到就不買），賣出以開盤價成交；已計手續費與證交稅。
        </div>
        {vt.error && <div class="muted" style={{ fontSize: "12px" }}>{vt.error}</div>}
        <button class="btn secondary" onClick={reload} disabled={busy} data-testid="virtual-reload">{busy ? "更新中…" : "重新下載最新紀錄"}</button>
      </div>

      <CashGauge plan={v.cashPlan} nav={val.nav} marketValue={val.marketValue} pendingNet={v.pending.reduce((t, o) => t + (o.side === "buy" ? 1 : -1) * o.shares * (o.limit ?? px(o.code) ?? 0), 0)} />

      {v.nav.length >= 2 && <><div class="section-title"><span>報酬走勢</span><span>{v.nav.length} 天</span></div><NavChart points={v.nav} budget={v.budget} mine="Claude 虛擬組合" /></>}

      {v.pending.length > 0 && (
        <div class="card stack" style={{ marginTop: "12px" }} data-testid="virtual-pending">
          <b>📅 {nextDay ? `${prettyW(nextDay)} ` : "下一個交易日"}預計操作</b>
          {v.pending.map((o) => (
            <div style={{ fontSize: "14px", lineHeight: 1.6 }}>
              <span class={o.side === "buy" ? "up" : "down"}>{o.side === "buy" ? "買進" : "賣出"}</span> <b>{o.name}</b> <span class="muted num">{o.code}</span> {o.shares.toLocaleString()} 股{o.limit ? `・限價 ${o.limit}` : "・開盤價"}
              <div class="muted" style={{ fontSize: "12px" }}>{o.reason}</div>
            </div>
          ))}
        </div>
      )}

      {pos.length > 0 && (
        <>
          <div class="section-title"><span>目前持股</span><span>{pos.length} 檔</span></div>
          <div class="list">
            {pos.map((p) => {
              const c = px(p.code);
              const q = fresh(p.code);
              const label = q && !q.final && q.date === taipeiToday() ? `現價 ${q.time.slice(0, 5)}` : "收盤";
              return (
                <div class="item" style={{ cursor: "default" }}>
                  <div style={{ minWidth: 0 }}>
                    <div class="name">{p.name} <span class="muted num" style={{ fontWeight: 400, fontSize: "13px" }}>{p.code}</span></div>
                    <div class="sub num" style={{ whiteSpace: "normal" }} data-testid="virtual-pos-line">{p.shares.toLocaleString()} 股・均價 {fmtPrice(p.avgCost)}・<TwdPnl shares={p.shares} avgCost={p.avgCost} price={c} /><span style={{ whiteSpace: "nowrap" }}>佔 {c ? `${((p.shares * c / val.nav) * 100).toFixed(1)}%` : "—"}</span></div>
                    {v.stops?.[p.code] && <div class="sub num">停損 {fmtPrice(v.stops[p.code])}</div>}
                  </div>
                  <div class="px">
                    <div class="p num" data-testid="virtual-price"><span class="lbl">{label}</span>{c ? fmtPrice(c) : "—"}</div>
                    {q && Number.isFinite(q.prevClose) && <div class={`num ${cls(q.price - q.prevClose)}`} style={{ fontSize: "12px" }}>今日 {fmtPct(q.price / q.prevClose - 1)}</div>}
                    <div class={`c num ${cls(c ? c - p.avgCost : 0)}`}><span class="lbl">損益</span>{c ? fmtPct(c / p.avgCost - 1) : "—"}</div>
                  </div>
                  <div />
                </div>
              );
            })}
          </div>
        </>
      )}

      {notes.length > 0 && (
        <>
          <div class="section-title"><span>Claude 每日操作說明</span><span>{prettyW(notes[0].date)}</span></div>
          <div class="card stack" data-testid="virtual-notes">
            <div style={{ fontSize: "14px", lineHeight: 1.7 }}>{notes[0].text}</div>
          </div>
        </>
      )}

      {v.trades.length > 0 && (
        <>
          <div class="section-title"><span>虛擬成交紀錄</span><span>{v.trades.length} 筆</span></div>
          <div class="card" style={{ padding: "6px 10px" }} data-testid="virtual-trades">
            {[...v.trades].reverse().map((t) => (
              <div class="row" style={{ justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--line)", fontSize: "13px" }}>
                <TradeLine t={t} pnl={tradePnl[t.id]} />
              </div>
            ))}
            {(v.cancelled ?? []).slice(-5).reverse().map((c) => (
              <div class="muted" style={{ padding: "6px 0", fontSize: "12px" }}>{pretty(c.date)} {c.name} 委託未成交：{c.reason}</div>
            ))}
          </div>
          <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6, marginTop: "6px" }}>{TRADE_HINT}</div>
        </>
      )}
      <div class="muted" style={{ fontSize: "11px", lineHeight: 1.6, marginTop: "12px" }}>這是 Claude 用虛擬資金的模擬操作，用來觀察建議的效果；不是真的下單，也不是投資建議。</div>
    </div>
  );
}

function RealEtfScreen() {
  const st = useStore((s) => ({ asOf: s.tw.asOf, etf: s.aiEtf, prices: s.prices, scored: s.tw.scored, reports: s.reports, jobs: s.aiJobs, apiKey: s.settings.apiKey, twReady: s.tw.status === "ready" }));
  const { etf } = st;
  const v = valuate(etf, etfPrice);
  const tradePnl = tradePnls(etf.trades, etfPrice);
  const pos = positions(etf.trades).filter((p) => p.shares > 0);
  const job = etf.planKey ? st.jobs[etf.planKey] : undefined;
  const busy = job?.status === "running";
  const plan = etf.planKey ? st.reports[etf.planKey] : undefined;
  const parsed = plan ? parsePlan(plan.text) : undefined;
  const pro = etf.proKey ? st.reports[etf.proKey] : undefined;
  const proParsed = pro ? parsePlan(pro.text) : undefined;
  // 要照哪一份填成交：選了 Pro 而且有 Pro 回覆就用 Pro，否則用付費 API 版
  const fillSrc: "api" | "pro" = (etf.fillFrom === "pro" && pro) || (!plan && pro) ? "pro" : "api";
  const fillKey = fillSrc === "pro" ? etf.proKey : etf.planKey;
  const fillParsed = fillSrc === "pro" ? proParsed : parsed;
  const showFill = !busy && !!fillParsed && fillParsed.items.length > 0 && etf.appliedKey !== fillKey;
  const [view, setView] = useState<"api" | "pro">("pro");
  const [budgetText, setBudgetText] = useState(String(etf.budget));
  const [editBudget, setEditBudget] = useState(false);
  const [sellDraft, setSellDraft] = useState<SellDraft | undefined>();
  useEffect(() => { if (st.twReady) snapshotEtfNav(); }, [st.twReady]);

  const ask = () => {
    if (!window.confirm(`請 Claude ${pos.length ? "檢視並調整" : "建議建倉"}，約花台幣 20～30 元，需要 2～4 分鐘。確定嗎？`)) return;
    startEtfAdvice();
  };

  const alerts = etfAlertsNow();

  return (
    <div>
      <ProResume />
      <AlertCard alerts={alerts} onAsk={ask} canAsk={!busy && !!st.apiKey && st.twReady} asOf={st.asOf} />
      <div class="card stack" data-testid="etf-summary">
        <div class="row" style={{ justifyContent: "space-between" }}>
          <b>我的自組 ETF</b>
          <span class="muted" style={{ fontSize: "12px" }}>起始資金 {fmtMoney(etf.budget)}</span>
        </div>
        <div class="grid2">
          <div class="metric"><div class="k">淨值（現金＋股票）</div><div class="v num">{fmtMoney(v.nav)}</div><div class={`d num ${cls(v.ret)}`}>報酬 {fmtPct(v.ret, 2)}<TotalPnl now={v.nav} budget={etf.budget} /></div></div>
          <div class="metric"><div class="k">同樣的錢買 0050</div><div class="v num">{fmtMoney(v.bench)}</div><div class={`d num ${cls(v.benchRet)}`}>報酬 {fmtPct(v.benchRet, 2)}<TotalPnl now={v.bench} budget={etf.budget} /></div></div>
        </div>
        {etf.trades.length > 0 && (
          <div style={{ fontSize: "14px" }}>
            {v.missing.length ? <span class="muted">價格更新後再比較輸贏</span> : v.ret >= v.benchRet ? <span class="up">贏過 0050 {fmtPct(v.ret - v.benchRet, 2)}</span> : <span class="down">落後 0050 {fmtPct(v.ret - v.benchRet, 2)}</span>}
            <span class="muted">・現金 {fmtMoney(v.cash)}・股票市值 {fmtMoney(v.marketValue)}</span>
          </div>
        )}
        {v.missing.length > 0 && <div class="muted" style={{ fontSize: "12px" }}>{v.missing.join("、")} 沒有最新價格，先用成本計算</div>}
        {v.cash < -1 && (
          <div class="error" data-testid="over-budget">
            實際買進的金額比起始資金多 {fmtMoney(-v.cash)}，現金變成負的，報酬率和佔比都會算錯。請把起始資金改成你實際投入的錢。
            <button class="btn block" style={{ marginTop: "8px" }} onClick={() => { const n = Math.ceil((etf.budget - v.cash) / 1000) * 1000; setBudgetText(String(n)); setEtfBudget(n); }} data-testid="fix-budget">
              起始資金改成 {fmtMoney(Math.ceil((etf.budget - v.cash) / 1000) * 1000)}
            </button>
          </div>
        )}
        {etf.trades.length > 0 && !editBudget && <button class="linkbtn" style={{ alignSelf: "flex-start" }} onClick={() => { setBudgetText(String(etf.budget)); setEditBudget(true); }}>修改起始資金 ✎</button>}
        {(!etf.trades.length || editBudget) && (
          <div class="row">
            <label class="field" style={{ flex: 1 }}>起始資金（元）<input inputMode="numeric" value={budgetText} onInput={(e) => setBudgetText((e.target as HTMLInputElement).value)} /></label>
            <button class="btn secondary" style={{ alignSelf: "flex-end" }} onClick={() => { const n = Number(budgetText.replace(/,/g, "")); if (n >= 1000) { setEtfBudget(n); setEditBudget(false); } }}>設定</button>
          </div>
        )}
        <div class="muted" style={{ fontSize: "11px", lineHeight: 1.6 }}>已估算手續費 0.1425% 與賣出證交稅 0.3%（未計券商折扣）。對照組：每次買賣時，用同樣金額買賣 0050。</div>
      </div>

      {etf.nav.length >= 2 && <><div class="section-title"><span>報酬走勢</span><span>{etf.nav.length} 天</span></div><NavChart points={etf.nav} budget={etf.budget} /></>}

      {pos.length > 0 && (
        <>
          <div class="section-title"><span>目前持股</span><span>{pos.length} 檔</span></div>
          <div class="list">
            {pos.map((p) => {
              const px = etfPrice(p.code);
              const mv = px ? p.shares * px : NaN;
              const rating = etfRating(p.code);
              return (
                <div class="item" style={{ cursor: "default" }}>
                  <div style={{ minWidth: 0 }}>
                    <div class="name">{p.name} <span class="muted num" style={{ fontWeight: 400, fontSize: "13px" }}>{p.code}</span></div>
                    <div class="sub num" style={{ whiteSpace: "normal" }}>{p.shares.toLocaleString()} 股・均價 {fmtPrice(p.avgCost)}・<TwdPnl shares={p.shares} avgCost={p.avgCost} price={px} /><span style={{ whiteSpace: "nowrap" }}>佔 {Number.isFinite(mv) ? `${((mv / v.nav) * 100).toFixed(1)}%` : "—"}</span></div>
                    <div class="sub row" style={{ gap: "8px" }}><StopEdit p={p} stops={etf.stops} /><button class="btn secondary mini" onClick={() => setSellDraft({ code: p.code, shares: p.shares, price: px, n: Date.now() })} data-testid={`sell-btn-${p.code}`}>賣出</button>{rating && <span class={`pill ${rating === "買入" ? "buy" : rating === "離場" ? "exit" : "hold"}`} style={{ fontSize: "11px" }}>App {rating}</span>}</div>
                  </div>
                  <div class="px">
                    <div class="p num"><span class="lbl">現價</span>{fmtPrice(px ?? NaN)}</div>
                    <div class={`c num ${cls(px ? px - p.avgCost : 0)}`}><span class="lbl">損益</span>{px ? fmtPct(px / p.avgCost - 1) : "—"}</div>
                  </div>
                  <div />
                </div>
              );
            })}
          </div>
        </>
      )}

      <div style={{ marginTop: "12px" }}><CandidateCard /></div>
      <div class="section-title"><span>Claude 建議</span>{(plan || pro) && <span>{fmtAt(Math.max(plan?.at ?? 0, pro?.at ?? 0))}</span>}</div>
      {job?.status === "error" && <div class="error">{job.error}</div>}
      {busy && <AiProgressView job={job!} />}
      {!busy && parsed && proParsed && <CompareCard api={parsed.items} pro={proParsed.items} fillFrom={fillSrc} apiAt={plan!.at} proAt={pro!.at} />}
      {!busy && (plan || pro) && (
        <>
          {plan && pro && (
            <div class="seg" role="group" style={{ margin: "10px 0" }}>
              <button aria-pressed={view === "api"} onClick={() => setView("api")}>付費 API 版報告</button>
              <button aria-pressed={view === "pro"} onClick={() => setView("pro")} data-testid="view-pro">Claude Pro 版報告</button>
            </div>
          )}
          {(view === "pro" || !plan) && pro && proParsed
            ? <><DateHint asOf={etf.proAsOf} latest={st.asOf} what="Claude Pro 版" /><AiReportView r={{ ...pro, text: proParsed.body }} /></>
            : plan && parsed && <><DateHint asOf={etf.planAsOf} latest={st.asOf} what="付費版" /><AiReportView r={{ ...plan, text: parsed.body }} /></>}
        </>
      )}
      {showFill && (
        <div style={{ marginTop: "10px" }}><PlanFill key={fillKey} items={fillParsed!.items} planKey={fillKey!} cash={v.cash} stops={fillParsed!.stops} source={fillSrc === "pro" ? "Claude Pro" : "Claude API"} asOf={fillSrc === "pro" ? etf.proAsOf : etf.planAsOf} /></div>
      )}
      {!busy && fillParsed && !fillParsed.items.length && <div class="notice" style={{ marginTop: "10px" }}>這份建議沒有要買賣（維持不變），或回覆最後沒有附上 JSON 清單。</div>}
      {!busy && !plan && !pro && (
        <div class="notice">Claude 會從今天的「買入」名單出發，上網查最近新聞、營收與外資報告，挑 4～8 檔、決定每檔買幾股（可買零股），控制在你的資金內並說明理由。之後可以隨時請 Claude 檢視調整。</div>
      )}
      <div class="stack" style={{ marginTop: "12px" }}>
        <button class="btn block" disabled={busy || !st.apiKey || !st.twReady} onClick={ask} data-testid="etf-ask">
          {busy ? "Claude 分析中，可以先去看別的…" : pos.length ? "請 Claude 檢視調整（API 付費）" : "請 Claude 建議建倉（API 付費）"}
        </button>
        {!st.apiKey && <div class="muted" style={{ fontSize: "13px", textAlign: "center" }}>先到「設定」貼上 Claude API 金鑰才能使用</div>}
        {st.apiKey && <BalanceHint />}
        <ProReview disabled={!st.twReady} review={pos.length > 0} />
        <PhotoImport suggested={new Set([...(parsed?.items ?? []), ...(proParsed?.items ?? [])].map((x) => x.code))} planKey={fillKey} />
        <ManualTrade draft={sellDraft} />
      </div>

      {etf.trades.length > 0 && (
        <>
          <div class="section-title"><span>成交紀錄</span><span>{etf.trades.filter((t) => !t.hidden).length} 筆</span></div>
          <div class="card" style={{ padding: "6px 10px" }} data-testid="etf-trades">
            {[...etf.trades].reverse().filter((t) => !t.hidden).map((t) => (
              <div class="row" style={{ justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--line)", fontSize: "13px", flexWrap: "nowrap" }}>
                <TradeLine t={t} pnl={tradePnl[t.id]} />
                <button class="iconbtn" style={{ width: "28px", height: "28px" }} aria-label="刪除這筆" onClick={() => window.confirm("把這一列從成交紀錄移除？\n\n只是不再顯示在列表，持股、現金和損益不會變。") && hideEtfTrade(t.id)} data-testid="trade-hide">✕</button>
              </div>
            ))}
          </div>
          <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6, marginTop: "6px" }}>{TRADE_HINT}　按 ✕ 只是把那一列從列表移除，上面的持股、現金和損益不會跟著變；要更正持股，請用持股的「賣出」或「手動新增一筆成交」。</div>
          <button class="btn danger block" style={{ marginTop: "12px" }} onClick={() => window.confirm("清空整個自組 ETF（成交紀錄與走勢）重新開始？") && resetAiEtf()}>清空重新開始</button>
        </>
      )}
      <p class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>自組 ETF 和「持股」分開記錄，專門用來檢驗照 Claude 建議操作的效果。以上為研究參考，非投資建議。</p>
    </div>
  );
}

