import { useEffect, useMemo, useState } from "preact/hooks";
import {
  findScored, getFetcher, getKv, getState, holdingViews, refreshEsb, refreshMacro, refreshTw, refreshUs, saveHoldings, saveReport,
  saveSettings, clearCache, useStore, usBars, recordSpend, estimatedBalance, checkForUpdate, installUpdate,
  addUsSymbol, removeUsSymbol, revenueOf, type Market,
} from "../store";
import type { Holding, Rating, Scored, SectorStat } from "../engine/score";
import { analyzeStock, claudeAppPrompt, claudeAppUrl, client, explainError, holdingsFromImage, marketBrief, shrinkImage, MODEL, type ImportedHolding } from "../ai/claude";
import { twHistory } from "../data/history";
import { isEtf } from "../data/tw";
import { freeReport } from "../engine/freeReport";
import { isUsSymbol, MACRO_SYMBOLS } from "../data/us";
import { pretty, taipeiToday } from "../lib/dates";
import { cls, fmtMoney, fmtPct, fmtPrice, lots, Markdown, PriceChart, Progress, RatingPill, Sheet } from "./common";

// ---------------- 選股 ----------------
export function PicksScreen({ market, setMarket, sector, setSector, open }: {
  market: Market; setMarket: (m: Market) => void; sector: string; setSector: (s: string) => void; open: (s: Scored) => void;
}) {
  const ms = useStore((s) => (market === "TW" ? s.tw : market === "ETF" ? s.etf : s.us));
  const [filter0, setFilter] = useState<Rating | "全部">("買入");
  const refOnly = market === "ETF";
  const filter = refOnly ? "全部" : filter0; // ETF 不分評等
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
        {refOnly
          ? <button class="chip" aria-pressed="true">全部 {counts["全部"]}</button>
          : (["買入", "觀望", "離場", "全部"] as const).map((f) => (
            <button class="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f} {counts[f] ?? 0}</button>
          ))}
        {sector && <button class="chip" aria-pressed="true" onClick={() => setSector("")}>{sector} ✕</button>}
      </div>
      <BacktestCard market={market} />
      {ms.error && <div class="error" style={{ marginTop: "10px" }}>{ms.error}</div>}
      {ms.warning && <div class="notice" style={{ marginTop: "10px" }}>{ms.warning}</div>}
      {ms.status === "loading" && <Progress p={ms.progress} />}
      {ms.status === "error" && <div class="empty">資料下載失敗，請檢查網路後按右上角重新整理</div>}
      {ms.status === "ready" && (
        <>
          <div class="section-title">
            <span>{filter === "全部" ? (market === "ETF" ? "全部 ETF" : "全部股票") : `評等「${filter}」`}・依分數排序</span>
            <span>{list.length} 檔</span>
          </div>
          {market === "US" && <UsLookup q={q} found={list.length > 0} />}
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
            {market === "ETF"
              ? "ETF 只給分數當參考、不給買入／觀望／離場：回測顯示這套短線規則對 ETF 分辨不出好壞。分數 = 動能 40% ＋ 外資籌碼 40% ＋ 同類 ETF 強弱 20%，只列當日成交金額 5 千萬以上的 ETF；槓桿反向型波動大，請特別留意。"
              : market === "TW"
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
      <button aria-pressed={market === "ETF"} onClick={() => setMarket("ETF")}>ETF</button>
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
        <RatingPill rating={s.refOnly ? "參考" : s.rating} />
        <div class="score num">{s.score} 分</div>
      </div>
    </button>
  );
}

// ---------------- 搜尋不在清單裡的美股 ----------------
function UsLookup({ q, found }: { q: string; found: boolean }) {
  const lk = useStore((s) => s.usLookup);
  const sym = q.trim().toUpperCase();
  if (lk?.status === "loading") return <div class="notice" style={{ marginBottom: "10px" }}>正在從 Nasdaq 下載 {lk.symbol} 的資料並評分…</div>;
  if (found || !isUsSymbol(sym)) return null;
  return (
    <div class="card stack" style={{ marginBottom: "10px" }} data-testid="us-lookup">
      {lk?.symbol === sym && lk.status === "notfound" && <div class="error">Nasdaq 查不到 {sym}，請確認代號（例如 AAOI、BRK.B）</div>}
      {lk?.symbol === sym && lk.status === "error" && <div class="error">下載失敗：{lk.error}，請稍後再試</div>}
      <div style={{ fontSize: "14px", lineHeight: 1.6 }}>{sym} 不在預設的 55 檔大型股清單裡。要下載它的資料並評分嗎？加入後每天會一起更新。</div>
      <button class="btn block" onClick={() => addUsSymbol(sym)} data-testid="us-add">下載 {sym} 並評分</button>
    </div>
  );
}

// ---------------- 回測 ----------------
type BtGroup = "買入" | "觀望" | "離場" | "全部";

/** 選股頁上方的回測摘要：這套評等過去準不準 */
function BacktestCard({ market }: { market: Market }) {
  const bt = useStore((s) => s.backtest);
  const [open, setOpen] = useState(false);
  if (market !== "TW" || !bt) return null; // ETF 只當參考，不顯示評等回測
  const u = bt.data.stocks;
  const b = u.groups["買入"][20], a = u.groups["全部"][20];
  if (!u.signals || !b || !a) return null;
  const word = "股票";
  return (
    <>
      <button class="card" style={{ width: "100%", textAlign: "left", marginTop: "10px", cursor: "pointer", display: "block" }} onClick={() => setOpen(true)} data-testid="backtest-card">
        <div class="row" style={{ justifyContent: "space-between" }}>
          <b style={{ fontSize: "14px" }}>回測參考：評「買入」之後 20 個交易日</b>
          <span class="muted" style={{ fontSize: "12px" }}>詳情 ›</span>
        </div>
        <div class="num" style={{ marginTop: "6px", fontSize: "14px", lineHeight: 1.7 }}>
          平均 <span class={cls(b.avg)}>{fmtPct(b.avg)}</span>・上漲機率 {Math.round(b.win * 100)}%
          <span class="muted">（全部{word}平均 <span class={cls(a.avg)}>{fmtPct(a.avg)}</span>）</span>
        </div>
        <div class="muted" style={{ fontSize: "12px" }}>{pretty(bt.data.from)}～{pretty(bt.data.to)} 每週評等一次，共 {u.signals} 次・過去表現不代表未來</div>
      </button>
      {open && <BacktestSheet market={market} onClose={() => setOpen(false)} />}
    </>
  );
}

function BacktestSheet({ market, onClose }: { market: Market; onClose: () => void }) {
  const bt = useStore((s) => s.backtest)!;
  const u = market === "ETF" ? bt.data.etf : bt.data.stocks;
  const word = market === "ETF" ? "ETF" : "股票";
  const row = (g: BtGroup, h: 5 | 20) => {
    const x = u.groups[g][h];
    return (
      <tr>
        <td>{g === "全部" ? `全部${word}` : <RatingPill rating={g} />}</td>
        <td class="num">{x ? x.n.toLocaleString() : "—"}</td>
        <td class={`num ${cls(x?.avg)}`}>{fmtPct(x?.avg)}</td>
        <td class={`num ${cls(x?.median)}`}>{fmtPct(x?.median)}</td>
        <td class="num">{x ? `${Math.round(x.win * 100)}%` : "—"}</td>
        <td class="num">{x && g !== "全部" ? `${Math.round(x.beat * 100)}%` : "—"}</td>
      </tr>
    );
  };
  return (
    <Sheet title={`回測：${market === "ETF" ? "ETF" : "台股"}評等準不準`} onClose={onClose}>
      <div class="notice" style={{ lineHeight: 1.7 }}>
        方法：從 {pretty(bt.data.from)} 到 {pretty(bt.data.to)}，每 5 個交易日用和 App 完全相同的規則重新評等一次，再看每檔{word}之後 5 天、20 天的實際漲跌（已還原除權息）。資料來自證交所與櫃買中心，每次更新 App 資料時會一起下載最新結果。
      </div>
      {([5, 20] as const).map((h) => (
        <>
          <div class="section-title"><span>之後 {h} 個交易日</span></div>
          <div class="scroll-x">
            <table class="sectors">
              <thead><tr><th>評等</th><th>樣本</th><th>平均</th><th>中位數</th><th>上漲機率</th><th>贏過一半</th></tr></thead>
              <tbody>{(["買入", "觀望", "離場", "全部"] as const).map((g) => row(g, h))}</tbody>
            </table>
          </div>
        </>
      ))}
      <div class="section-title"><span>每次評等的結果（買入 vs 全部平均）</span></div>
      <div class="scroll-x">
        <table class="sectors">
          <thead><tr><th>評等日</th><th>買入檔數</th><th>買入 5日</th><th>全部 5日</th><th>買入 20日</th><th>全部 20日</th></tr></thead>
          <tbody>
            {u.series.map((r) => (
              <tr>
                <td class="num">{pretty(r.date)}</td>
                <td class="num">{r.nBuy}</td>
                <td class={`num ${cls(r.buy[5])}`}>{fmtPct(r.buy[5])}</td>
                <td class={`num ${cls(r.all[5])}`}>{fmtPct(r.all[5])}</td>
                <td class={`num ${cls(r.buy[20])}`}>{fmtPct(r.buy[20])}</td>
                <td class={`num ${cls(r.all[20])}`}>{fmtPct(r.all[20])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="muted" style={{ fontSize: "12px", lineHeight: 1.7 }}>
        怎麼看：「買入」的平均、中位數和上漲機率如果明顯高於「全部」，代表這套評等過去有參考價值；「贏過一半」是之後表現贏過同一天全部{word}中位數的比例，50% 等於亂選，高於 50% 才代表真的挑得比較好。平均比中位數高很多，表示有少數大漲股把平均拉高。
        注意：只有約 6 個月的資料，不同行情（多頭、空頭）結果可能差很多；沒有計算手續費與交易稅；最近 20 天內的評等還沒有 20 日結果。過去表現不代表未來，僅供參考。
      </p>
    </Sheet>
  );
}

// ---------------- 族群 ----------------
export function SectorsScreen({ market, setMarket, pick }: { market: Market; setMarket: (m: Market) => void; pick: (s: string) => void }) {
  const ms = useStore((s) => (market === "TW" ? s.tw : market === "ETF" ? s.etf : s.us));
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
          <div class="section-title"><span>{market === "TW" ? "產業強弱（中位數報酬）" : market === "ETF" ? "ETF 類型強弱（中位數報酬）" : "產業強弱"}</span><span>點一下看個股</span></div>
          <div class="card scroll-x" style={{ padding: "4px 8px" }}>
            <table class="sectors">
              <thead><tr><th>族群</th><th>訊號</th><th>近1週</th><th>近1月</th>{market !== "US" && <th>外資5日</th>}<th>上漲比</th></tr></thead>
              <tbody>
                {ms.sectors.map((s: SectorStat) => (
                  <tr onClick={() => pick(s.sector)}>
                    <td><b>{s.sector}</b> <span class="muted num" style={{ fontSize: "11px" }}>{s.count}</span></td>
                    <td><span class={`tag ${s.rotation}`}>{s.rotation}</span></td>
                    <td class={`num ${cls(s.ret1w)}`}>{fmtPct(s.ret1w)}</td>
                    <td class={`num ${cls(s.ret1m)}`}>{fmtPct(s.ret1m)}</td>
                    {market !== "US" && <td class={`num ${cls(s.foreignValue5)}`}>{fmtMoney(s.foreignValue5)}</td>}
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
  const isExtra = useStore((st) => st.usExtra.some((x) => x.symbol === s.code)) && !holding;
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

  const [free, setFree] = useState("");
  const [freeBusy, setFreeBusy] = useState(false);
  const runFree = async () => {
    setFreeBusy(true);
    try {
      const revenue = s.market !== "US" && !s.refOnly ? await revenueOf(s.code, s.market) : undefined;
      setFree(freeReport({ s, bars: bars ?? [], revenue, holding, today }));
    } finally { setFreeBusy(false); }
  };

  const runAi = async () => {
    if (report && !confirmRerun(0.5)) return;
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
          <div class="muted" style={{ marginTop: "6px", fontSize: "13px" }}>{s.sector}・{s.market === "US" ? "美股" : `${s.market === "TPEX" ? "上櫃" : "上市"}${isEtf(s.code) ? " ETF" : ""}`}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <RatingPill rating={s.refOnly ? "參考" : s.rating} />
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

      <div class="section-title"><span>{s.refOnly ? "分數說明（ETF 只供參考）" : "評等理由"}</span><span>動能 {Math.round(s.momentum * 100)}・{s.market === "US" ? "趨勢" : "籌碼"} {Math.round(s.flow * 100)}・族群 {Math.round(s.sectorScore * 100)}</span></div>
      <div class="card"><ul class="reasons">{s.reasons.map((r) => <li>{r}</li>)}</ul></div>

      {holding && (
        <>
          <div class="section-title"><span>我的持股</span></div>
          <div class="card num">{holding.shares.toLocaleString()} 股・成本 {fmtPrice(holding.cost, s.market)}・損益 <span class={cls(s.close - holding.cost)}>{fmtMoney((s.close - holding.cost) * holding.shares, s.market)}（{fmtPct(s.close / holding.cost - 1)}）</span></div>
        </>
      )}

      <div class="section-title"><span>免費解析（App 內建，不花錢）</span></div>
      {free ? <div class="card" data-testid="free-report"><Markdown text={free.replace(/^評等：.*\n/, "")} /></div> : (
        <div class="notice">用 App 已有的資料（走勢、均線、法人籌碼、族群、每月營收）依固定規則寫成解析，馬上產生、完全免費。不含新聞與國際經濟數據。</div>
      )}
      {!free && <button class="btn secondary block" style={{ marginTop: "10px" }} disabled={freeBusy || bars === null} onClick={runFree} data-testid="free-btn">
        {freeBusy ? "產生中…" : bars === null && !barsErr ? "等待走勢資料…" : "免費解析"}
      </button>}

      <div class="section-title"><span>用 Claude App 解析（用你的訂閱，不扣 API 額度）</span></div>
      <ClaudeAppButton prompt={claudeAppPrompt(s, today, holding)} />

      <div class="section-title"><span>Claude AI 深度解析（付費）</span>{report && <span>{new Date(report.at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })} 更新</span>}</div>
      {aiErr && <div class="error">{aiErr}</div>}
      {report ? <AiReportView r={report} /> : (
        <div class="notice">
          {s.refOnly
            ? "Claude 會搜尋這檔 ETF 的成分股、配息、費用率與國內外經濟數據，說明特性、風險與適合的持有方式（不給買賣評等）。"
            : "Claude 會搜尋這檔股票最近的新聞、法說會與國內外經濟數據發表，搭配上面的籌碼數據寫成解析，並給出評等。"}每次約 2 分鐘，實測花費約台幣 15~20 元（每份解析下方會顯示實際花費）。
        </div>
      )}
      <div class="stack" style={{ marginTop: "12px" }}>
        <button class="btn block" disabled={busy || !apiKey} onClick={runAi}>
          {busy ? "Claude 搜尋與分析中（約 2 分鐘）…" : report ? "重新解析" : "AI 深度解析"}
        </button>
        {!apiKey && <div class="muted" style={{ fontSize: "13px", textAlign: "center" }}>先到「設定」貼上 Claude API 金鑰才能使用</div>}
        {apiKey && <BalanceHint />}
        {!holding && <button class="btn secondary block" onClick={() => setAdding(true)}>加入我的持股</button>}
        {isExtra && <button class="btn danger block" onClick={async () => { await removeUsSymbol(s.code); onClose(); }}>從美股清單移除 {s.code}</button>}
      </div>
      {adding && <HoldingForm initial={{ code: s.code, name: s.name, market: s.market, shares: 1000, cost: s.close }} onDone={() => setAdding(false)} />}
    </Sheet>
  );
}

function Metric({ k, v, c = "", d = "" }: { k: string; v: string; c?: string; d?: string }) {
  return <div class="metric"><div class="k">{k}</div><div class={`v num ${c}`}>{v}</div>{d && <div class="d muted">{d}</div>}</div>;
}

function AiReportView({ r }: { r: { text: string; sources: { title: string; url: string }[]; model: string; costUsd?: number } }) {
  const m = /^\s*\**評等\**\s*[:：]\s*\**\s*(買入|觀望|離場|參考)/.exec(r.text);
  const body = m ? r.text.slice(r.text.indexOf("\n") + 1) : r.text;
  return (
    <div class="card">
      {m && m[1] !== "參考" && <div class="ai-rating">Claude 評等 <RatingPill rating={m[1] as Rating} /></div>}
      <Markdown text={body} />
      {r.sources.length > 0 && (
        <>
          <div class="section-title" style={{ marginTop: "8px" }}><span>資料來源</span></div>
          <ol class="sources">{r.sources.map((x) => <li><a href={x.url} target="_blank" rel="noreferrer">{x.title}</a></li>)}</ol>
        </>
      )}
      <div class="muted" style={{ fontSize: "11px", marginTop: "8px" }}>
        由 {r.model} 產生{r.costUsd !== undefined && Number.isFinite(r.costUsd) ? `・本次約 US$${r.costUsd.toFixed(2)}（約台幣 ${Math.round(r.costUsd * 32)} 元）` : ""}，僅供研究參考，非投資建議
      </div>
    </div>
  );
}

// ---------------- 持股 ----------------
export function HoldingsScreen({ open }: { open: (s: Scored) => void }) {
  useStore((s) => [s.holdings, s.tw.scored, s.etf.scored, s.us.scored, s.esb, s.prices]);
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
        await recordSpend(r.costUsd, "照片辨識");
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
      await recordSpend(r.costUsd, "照片辨識");
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
    if (market === "US" && !findScored(c, "US")) addUsSymbol(c); // 不在清單裡的美股持股，自動下載
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
            <label class="check">
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
    if (report && !confirmRerun(1)) return;
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
        <div class="notice">Claude 會搜尋最近一週國內外發表的經濟數據（美國 CPI、非農、Fed、台灣出口、央行等），寫出實際值與預期值的比較，並解讀族群輪動與外資動向。約 3~4 分鐘，實測花費約台幣 30 元。</div>
      )}
      <button class="btn block" style={{ marginTop: "12px" }} disabled={busy || !st.apiKey} onClick={runAi}>
        {busy ? "Claude 搜尋與分析中（約 3~4 分鐘）…" : report ? "重新解讀" : "產生今日解讀"}
      </button>
      {!st.apiKey && <div class="muted" style={{ fontSize: "13px", textAlign: "center", marginTop: "8px" }}>先到「設定」貼上 Claude API 金鑰</div>}
      {st.apiKey && <div style={{ marginTop: "8px" }}><BalanceHint /></div>}
    </div>
  );
}

// ---------------- 設定 ----------------
// ---------------- App 更新 ----------------
function UpdateBody({ compact }: { compact?: boolean }) {
  const u = useStore((s) => s.update);
  const latest = u.info?.latest;
  const pct = u.total ? Math.round(((u.done ?? 0) / u.total) * 100) : 0;
  if (u.status === "downloading") return (
    <div class="stack">
      <div>正在下載新版 {latest?.versionName}… {u.total ? `${pct}%（${((u.done ?? 0) / 1e6).toFixed(1)} / ${(u.total / 1e6).toFixed(1)} MB）` : ""}</div>
      <div class="bar"><i style={{ width: `${pct}%` }} /></div>
    </div>
  );
  if (u.status === "installing") return <div>下載完成，請在跳出的畫面按「更新」。資料和持股都會保留。</div>;
  if (u.status === "needPermission") return (
    <div class="stack">
      <div>第一次更新需要允許：請在剛打開的設定頁開啟「允許安裝這個來源的應用程式」，回到 App 再按一次「立即更新」。</div>
      <button class="btn block" onClick={installUpdate} data-testid="install-update">立即更新</button>
    </div>
  );
  if (u.info?.available && latest) return (
    <div class="stack">
      <div><b>有新版本 {latest.versionName}</b>{compact ? "" : `（目前 ${u.info.current?.versionName}）`}</div>
      {latest.notes && <div class="muted" style={{ fontSize: "13px", lineHeight: 1.6, whiteSpace: "pre-line" }}>{latest.notes}</div>}
      <button class="btn block" onClick={installUpdate} data-testid="install-update">立即更新</button>
    </div>
  );
  return null;
}

/** 有新版時顯示在每個分頁最上面 */
export function UpdateBanner() {
  const u = useStore((s) => s.update);
  if (!(u.info?.available || u.status === "downloading" || u.status === "installing" || u.status === "needPermission")) return null;
  return <div class="card" style={{ marginBottom: "12px", borderColor: "var(--accent)" }} data-testid="update-banner"><UpdateBody compact /></div>;
}

function UpdateCard() {
  const u = useStore((s) => s.update);
  const cur = u.info?.current;
  return (
    <div class="card stack" data-testid="update-card">
      <div class="row" style={{ justifyContent: "space-between" }}>
        <div>目前版本 <span class="num">{cur?.versionName ?? "—"}</span></div>
        <button class="btn secondary" disabled={u.status === "checking" || u.status === "downloading"} onClick={checkForUpdate}>{u.status === "checking" ? "檢查中…" : "檢查更新"}</button>
      </div>
      {u.error && <div class="error">{u.error}</div>}
      {u.status === "ready" && !u.info?.available && <div class="muted" data-testid="up-to-date">已是最新版本{u.info?.latest ? `（最新 ${u.info.latest.versionName}）` : ""}</div>}
      <UpdateBody />
      <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>每次打開 App 會自動檢查；有新版會在畫面最上方提示，按「立即更新」就會在 App 裡下載並安裝，持股與設定都會保留。</div>
    </div>
  );
}

/** 把提問複製到剪貼簿，再打開 Claude App（或網頁）並帶入提問 */
function ClaudeAppButton({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const copy = async () => {
    try { await navigator.clipboard.writeText(prompt); setCopied("ok"); return; } catch { /* 改用舊方法 */ }
    const ta = document.createElement("textarea");
    ta.value = prompt; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { setCopied(document.execCommand("copy") ? "ok" : "fail"); } catch { setCopied("fail"); }
    ta.remove();
  };
  return (
    <div class="stack">
      <div class="notice">
        會打開手機上的 Claude App，帶入這檔股票的 App 數據與提問。Claude App 用你的 Claude 訂閱（不扣這裡的 API 額度），可以上網搜尋新聞，也能用你在 Claude 連接的台股工具（MCP）查營收與法人資料，還能繼續追問。
      </div>
      <a class="btn secondary block" href={claudeAppUrl(prompt)} target="_blank" rel="noreferrer" onClick={copy} data-testid="claude-app">在 Claude App 解析</a>
      {copied === "ok" && <div class="muted" style={{ fontSize: "13px", textAlign: "center" }} data-testid="claude-app-copied">已複製提問。如果 Claude 沒有自動帶入，在輸入框長按「貼上」再送出。</div>}
      {copied === "fail" && <div class="muted" style={{ fontSize: "13px" }}>沒辦法自動複製，請在 Claude 自行描述要分析的股票。</div>}
    </div>
  );
}

/** 已經有今天的報告時，重做前先確認（會再花一次錢） */
function confirmRerun(usd: number) {
  const left = estimatedBalance(getState());
  const bal = left === undefined ? "" : `，估計剩餘 US$${left.toFixed(2)}`;
  return window.confirm(`今天已經解析過了，畫面上的報告不用錢就能看。\n\n重新解析會再花約 US$${usd.toFixed(1)}（約台幣 ${Math.round(usd * 32)} 元）${bal}。確定要重新解析嗎？`);
}

/** 付費按鈕下方的小字：估計剩餘額度 */
function BalanceHint() {
  const left = useStore((s) => estimatedBalance(s));
  if (left === undefined) return null;
  return <div class={`num ${left < 1 ? "down" : "muted"}`} style={{ fontSize: "13px", textAlign: "center" }}>估計剩餘額度 US${left.toFixed(2)}{left < 1 ? "，快用完了" : ""}</div>;
}

function SpendCard() {
  const spend = useStore((s) => s.spend);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const sum = (xs: typeof spend) => xs.reduce((a, x) => a + x.usd, 0);
  const month = spend.filter((x) => x.at >= monthStart);
  const byKind = new Map<string, { n: number; usd: number }>();
  for (const x of month) {
    const k = byKind.get(x.kind) ?? { n: 0, usd: 0 };
    k.n++; k.usd += x.usd; byKind.set(x.kind, k);
  }
  const twd = (usd: number) => `約台幣 ${Math.round(usd * 32)} 元`;
  const settings = useStore((s) => s.settings);
  const left = useStore((s) => estimatedBalance(s));
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const [err, setErr] = useState("");
  const saveBal = async () => {
    const v = Number(val.replace(/[^\d.]/g, ""));
    if (!val.trim() || !Number.isFinite(v)) return setErr("請輸入官網顯示的金額，例如 2.05");
    await saveSettings({ ...settings, balance: { usd: v, at: Date.now() } });
    setEditing(false); setErr("");
  };
  const b = settings.balance;
  return (
    <div class="card stack">
      <div class="metric" data-testid="balance">
        <div class="k">估計剩餘額度</div>
        {left === undefined
          ? <div class="v muted" style={{ fontSize: "15px" }}>尚未填入</div>
          : <><div class={`v num ${left < 1 ? "down" : ""}`}>US${left.toFixed(2)}</div>
            <div class="d muted">{twd(Math.max(left, 0))}・{new Date(b!.at).toLocaleDateString("zh-TW")} 填入 US${b!.usd.toFixed(2)}，之後花了 US${(b!.usd - left).toFixed(2)}</div></>}
        {left !== undefined && left < 1 && <div class="d down">額度快用完了，請到官網儲值，儲值後再更新這裡的金額</div>}
      </div>
      {editing ? (
        <div class="stack">
          <label class="field">官網顯示的 Credit balance（美元）<input inputMode="decimal" value={val} onInput={(e) => setVal((e.target as HTMLInputElement).value)} placeholder="例如 2.05" id="balance-input" /></label>
          {err && <div class="error">{err}</div>}
          <div class="row"><button class="btn" style={{ flex: 1 }} onClick={saveBal}>儲存餘額</button><button class="btn secondary" onClick={() => setEditing(false)}>取消</button></div>
        </div>
      ) : (
        <button class="btn secondary block" onClick={() => { setVal(b ? b.usd.toFixed(2) : ""); setEditing(true); }}>{b ? "更新餘額（儲值後）" : "填入目前餘額"}</button>
      )}
      <div class="grid2">
        <div class="metric"><div class="k">本月花費</div><div class="v num">US${sum(month).toFixed(2)}</div><div class="d muted">{twd(sum(month))}</div></div>
        <div class="metric"><div class="k">累計花費</div><div class="v num">US${sum(spend).toFixed(2)}</div><div class="d muted">{spend.length} 次呼叫</div></div>
      </div>
      {byKind.size > 0 && (
        <div class="muted" style={{ fontSize: "13px", lineHeight: 1.7 }}>
          本月：{[...byKind.entries()].map(([k, v]) => `${k} ${v.n} 次 US$${v.usd.toFixed(2)}`).join("、")}
        </div>
      )}
      <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>
        花費是 App 依 Claude 回傳的用量自己算的，只包含這支手機的使用。Anthropic 沒有開放用金鑰查詢餘額，所以剩餘額度要你從官網抄一次，之後 App 會自動扣掉每次的花費；儲值後再按「更新餘額」。
      </div>
      <a class="btn secondary block" href="https://platform.claude.com/settings/billing" target="_blank" rel="noreferrer">查看剩餘額度／儲值</a>
    </div>
  );
}

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
          金鑰只存在這支手機裡，直接用來呼叫 Anthropic。到 platform.claude.com 建立金鑰並儲值。使用模型：{MODEL}。
        </div>
      </div>
      <div class="section-title"><span>Claude 額度與花費</span></div>
      <SpendCard />
      <div class="section-title"><span>App 更新</span></div>
      <UpdateCard />
      <div class="section-title"><span>資料</span></div>
      <div class="card stack">
        <div class="row">
          <button class="btn secondary" onClick={() => { refreshTw(); refreshEsb(); refreshUs(); refreshMacro(); }}>立即更新全部資料</button>
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
