import { useEffect, useMemo, useState } from "preact/hooks";
import {
  findScored, getFetcher, getKv, getState, holdingViews, refreshMacro, refreshTw, refreshUs, saveHoldings, saveReport,
  saveSettings, clearCache, useStore, usBars, type Market,
} from "../store";
import type { Holding, Rating, Scored, SectorStat } from "../engine/score";
import { analyzeStock, client, explainError, holdingsFromImage, marketBrief, shrinkImage, MODEL, type ImportedHolding } from "../ai/claude";
import { twHistory } from "../data/history";
import { MACRO_SYMBOLS } from "../data/us";
import { pretty, taipeiToday } from "../lib/dates";
import { cls, fmtMoney, fmtPct, fmtPrice, lots, Markdown, PriceChart, Progress, RatingPill, Sheet } from "./common";

// ---------------- 選股 ----------------
export function PicksScreen({ market, setMarket, sector, setSector, open }: {
  market: Market; setMarket: (m: Market) => void; sector: string; setSector: (s: string) => void; open: (s: Scored) => void;
}) {
  const ms = useStore((s) => (market === "TW" ? s.tw : s.us));
  const [filter, setFilter] = useState<Rating | "全部">("買入");
  const [q, setQ] = useState("");
  const counts = useMemo(() => {
    const c: Record<string, number> = { 全部: ms.scored.length, 買入: 0, 觀望: 0, 離場: 0 };
    for (const s of ms.scored) c[s.rating]++;
    return c;
  }, [ms.scored]);
  const list = useMemo(() => {
    const t = q.trim().toUpperCase();
    return ms.scored.filter((s) =>
      (filter === "全部" || s.rating === filter) && (!sector || s.sector === sector) &&
      (!t || s.code.toUpperCase().includes(t) || s.name.toUpperCase().includes(t)));
  }, [ms.scored, filter, q, sector]);

  return (
    <div>
      <div class="row" style={{ justifyContent: "space-between" }}>
        <MarketSeg market={market} setMarket={setMarket} />
        <input class="search" type="search" placeholder="代號或名稱" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="搜尋股票" />
      </div>
      <div class="chips" style={{ marginTop: "10px" }} role="group" aria-label="評等篩選">
        {(["買入", "觀望", "離場", "全部"] as const).map((f) => (
          <button class="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f} {counts[f] ?? 0}</button>
        ))}
        {sector && <button class="chip" aria-pressed="true" onClick={() => setSector("")}>{sector} ✕</button>}
      </div>
      {ms.error && <div class="error" style={{ marginTop: "10px" }}>{ms.error}</div>}
      {ms.status === "loading" && <Progress p={ms.progress} />}
      {ms.status === "error" && <div class="empty">資料下載失敗，請檢查網路後按右上角重新整理</div>}
      {ms.status === "ready" && (
        <>
          <div class="section-title">
            <span>{filter === "全部" ? "全部股票" : `評等「${filter}」`}・依分數排序</span>
            <span>{list.length} 檔</span>
          </div>
          {list.length === 0 ? (
            <div class="empty">
              {filter === "買入" && !q && !sector ? <>今天沒有股票同時符合「分數 70 以上、外資買超、一週漲幅未過熱」。<br /><button class="chip" style={{ marginTop: "10px" }} onClick={() => setFilter("觀望")}>看「觀望」名單</button></> : "沒有符合的股票"}
            </div>
          ) : (
            <div class="list">
              {list.slice(0, 150).map((s) => <StockRow s={s} onClick={() => open(s)} />)}
            </div>
          )}
          <p class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>
            {market === "TW"
              ? "分數 = 動能 40%（近1週/1月/3月漲幅排名）＋ 外資籌碼 40%（5 日買超佔成交比重、連買天數、投信）＋ 族群強弱 20%。只列當日成交金額 5 千萬以上的股票。"
              : "分數 = 動能 40% ＋ 趨勢 40%（50 日均線、20/50 日均線排列、相對 S&P 500）＋ 產業強弱 20%。美股沒有外資資料。"}
          </p>
        </>
      )}
    </div>
  );
}

function MarketSeg({ market, setMarket }: { market: Market; setMarket: (m: Market) => void }) {
  return (
    <div class="seg" role="group" aria-label="市場">
      <button aria-pressed={market === "TW"} onClick={() => setMarket("TW")}>台股</button>
      <button aria-pressed={market === "US"} onClick={() => setMarket("US")}>美股</button>
    </div>
  );
}

function StockRow({ s, onClick }: { s: Scored; onClick: () => void }) {
  return (
    <button class="item" onClick={onClick}>
      <div style={{ minWidth: 0 }}>
        <div class="name">{s.name} <span class="muted num" style={{ fontWeight: 400, fontSize: "13px" }}>{s.code}</span></div>
        <div class="sub">
          {s.sector}
          {s.market !== "US" ? <>・外資5日 <span class={cls(s.foreign5)}>{lots(s.foreign5)}</span></> : <>・相對大盤 <span class={cls(s.rsVsIndex1m)}>{fmtPct(s.rsVsIndex1m)}</span></>}
        </div>
      </div>
      <div class="px">
        <div class="p num">{fmtPrice(s.close, s.market)}</div>
        <div class={`c num ${cls(s.ret1m)}`}>月 {fmtPct(s.ret1m)}</div>
      </div>
      <div>
        <RatingPill rating={s.rating} />
        <div class="score num">{s.score} 分</div>
      </div>
    </button>
  );
}

// ---------------- 族群 ----------------
export function SectorsScreen({ market, setMarket, pick }: { market: Market; setMarket: (m: Market) => void; pick: (s: string) => void }) {
  const ms = useStore((s) => (market === "TW" ? s.tw : s.us));
  const rising = ms.sectors.filter((s) => s.rotation === "轉強");
  return (
    <div>
      <MarketSeg market={market} setMarket={setMarket} />
      {ms.status === "loading" && <Progress p={ms.progress} />}
      {ms.status === "ready" && (
        <>
          <div class="section-title"><span>輪動訊號</span></div>
          <div class="card" style={{ lineHeight: 1.7 }}>
            {rising.length
              ? <>資金轉進：{rising.map((s) => <b class="up">{s.sector} </b>)}（近 1 週排名前段，但近 1 月還在後段）</>
              : "目前沒有明顯轉強的族群"}
            <div class="muted" style={{ fontSize: "13px" }}>
              最強：{ms.sectors.slice(0, 3).map((s) => s.sector).join("、")}；最弱：{ms.sectors.slice(-3).reverse().map((s) => s.sector).join("、")}
            </div>
          </div>
          <div class="section-title"><span>{market === "TW" ? "產業強弱（中位數報酬）" : "產業強弱"}</span><span>點一下看個股</span></div>
          <div class="card scroll-x" style={{ padding: "4px 8px" }}>
            <table class="sectors">
              <thead><tr><th>族群</th><th>訊號</th><th>近1週</th><th>近1月</th>{market === "TW" && <th>外資5日</th>}<th>上漲比</th></tr></thead>
              <tbody>
                {ms.sectors.map((s: SectorStat) => (
                  <tr onClick={() => pick(s.sector)}>
                    <td><b>{s.sector}</b> <span class="muted num" style={{ fontSize: "11px" }}>{s.count}</span></td>
                    <td><span class={`tag ${s.rotation}`}>{s.rotation}</span></td>
                    <td class={`num ${cls(s.ret1w)}`}>{fmtPct(s.ret1w)}</td>
                    <td class={`num ${cls(s.ret1m)}`}>{fmtPct(s.ret1m)}</td>
                    {market === "TW" && <td class={`num ${cls(s.foreignValue5)}`}>{fmtMoney(s.foreignValue5)}</td>}
                    <td class="num">{Math.round(s.breadth * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>
            轉強＝近1週排名前 1/3 但近1月不在前 1/3；強勢延續＝兩者都在前 1/3；轉弱＝近1週掉到後 1/3 但近1月在前 1/3。
          </p>
        </>
      )}
    </div>
  );
}

// ---------------- 個股詳細 ----------------
export function StockDetail({ s, onClose }: { s: Scored; onClose: () => void }) {
  const { holdings, apiKey, reports } = useStore((st) => ({ holdings: st.holdings, apiKey: st.settings.apiKey, reports: st.reports }));
  const [bars, setBars] = useState<{ date: string; close: number; volume: number }[] | null>(null);
  const [barsErr, setBarsErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiErr, setAiErr] = useState("");
  const [adding, setAdding] = useState(false);
  const holding = holdings.find((h) => h.code === s.code);
  const today = taipeiToday();
  const reportKey = `stock:${s.code}:${today}`;
  const report = reports[reportKey];

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const b = s.market === "US" ? await usBars(s.code) : await twHistory(getFetcher(), getKv(), s.code, s.market, 6);
        if (alive) setBars(b.slice(-130));
      } catch (e: any) { if (alive) setBarsErr(`走勢圖下載失敗：${e?.message ?? e}`); }
    })();
    return () => { alive = false; };
  }, [s.code]);

  const runAi = async () => {
    setBusy(true); setAiErr("");
    try { await saveReport(reportKey, await analyzeStock(apiKey, s, today, holding)); }
    catch (e) { setAiErr(explainError(e)); }
    finally { setBusy(false); }
  };

  return (
    <Sheet title={`${s.name} ${s.code}`} onClose={onClose}>
      <div class="hero">
        <div>
          <div class="price num">{fmtPrice(s.close, s.market)}</div>
          <div class="muted" style={{ marginTop: "6px", fontSize: "13px" }}>{s.sector}・{s.market === "US" ? "美股" : s.market === "TPEX" ? "上櫃" : "上市"}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <RatingPill rating={s.rating} />
          <div class="num" style={{ fontSize: "26px", fontWeight: 800, marginTop: "6px" }}>{s.score}<span class="muted" style={{ fontSize: "13px" }}> / 100</span></div>
        </div>
      </div>

      <div class="grid2" style={{ marginTop: "14px" }}>
        <Metric k="近 1 週" v={fmtPct(s.ret1w)} c={cls(s.ret1w)} />
        <Metric k="近 1 月" v={fmtPct(s.ret1m)} c={cls(s.ret1m)} />
        <Metric k="近 3 月" v={fmtPct(s.ret3m)} c={cls(s.ret3m)} />
        {s.market === "US"
          ? <Metric k="相對 S&P 500（1月）" v={fmtPct(s.rsVsIndex1m)} c={cls(s.rsVsIndex1m)} />
          : <Metric k="外資近 5 日" v={lots(s.foreign5)} c={cls(s.foreign5)} d={s.foreignStreak ? `${s.foreignStreak > 0 ? "連買" : "連賣"} ${Math.abs(s.foreignStreak)} 天` : ""} />}
        {s.market !== "US" && <Metric k="投信近 5 日" v={lots(s.trust5)} c={cls(s.trust5)} />}
        {s.market !== "US" && <Metric k="外資近 10 日" v={lots(s.foreign10)} c={cls(s.foreign10)} />}
      </div>

      <div class="section-title"><span>近 6 個月走勢</span></div>
      <div class="card">
        {bars ? (bars.length > 1 ? <PriceChart bars={bars} /> : <div class="empty">沒有走勢資料</div>) : barsErr ? <div class="error">{barsErr}</div> : <div class="empty">載入中…</div>}
      </div>

      <div class="section-title"><span>評等理由</span><span>動能 {Math.round(s.momentum * 100)}・{s.market === "US" ? "趨勢" : "籌碼"} {Math.round(s.flow * 100)}・族群 {Math.round(s.sectorScore * 100)}</span></div>
      <div class="card"><ul class="reasons">{s.reasons.map((r) => <li>{r}</li>)}</ul></div>

      {holding && (
        <>
          <div class="section-title"><span>我的持股</span></div>
          <div class="card num">{holding.shares.toLocaleString()} 股・成本 {fmtPrice(holding.cost, s.market)}・損益 <span class={cls(s.close - holding.cost)}>{fmtMoney((s.close - holding.cost) * holding.shares, s.market)}（{fmtPct(s.close / holding.cost - 1)}）</span></div>
        </>
      )}

      <div class="section-title"><span>AI 深度解析</span>{report && <span>{new Date(report.at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })} 更新</span>}</div>
      {aiErr && <div class="error">{aiErr}</div>}
      {report ? <AiReportView r={report} /> : (
        <div class="notice">
          Claude 會搜尋這檔股票最近的新聞、法說會與國內外經濟數據發表，搭配上面的籌碼數據寫成解析，並給出評等。每次約 1~2 分鐘、花費約台幣 3~8 元。
        </div>
      )}
      <div class="stack" style={{ marginTop: "12px" }}>
        <button class="btn block" disabled={busy || !apiKey} onClick={runAi}>
          {busy ? "Claude 分析中（約 1~2 分鐘）…" : report ? "重新解析" : "AI 深度解析"}
        </button>
        {!apiKey && <div class="muted" style={{ fontSize: "13px", textAlign: "center" }}>先到「設定」貼上 Claude API 金鑰才能使用</div>}
        {!holding && <button class="btn secondary block" onClick={() => setAdding(true)}>加入我的持股</button>}
      </div>
      {adding && <HoldingForm initial={{ code: s.code, name: s.name, market: s.market, shares: 1000, cost: s.close }} onDone={() => setAdding(false)} />}
    </Sheet>
  );
}

function Metric({ k, v, c = "", d = "" }: { k: string; v: string; c?: string; d?: string }) {
  return <div class="metric"><div class="k">{k}</div><div class={`v num ${c}`}>{v}</div>{d && <div class="d muted">{d}</div>}</div>;
}

function AiReportView({ r }: { r: { text: string; sources: { title: string; url: string }[]; model: string } }) {
  const m = /^\s*\**評等\**\s*[:：]\s*\**\s*(買入|觀望|離場)/.exec(r.text);
  const body = m ? r.text.slice(r.text.indexOf("\n") + 1) : r.text;
  return (
    <div class="card">
      {m && <div class="ai-rating">Claude 評等 <RatingPill rating={m[1] as Rating} /></div>}
      <Markdown text={body} />
      {r.sources.length > 0 && (
        <>
          <div class="section-title" style={{ marginTop: "8px" }}><span>資料來源</span></div>
          <ol class="sources">{r.sources.map((x) => <li><a href={x.url} target="_blank" rel="noreferrer">{x.title}</a></li>)}</ol>
        </>
      )}
      <div class="muted" style={{ fontSize: "11px", marginTop: "8px" }}>由 {r.model} 產生，僅供研究參考，非投資建議</div>
    </div>
  );
}

// ---------------- 持股 ----------------
export function HoldingsScreen({ open }: { open: (s: Scored) => void }) {
  useStore((s) => [s.holdings, s.tw.scored, s.us.scored]);
  const apiKey = useStore((s) => s.settings.apiKey);
  const views = holdingViews();
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState<{ rows: ImportedHolding[]; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const total = (m: "TW" | "US") => {
    const vs = views.filter((v) => (m === "US") === (v.market === "US") && Number.isFinite(v.price));
    return { value: vs.reduce((a, v) => a + v.price * v.shares, 0), pnl: vs.reduce((a, v) => a + v.pnl, 0), cost: vs.reduce((a, v) => a + v.cost * v.shares, 0) };
  };
  const tw = total("TW"), us = total("US");

  // 自動測試用：讓測試程式把產生的截圖直接送進同一套辨識流程（手機上一般不會用到）
  useEffect(() => {
    (window as any).__srImportBase64 = async (b64: string) => {
      setBusy(true); setErr("");
      try {
        const r = await holdingsFromImage(getState().settings.apiKey, b64, "image/png");
        if (!r.holdings.length) setErr("照片裡沒有辨識到持股，請換一張清楚的庫存截圖");
        else setImporting({ rows: r.holdings, note: r.note });
      } catch (e2) { setErr(explainError(e2)); }
      finally { setBusy(false); }
    };
    return () => { delete (window as any).__srImportBase64; };
  }, []);

  const onPhoto = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setBusy(true); setErr("");
    try {
      const img = await shrinkImage(file);
      const r = await holdingsFromImage(apiKey, img.base64, img.mediaType);
      if (!r.holdings.length) setErr("照片裡沒有辨識到持股，請換一張清楚的庫存截圖");
      else setImporting({ rows: r.holdings, note: r.note });
    } catch (e2) { setErr(explainError(e2)); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div class="summary">
        <div class="card"><div class="muted" style={{ fontSize: "12px" }}>台股市值</div>{tw.cost ? <><div class="big num">{fmtMoney(tw.value)}</div><div class={`num ${cls(tw.pnl)}`} style={{ fontSize: "13px" }}>{fmtMoney(tw.pnl)}（{fmtPct(tw.pnl / tw.cost)}）</div></> : <div class="big muted">—</div>}</div>
        <div class="card"><div class="muted" style={{ fontSize: "12px" }}>美股市值</div>{us.cost ? <><div class="big num">{fmtMoney(us.value, "US")}</div><div class={`num ${cls(us.pnl)}`} style={{ fontSize: "13px" }}>{fmtMoney(us.pnl, "US")}（{fmtPct(us.pnl / us.cost)}）</div></> : <div class="big muted">—</div>}</div>
      </div>
      <div class="row" style={{ marginTop: "12px" }}>
        <label class="btn" style={{ flex: 1 }} aria-disabled={busy || !apiKey}>
          {busy ? "Claude 辨識中…" : <><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>拍照／截圖匯入</>}
          <input type="file" accept="image/*" hidden disabled={busy || !apiKey} onChange={onPhoto} data-testid="photo-input" />
        </label>
        <button class="btn secondary" onClick={() => setAdding(true)}>手動新增</button>
      </div>
      {!apiKey && <div class="muted" style={{ fontSize: "13px", marginTop: "8px" }}>照片匯入需要 Claude API 金鑰（到「設定」貼上）；手動新增不需要。</div>}
      {err && <div class="error" style={{ marginTop: "10px" }}>{err}</div>}

      <div class="section-title"><span>持股健檢</span><span>{views.length} 檔</span></div>
      {views.length === 0 ? (
        <div class="empty">還沒有持股。<br />拍一張證券 App 的「庫存」畫面，Claude 會自動辨識代號、股數與成本。</div>
      ) : (
        <div class="list">
          {views.map((v) => (
            <button class="item" onClick={() => v.scored && open(v.scored)}>
              <div style={{ minWidth: 0 }}>
                <div class="name">{v.name} <span class="muted num" style={{ fontWeight: 400, fontSize: "13px" }}>{v.code}</span></div>
                <div class="sub">{v.advice.join("；")}</div>
              </div>
              <div class="px">
                <div class="p num">{fmtPrice(v.price, v.market)}</div>
                <div class={`c num ${cls(v.pnl)}`}>{fmtPct(v.pnlPct)}</div>
              </div>
              <RatingPill rating={v.rating} />
            </button>
          ))}
        </div>
      )}
      {views.length > 0 && <HoldingsEditor />}
      {adding && <HoldingForm onDone={() => setAdding(false)} />}
      {importing && <ImportReview data={importing} onDone={() => setImporting(null)} />}
    </div>
  );
}

function HoldingsEditor() {
  const holdings = useStore((s) => s.holdings);
  const [editing, setEditing] = useState<Holding | null>(null);
  return (
    <>
      <div class="section-title"><span>編輯持股</span></div>
      <div class="chips" style={{ flexWrap: "wrap" }}>
        {holdings.map((h) => <button class="chip" onClick={() => setEditing(h)}>{h.name} ✎</button>)}
      </div>
      {editing && <HoldingForm initial={editing} onDone={() => setEditing(null)} />}
    </>
  );
}

function marketOf(code: string, hint?: string): Holding["market"] {
  if (hint === "US" || /^[A-Z][A-Z.]*$/.test(code)) return "US";
  const s = findScored(code, "TW");
  return s?.market === "TPEX" ? "TPEX" : "TWSE";
}

function HoldingForm({ initial, onDone }: { initial?: Partial<Holding>; onDone: () => void }) {
  const holdings = useStore((s) => s.holdings);
  const [code, setCode] = useState(initial?.code ?? "");
  const [shares, setShares] = useState(String(initial?.shares ?? ""));
  const [cost, setCost] = useState(String(initial?.cost ?? ""));
  const [err, setErr] = useState("");
  const isEdit = !!initial?.id;
  const save = async () => {
    const c = code.trim().toUpperCase();
    const sh = Number(shares), co = Number(cost);
    if (!c) return setErr("請輸入股票代號");
    if (!(sh > 0)) return setErr("股數要大於 0（1 張 = 1000 股）");
    if (!(co > 0)) return setErr("成本要大於 0");
    const market = marketOf(c, initial?.market === "US" ? "US" : undefined);
    const name = findScored(c, market === "US" ? "US" : "TW")?.name ?? getState().prices[c]?.name ?? initial?.name ?? c;
    const h: Holding = { id: initial?.id ?? `${Date.now()}-${c}`, code: c, name, market, shares: sh, cost: co };
    await saveHoldings(isEdit ? holdings.map((x) => (x.id === h.id ? h : x)) : [...holdings.filter((x) => x.code !== c), h]);
    onDone();
  };
  const remove = async () => { await saveHoldings(holdings.filter((x) => x.id !== initial?.id)); onDone(); };
  return (
    <Sheet title={isEdit ? `編輯 ${initial?.name}` : "新增持股"} onClose={onDone}>
      <div class="stack">
        <label class="field">股票代號<input value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} placeholder="例如 2330 或 AAPL" autocapitalize="characters" id="h-code" /></label>
        <div class="formgrid">
          <label class="field">股數<input inputMode="numeric" value={shares} onInput={(e) => setShares((e.target as HTMLInputElement).value)} id="h-shares" /></label>
          <label class="field">每股平均成本<input inputMode="decimal" value={cost} onInput={(e) => setCost((e.target as HTMLInputElement).value)} id="h-cost" /></label>
        </div>
        <div class="muted" style={{ fontSize: "12px" }}>台股 1 張 = 1000 股；零股直接填股數。</div>
        {err && <div class="error">{err}</div>}
        <button class="btn block" onClick={save}>儲存</button>
        {isEdit && <button class="btn danger block" onClick={remove}>刪除這檔持股</button>}
      </div>
    </Sheet>
  );
}

function ImportReview({ data, onDone }: { data: { rows: ImportedHolding[]; note: string }; onDone: () => void }) {
  const holdings = useStore((s) => s.holdings);
  const [rows, setRows] = useState(data.rows.map((r) => ({ ...r, keep: !!r.code && r.shares > 0 })));
  const upd = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = async () => {
    const add: Holding[] = rows.filter((r) => r.keep && r.code && r.shares > 0).map((r) => {
      const code = r.code.trim().toUpperCase();
      const market = marketOf(code, r.market);
      return { id: `${Date.now()}-${code}`, code, name: findScored(code, market === "US" ? "US" : "TW")?.name ?? getState().prices[code]?.name ?? r.name, market, shares: r.shares, cost: r.cost };
    });
    const codes = new Set(add.map((h) => h.code));
    await saveHoldings([...holdings.filter((h) => !codes.has(h.code)), ...add]);
    onDone();
  };
  return (
    <Sheet title="確認辨識結果" onClose={onDone}>
      <div class="notice">請核對 Claude 辨識的內容，數字不對可以直接改。同代號的持股會被覆蓋。{data.note && <><br />Claude 備註：{data.note}</>}</div>
      <div class="list" style={{ marginTop: "12px" }}>
        {rows.map((r, i) => (
          <div class="import-row">
            <label class="field" style={{ gridColumn: "1 / -1", flexDirection: "row", display: "flex", alignItems: "center", gap: "8px", color: "var(--fg)" }}>
              <input type="checkbox" checked={r.keep} onChange={(e) => upd(i, { keep: (e.target as HTMLInputElement).checked })} />
              <b>{r.name || "（未辨識名稱）"}</b>
            </label>
            <label class="field">代號<input value={r.code} onInput={(e) => upd(i, { code: (e.target as HTMLInputElement).value })} /></label>
            <label class="field">股數<input inputMode="numeric" value={r.shares} onInput={(e) => upd(i, { shares: Number((e.target as HTMLInputElement).value) })} /></label>
            <label class="field" style={{ gridColumn: "1 / -1" }}>每股成本<input inputMode="decimal" value={r.cost} onInput={(e) => upd(i, { cost: Number((e.target as HTMLInputElement).value) })} /></label>
          </div>
        ))}
      </div>
      <button class="btn block" style={{ marginTop: "14px" }} onClick={save}>加入 {rows.filter((r) => r.keep).length} 檔持股</button>
    </Sheet>
  );
}

// ---------------- 數據（國內外指標＋AI 解讀） ----------------
export function MacroScreen() {
  const st = useStore((s) => ({ macro: s.macro, tw: s.tw, us: s.us, idx: s.twIndices, etfs: s.usSectorEtfs, apiKey: s.settings.apiKey, reports: s.reports }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const today = taipeiToday();
  const key = `brief:${today}`;
  const report = st.reports[key];
  const bySymbol = new Map(st.macro.quotes.map((q) => [q.symbol, q]));
  const groups = ["亞洲", "美股", "利率匯率", "原物料"] as const;

  const runAi = async () => {
    setBusy(true); setErr("");
    try {
      const top = [...st.tw.scored.slice(0, 5), ...st.us.scored.slice(0, 5)];
      await saveReport(key, await marketBrief(st.apiKey, today, st.tw.sectors, st.us.sectors, st.macro.quotes, top));
    } catch (e) { setErr(explainError(e)); }
    finally { setBusy(false); }
  };

  return (
    <div>
      {st.idx.length > 0 && (
        <>
          <div class="section-title"><span>台股收盤（{st.tw.asOf ? pretty(st.tw.asOf) : ""}）</span></div>
          <div class="grid2">
            {st.idx.map((i) => <Metric k={i.name.replace("發行量加權股價指數", "加權指數")} v={i.close.toLocaleString("zh-TW")} c={cls(i.change)} d={`${i.change > 0 ? "+" : ""}${i.change.toFixed(2)}（${i.changePct > 0 ? "+" : ""}${i.changePct}%）`} />)}
          </div>
        </>
      )}
      {st.macro.error && <div class="error" style={{ marginTop: "10px" }}>{st.macro.error}</div>}
      {st.macro.status === "loading" && <div class="empty">國際指標載入中…</div>}
      {groups.map((g) => {
        const items = MACRO_SYMBOLS.filter((m) => m.group === g && bySymbol.has(m.symbol));
        if (!items.length) return null;
        return (
          <>
            <div class="section-title"><span>{g}</span></div>
            <div class="grid2">
              {items.map((m) => {
                const q = bySymbol.get(m.symbol)!;
                return <Metric k={m.label} v={q.last.toLocaleString("en-US", { maximumFractionDigits: 3 })} c={cls(q.change)} d={`${q.change > 0 ? "+" : ""}${q.change}（${q.changePct > 0 ? "+" : ""}${q.changePct}%）`} />;
              })}
            </div>
          </>
        );
      })}
      {st.etfs.length > 0 && (
        <>
          <div class="section-title"><span>美股產業 ETF（近 1 月）</span></div>
          <div class="card scroll-x" style={{ padding: "4px 8px" }}>
            <table class="sectors">
              <thead><tr><th>產業</th><th>ETF</th><th>近1週</th><th>近1月</th><th>近3月</th></tr></thead>
              <tbody>
                {[...st.etfs].sort((a, b) => b.ret1m - a.ret1m).map((e) => (
                  <tr><td>{e.sector}</td><td class="num">{e.symbol}</td><td class={`num ${cls(e.ret1w)}`}>{fmtPct(e.ret1w)}</td><td class={`num ${cls(e.ret1m)}`}>{fmtPct(e.ret1m)}</td><td class={`num ${cls(e.ret3m)}`}>{fmtPct(e.ret3m)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div class="section-title"><span>AI 國內外數據解讀</span>{report && <span>{new Date(report.at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })} 更新</span>}</div>
      {err && <div class="error">{err}</div>}
      {report ? <AiReportView r={report} /> : (
        <div class="notice">Claude 會搜尋最近一週國內外發表的經濟數據（美國 CPI、非農、Fed、台灣出口、央行等），寫出實際值與預期值的比較，並解讀族群輪動與外資動向。約 2 分鐘、花費約台幣 5~10 元。</div>
      )}
      <button class="btn block" style={{ marginTop: "12px" }} disabled={busy || !st.apiKey} onClick={runAi}>
        {busy ? "Claude 搜尋與分析中（約 2 分鐘）…" : report ? "重新解讀" : "產生今日解讀"}
      </button>
      {!st.apiKey && <div class="muted" style={{ fontSize: "13px", textAlign: "center", marginTop: "8px" }}>先到「設定」貼上 Claude API 金鑰</div>}
    </div>
  );
}

// ---------------- 設定 ----------------
export function SettingsScreen() {
  const settings = useStore((s) => s.settings);
  const [key, setKey] = useState(settings.apiKey);
  const [msg, setMsg] = useState("");
  const [testing, setTesting] = useState(false);
  const save = async () => {
    await saveSettings({ ...settings, apiKey: key.trim() });
    setMsg(key.trim() ? "已儲存金鑰" : "已清除金鑰");
  };
  const test = async () => {
    setTesting(true); setMsg("");
    try {
      const c = client(key.trim());
      await c.models.retrieve(MODEL);
      await saveSettings({ ...settings, apiKey: key.trim() });
      setMsg("金鑰可以使用，已儲存");
    } catch (e) { setMsg(explainError(e)); }
    finally { setTesting(false); }
  };
  return (
    <div class="stack">
      <div class="section-title"><span>Claude API 金鑰</span></div>
      <div class="card stack">
        <label class="field">金鑰（sk-ant- 開頭）<input type="password" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} placeholder="sk-ant-..." autocomplete="off" id="api-key" /></label>
        <div class="row">
          <button class="btn" onClick={save}>儲存</button>
          <button class="btn secondary" onClick={test} disabled={testing || !key.trim()}>{testing ? "測試中…" : "測試金鑰"}</button>
        </div>
        {msg && <div class="notice">{msg}</div>}
        <div class="muted" style={{ fontSize: "13px", lineHeight: 1.6 }}>
          金鑰只存在這支手機裡，直接用來呼叫 Anthropic。到 console.anthropic.com 建立金鑰並儲值。使用模型：{MODEL}。
        </div>
      </div>
      <div class="section-title"><span>資料</span></div>
      <div class="card stack">
        <div class="row">
          <button class="btn secondary" onClick={() => { refreshTw(); refreshUs(); refreshMacro(); }}>立即更新全部資料</button>
          <button class="btn danger" onClick={clearCache}>清除快取重新下載</button>
        </div>
        <div class="muted" style={{ fontSize: "13px", lineHeight: 1.7 }}>
          資料來源：臺灣證券交易所、證券櫃檯買賣中心（行情、三大法人、產業別）、Nasdaq（美股日K）、CNBC（國際指標）。證交所約下午 3~5 點公布當日法人資料。
        </div>
      </div>
      <div class="notice">本 App 為個人研究工具，評等由公開數據依固定規則計算，AI 解析可能有誤，不構成投資建議。投資前請自行判斷。</div>
    </div>
  );
}

export { getState };
