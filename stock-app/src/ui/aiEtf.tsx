// 「自組ETF」分頁：請 Claude 建議要買什麼、買幾股，照著實際下單後填入成交，追蹤淨值並和 0050 比較。
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  addEtfTrades, deleteEtfTrade, recordSpend, etfAlertsNow, etfPrice, findScored, getState, resetAiEtf, setEtfBudget, setEtfStop, snapshotEtfNav, startEtfAdvice, useStore,
} from "../store";
import { explainError, holdingsFromImage, shrinkImage } from "../ai/claude";
import { DEFAULT_STOP, fitBudget, parsePlan, positions, reconcilePhoto, stopOf, type PhotoRow, valuate, type EtfAlert, type PlanItem, type Position } from "../engine/aiEtf";
import { taipeiToday, pretty } from "../lib/dates";
import { cls, fmtMoney, fmtPct, fmtPrice } from "./common";
import { AiProgressView, AiReportView, BalanceHint } from "./screens";

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
function AlertCard({ alerts, onAsk, canAsk }: { alerts: EtfAlert[]; onAsk: () => void; canAsk: boolean }) {
  if (!alerts.length) return null;
  return (
    <div class="card stack alert-card" data-testid="etf-alerts">
      <b>⚠ 有 {new Set(alerts.map((a) => a.code)).size} 檔需要注意</b>
      {alerts.map((a) => (
        <div style={{ fontSize: "14px", lineHeight: 1.6 }}>
          <b>{a.name}</b> <span class="muted num" style={{ marginRight: "8px" }}>{a.code}</span>
          {a.kind === "stop"
            ? <>現價 <span class="num down">{fmtPrice(a.price!)}</span> 跌破停損價 <span class="num">{fmtPrice(a.stop!)}</span>{a.isDefault ? `（預設成本 −${DEFAULT_STOP * 100}%）` : ""}</>
            : <>App 今天評為<span class="down">「離場」</span>（動能或籌碼轉弱）</>}
        </div>
      ))}
      <div class="muted" style={{ fontSize: "12px" }}>這是 App 自動比對的免費提醒，不代表一定要賣。可以請 Claude 檢視後再決定。</div>
      {canAsk && <button class="btn block" onClick={onAsk}>請 Claude 檢視調整</button>}
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

/** 照 Claude 的清單填入實際成交 */
function PlanFill({ items, planKey, cash, stops }: { items: PlanItem[]; planKey: string; cash: number; stops: Record<string, number> }) {
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
      <b>照 Claude 的建議下單後，在這裡填入實際成交</b>
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
        {busy ? "Claude 辨識中…" : "拍照匯入成交（證券 App 庫存截圖）"}
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
  const st = useStore((s) => ({ etf: s.aiEtf, prices: s.prices, scored: s.tw.scored, reports: s.reports, jobs: s.aiJobs, apiKey: s.settings.apiKey, twReady: s.tw.status === "ready" }));
  const { etf } = st;
  const v = valuate(etf, etfPrice);
  const pos = positions(etf.trades).filter((p) => p.shares > 0);
  const job = etf.planKey ? st.jobs[etf.planKey] : undefined;
  const busy = job?.status === "running";
  const plan = etf.planKey ? st.reports[etf.planKey] : undefined;
  const parsed = plan ? parsePlan(plan.text) : undefined;
  const [budgetText, setBudgetText] = useState(String(etf.budget));
  useEffect(() => { if (st.twReady) snapshotEtfNav(); }, [st.twReady]);

  const ask = () => {
    if (!window.confirm(`請 Claude ${pos.length ? "檢視並調整" : "建議建倉"}，約花台幣 20～30 元，需要 2～4 分鐘。確定嗎？`)) return;
    startEtfAdvice();
  };

  const alerts = etfAlertsNow();

  return (
    <div>
      <AlertCard alerts={alerts} onAsk={ask} canAsk={!busy && !!st.apiKey && st.twReady} />
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
        {!etf.trades.length && (
          <div class="row">
            <label class="field" style={{ flex: 1 }}>起始資金（元）<input inputMode="numeric" value={budgetText} onInput={(e) => setBudgetText((e.target as HTMLInputElement).value)} /></label>
            <button class="btn secondary" style={{ alignSelf: "flex-end" }} onClick={() => { const n = Number(budgetText.replace(/,/g, "")); if (n >= 1000) setEtfBudget(n); }}>設定</button>
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
              const rating = findScored(p.code, "TW")?.rating;
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

      <div class="section-title"><span>Claude 建議（付費）</span>{plan && <span>{new Date(plan.at).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>}</div>
      {job?.status === "error" && <div class="error">{job.error}</div>}
      {busy && <AiProgressView job={job!} />}
      {!busy && plan && parsed && <AiReportView r={{ ...plan, text: parsed.body }} />}
      {!busy && plan && parsed && parsed.items.length > 0 && etf.appliedKey !== etf.planKey && (
        <div style={{ marginTop: "10px" }}><PlanFill key={etf.planKey} items={parsed.items} planKey={etf.planKey!} cash={v.cash} stops={parsed.stops} /></div>
      )}
      {!busy && plan && parsed && !parsed.items.length && <div class="notice" style={{ marginTop: "10px" }}>這次 Claude 沒有建議買賣（維持不變），或回覆裡沒有清單。</div>}
      {!busy && !plan && (
        <div class="notice">Claude 會從今天的「買入」名單出發，上網查最近新聞、營收與外資報告，挑 4～8 檔、決定每檔買幾股（可買零股），控制在你的資金內並說明理由。之後可以隨時請 Claude 檢視調整。</div>
      )}
      <div class="stack" style={{ marginTop: "12px" }}>
        <button class="btn block" disabled={busy || !st.apiKey || !st.twReady} onClick={ask} data-testid="etf-ask">
          {busy ? "Claude 分析中，可以先去看別的…" : pos.length ? "請 Claude 檢視調整" : "請 Claude 建議建倉"}
        </button>
        {!st.apiKey && <div class="muted" style={{ fontSize: "13px", textAlign: "center" }}>先到「設定」貼上 Claude API 金鑰才能使用</div>}
        {st.apiKey && <BalanceHint />}
        <PhotoImport suggested={new Set(parsed?.items.map((x) => x.code) ?? [])} planKey={etf.planKey} />
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

