// 「自組ETF」分頁：請 Claude 建議要買什麼、買幾股，照著實際下單後填入成交，追蹤淨值並和 0050 比較。
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  addEtfTrades, deleteEtfTrade, etfAdviceInput, etfRating, recordSpend, saveProReply, setEtfFillFrom, etfAlertsNow, etfPrice, getState, resetAiEtf, setEtfBudget, setEtfStop, snapshotEtfNav, startEtfAdvice, useStore,
} from "../store";
import { aiEtfPrompt, claudeAppUrl, explainError, holdingsFromImage, shrinkImage } from "../ai/claude";
import { comparePlans, DEFAULT_STOP, fitBudget, parsePlan, positions, reconcilePhoto, stopOf, type PhotoRow, valuate, type EtfAlert, type PlanItem, type Position } from "../engine/aiEtf";
import { orderDay, pretty, prettyW, taipeiToday } from "../lib/dates";
import { cls, fmtMoney, fmtPct, fmtPrice } from "./common";
import { AiProgressView, AiReportView, BalanceHint, copyText } from "./screens";

/** 兩條線：我的組合 vs 0050（報酬率 %） */
function NavChart({ points }: { points: { date: string; nav: number; bench: number }[]; }) {
  const budget = useStore((s) => s.aiEtf.budget);
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
        <span><b style={{ color: "var(--accent)" }}>━</b> 我的自組 ETF</span><span class="muted">━ 同樣的錢買 0050</span>
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

/** 用 Claude App（Pro 訂閱）檢視：帶同一份數據與提問過去，回覆貼回來比較，不扣 API 額度 */
function ProReview({ disabled, review }: { disabled: boolean; review: boolean }) {
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const prompt = disabled ? "" : aiEtfPrompt(etfAdviceInput(), true);
  const save = async () => {
    if (text.trim().length < 20) return setErr("請把 Claude App 的整段回覆貼上來");
    if (!parsePlan(text).items.length && !/維持不變/.test(text)) setErr("回覆最後沒有找到 JSON 買賣清單，仍會存下文字；可以請 Claude 補上 JSON 區塊再貼一次");
    else setErr("");
    await saveProReply(text);
    setText("");
  };
  return (
    <div class="card stack" data-testid="pro-review">
      <b>用 Claude Pro 檢視（免費，用你的訂閱）</b>
      <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>
        會打開 Claude App，帶入和付費版完全相同的數據與提問。Claude 回答完，長按複製整段回覆，回來貼在下面，App 會和付費版逐檔比較。
      </div>
      <a class="btn secondary block" aria-disabled={disabled} href={prompt ? claudeAppUrl(prompt) : undefined} target="_blank" rel="noreferrer"
        onClick={() => prompt && copyText(prompt, (ok) => setCopied(ok ? "ok" : "fail"))} data-testid="pro-open">
        在 Claude App {review ? "檢視調整" : "建議建倉"}
      </a>
      {copied === "ok" && <div class="muted" style={{ fontSize: "12px" }} data-testid="pro-copied">已複製提問。Claude 沒有自動帶入的話，在輸入框長按「貼上」再送出。</div>}
      {copied === "fail" && <div class="muted" style={{ fontSize: "12px" }}>沒辦法自動複製提問，請再按一次。</div>}
      <label class="field">貼上 Claude App 的回覆
        <textarea rows={4} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} placeholder="在 Claude App 長按回覆 →「複製」，再貼到這裡" data-testid="pro-text" />
      </label>
      {err && <div class="error">{err}</div>}
      <button class="btn secondary block" disabled={!text.trim()} onClick={save} data-testid="pro-save">儲存並和付費版比較</button>
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
            <span class={r.side === "buy" ? "up" : "down"}>{r.side === "buy" ? "買進" : "賣出"}</span> {getState().prices[r.code]?.name ?? r.code} <span class="muted num">{r.code}</span></label>
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

function ManualTrade() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState(""), [side, setSide] = useState<"buy" | "sell">("buy"), [shares, setShares] = useState(""), [price, setPrice] = useState("");
  const [err, setErr] = useState("");
  if (!open) return <button class="btn secondary block" onClick={() => setOpen(true)}>手動新增一筆成交</button>;
  const save = async () => {
    const c = code.trim().toUpperCase();
    if (!c || !(Number(shares) > 0) || !(Number(price) > 0)) return setErr("請填代號、股數與成交價");
    await addEtfTrades([{ date: taipeiToday(), code: c, name: getState().prices[c]?.name ?? c, side, shares: Number(shares), price: Number(price) }]);
    setOpen(false); setCode(""); setShares(""); setPrice(""); setErr("");
  };
  return (
    <div class="card stack">
      <div class="seg" role="group"><button aria-pressed={side === "buy"} onClick={() => setSide("buy")}>買進</button><button aria-pressed={side === "sell"} onClick={() => setSide("sell")}>賣出</button></div>
      <div class="formgrid">
        <label class="field">代號<input id="etf-code" value={code} onInput={(e) => { const v = (e.target as HTMLInputElement).value; setCode(v); const p = etfPrice(v.trim().toUpperCase()); if (p && !price) setPrice(String(p)); }} placeholder="例如 2330" /></label>
        <label class="field">股數<input id="etf-shares" inputMode="numeric" value={shares} onInput={(e) => setShares((e.target as HTMLInputElement).value)} /></label>
        <label class="field">成交價<input id="etf-price" inputMode="decimal" value={price} onInput={(e) => setPrice((e.target as HTMLInputElement).value)} /></label>
      </div>
      {err && <div class="error">{err}</div>}
      <div class="row"><button class="btn" style={{ flex: 1 }} onClick={save} data-testid="etf-trade-save">儲存</button><button class="btn secondary" onClick={() => setOpen(false)}>取消</button></div>
    </div>
  );
}

export function AiEtfScreen() {
  const st = useStore((s) => ({ asOf: s.tw.asOf, etf: s.aiEtf, prices: s.prices, scored: s.tw.scored, reports: s.reports, jobs: s.aiJobs, apiKey: s.settings.apiKey, twReady: s.tw.status === "ready" }));
  const { etf } = st;
  const v = valuate(etf, etfPrice);
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
  useEffect(() => { if (st.twReady) snapshotEtfNav(); }, [st.twReady]);

  const ask = () => {
    if (!window.confirm(`請 Claude ${pos.length ? "檢視並調整" : "建議建倉"}，約花台幣 20～30 元，需要 2～4 分鐘。確定嗎？`)) return;
    startEtfAdvice();
  };

  const alerts = etfAlertsNow();

  return (
    <div>
      <AlertCard alerts={alerts} onAsk={ask} canAsk={!busy && !!st.apiKey && st.twReady} asOf={st.asOf} />
      <div class="card stack" data-testid="etf-summary">
        <div class="row" style={{ justifyContent: "space-between" }}>
          <b>我的自組 ETF</b>
          <span class="muted" style={{ fontSize: "12px" }}>起始資金 {fmtMoney(etf.budget)}</span>
        </div>
        <div class="grid2">
          <div class="metric"><div class="k">淨值（現金＋股票）</div><div class="v num">{fmtMoney(v.nav)}</div><div class={`d num ${cls(v.ret)}`}>報酬 {fmtPct(v.ret, 2)}</div></div>
          <div class="metric"><div class="k">同樣的錢買 0050</div><div class="v num">{fmtMoney(v.bench)}</div><div class={`d num ${cls(v.benchRet)}`}>報酬 {fmtPct(v.benchRet, 2)}</div></div>
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

      {etf.nav.length >= 2 && <><div class="section-title"><span>報酬走勢</span><span>{etf.nav.length} 天</span></div><NavChart points={etf.nav} /></>}

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
                    <div class="sub num">{p.shares.toLocaleString()} 股・均價 {fmtPrice(p.avgCost)}・佔 {Number.isFinite(mv) ? `${((mv / v.nav) * 100).toFixed(1)}%` : "—"}</div>
                    <div class="sub row" style={{ gap: "8px" }}><StopEdit p={p} stops={etf.stops} />{rating && <span class={`pill ${rating === "買入" ? "buy" : rating === "離場" ? "exit" : "hold"}`} style={{ fontSize: "11px" }}>App {rating}</span>}</div>
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
        <ManualTrade />
      </div>

      {etf.trades.length > 0 && (
        <>
          <div class="section-title"><span>成交紀錄</span><span>{etf.trades.length} 筆</span></div>
          <div class="card" style={{ padding: "6px 10px" }}>
            {[...etf.trades].reverse().map((t) => (
              <div class="row" style={{ justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--line)", fontSize: "13px", flexWrap: "nowrap" }}>
                <span class="num">{pretty(t.date)} <span class={t.side === "buy" ? "up" : "down"}>{t.side === "buy" ? "買" : "賣"}</span> {t.name} {t.shares.toLocaleString()} 股 @ {fmtPrice(t.price)}</span>
                <button class="iconbtn" style={{ width: "28px", height: "28px" }} aria-label="刪除這筆" onClick={() => window.confirm("刪除這筆成交紀錄？") && deleteEtfTrade(t.id)}>✕</button>
              </div>
            ))}
          </div>
          <button class="btn danger block" style={{ marginTop: "12px" }} onClick={() => window.confirm("清空整個自組 ETF（成交紀錄與走勢）重新開始？") && resetAiEtf()}>清空重新開始</button>
        </>
      )}
      <p class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>自組 ETF 和「持股」分開記錄，專門用來檢驗照 Claude 建議操作的效果。以上為研究參考，非投資建議。</p>
    </div>
  );
}

