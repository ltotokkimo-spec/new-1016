// 工具分頁（11/11 使用者）：攤平計算、股息計算。資料從持股、即時價、除權息資料自動帶入，全部在手機上計算、不花錢。
import { useMemo, useState } from "preact/hooks";
import { averageDown, batchPlan, dividendPlan, payout, sharesForAmount, sharesForMonthly, sharesForTarget } from "../engine/calc";
import { dividendInfo } from "../engine/exdiv";
import { mergeHoldings } from "../engine/score";
import { findScored, getState, holdingViews, useStore } from "../store";
import { cls, fmtPct, RatingPill } from "./common";

const num = (s: string) => Number(String(s).replace(/,/g, ""));
const n0 = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString("zh-TW") : "—");
const signed = (x: number) => (Number.isFinite(x) ? `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.round(Math.abs(x)).toLocaleString("zh-TW")}` : "—");
const p2 = (x: number) => (Number.isFinite(x) ? x.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—");
const pctPlain = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "—");
const lotsTxt = (sh: number) => (sh >= 1000 && sh % 1000 === 0 ? `${sh / 1000} 張` : sh >= 1000 ? `${(sh / 1000).toFixed(1)} 張` : `${sh.toLocaleString("zh-TW")} 股`);

/** 現價：今天的即時價優先，再用最近收盤 */
function priceOf(code: string): number {
  const st = getState();
  const q = st.live[code];
  if (q && q.price > 0 && q.date >= (st.tw.asOf ?? "")) return q.price;
  return findScored(code)?.close ?? st.prices[code]?.close ?? NaN;
}

/** 兩家券商的持股合併（同一檔股數相加、成本加權），附現價 */
function useMergedHoldings() {
  useStore((s) => [s.holdings, s.live, s.tw.scored]);
  const hs = getState().holdings;
  return holdingViews(mergeHoldings(hs)).map((v) => { const price = priceOf(v.code); return { ...v, price, pnlPct: v.cost > 0 ? price / v.cost - 1 : NaN }; }).filter((v) => Number.isFinite(v.price));
}

function Field({ label, tag, value, set, id, mode = "decimal" }: { label: string; tag?: string; value: string; set: (v: string) => void; id: string; mode?: string }) {
  return (
    <label class="field">
      <span>{label}{tag && <span style={{ color: "var(--accent)", marginLeft: "4px", fontSize: "11px" }}>{tag}</span>}</span>
      <input inputMode={mode as any} value={value} onInput={(e) => set((e.target as HTMLInputElement).value)} data-testid={id} />
    </label>
  );
}

export function ToolsScreen() {
  const [tab, setRaw] = useState<"avg" | "div">(() => { try { return localStorage.getItem("toolTab") === "div" ? "div" : "avg"; } catch { return "avg"; } });
  const setTab = (t: "avg" | "div") => { setRaw(t); try { localStorage.setItem("toolTab", t); } catch { /* 記不住沒關係 */ } };
  return (
    <div data-testid="tools">
      <div class="seg" role="tablist" style={{ marginBottom: "12px" }}>
        <button aria-pressed={tab === "avg"} onClick={() => setTab("avg")} data-testid="tool-tab-avg">攤平計算</button>
        <button aria-pressed={tab === "div"} onClick={() => setTab("div")} data-testid="tool-tab-div">股息計算</button>
      </div>
      {tab === "avg" ? <AverageTool /> : <DividendTool />}
    </div>
  );
}

// ---------------- 攤平計算 ----------------
function AverageTool() {
  const views = useMergedHoldings();
  const losers = [...views].sort((a, b) => a.pnlPct - b.pnlPct);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [market, setMarket] = useState("TWSE");
  const [price, setPrice] = useState("");
  const [shares, setShares] = useState("");
  const [cost, setCost] = useState("");
  const [mode, setMode] = useState<"shares" | "amount" | "target">("shares");
  const [addShares, setAddShares] = useState("");
  const [addAmount, setAddAmount] = useState("");
  const [target, setTarget] = useState("");
  const [addPrice, setAddPrice] = useState("");
  const [discount, setDiscount] = useState("10");
  const pick = (v: (typeof views)[number]) => {
    setCode(v.code); setName(v.name); setMarket(v.market); setShares(String(v.shares)); setCost(p2(v.cost).replace(/,/g, ""));
    const px = String(v.price); setPrice(px); setAddPrice(px);
    setAddShares(String(v.market !== "US" && v.shares >= 1000 ? 1000 : v.shares));
  };
  const lookup = (c: string) => {
    setCode(c);
    const s = findScored(c.trim().toUpperCase());
    if (s) { setName(s.name); setMarket(s.market); const px = String(priceOf(s.code)); setPrice(px); if (!addPrice) setAddPrice(px); }
  };
  const P = num(price), S = num(shares), C = num(cost), AP = num(addPrice) || P, disc = Math.min(10, Math.max(1, num(discount) || 10)) / 10;
  const add = mode === "shares" ? num(addShares) : mode === "amount" ? sharesForAmount(num(addAmount), AP, market) : (sharesForTarget(S, C, AP, num(target)) ?? NaN);
  const ok = P > 0 && S > 0 && C > 0 && AP > 0 && Number.isFinite(add) && add >= 0;
  const input = { code: code.trim().toUpperCase(), market, shares: S, cost: C, price: P, addShares: add, addPrice: AP, discount: disc };
  const r = ok ? averageDown(input) : undefined;
  const us = market === "US";
  const scen = ok ? [0.5, 1, 2, 3].map((m) => { const n = !us && S >= 1000 ? Math.round(1000 * m) : Math.round(S * m); return { n, r: averageDown({ ...input, addShares: n }) }; }) : [];
  const batches = ok && add > 0 ? batchPlan(input) : [];
  const batchAvg = batches.length ? (S * C + batches.reduce((a, b) => a + b.shares * b.price, 0)) / (S + add) : NaN;
  const sc = code ? findScored(code.trim().toUpperCase()) : undefined;
  return (
    <div>
      {losers.length > 0 && <>
        <div class="muted" style={{ fontSize: "12.5px", marginBottom: "4px" }}>從持股帶入（口袋＋元大合併，虧損的排前面）</div>
        <div class="chips" style={{ marginBottom: "10px" }} data-testid="avg-chips">
          {losers.map((v) => <button class="chip" aria-pressed={code === v.code} onClick={() => pick(v)} data-testid="avg-chip">{v.name} <span class={cls(v.pnlPct)}>{fmtPct(v.pnlPct)}</span></button>)}
        </div>
      </>}
      <div class="card stack" style={{ gap: "10px" }}>
        <div class="formgrid">
          <Field label="股票代號" value={code} set={lookup} id="avg-code" mode="text" />
          <Field label="現價" tag="即時" value={price} set={setPrice} id="avg-price" />
          <Field label="目前股數" tag={views.some((v) => v.code === code) ? "持股" : undefined} value={shares} set={setShares} id="avg-shares" mode="numeric" />
          <Field label="目前均價" tag={views.some((v) => v.code === code) ? "持股" : undefined} value={cost} set={setCost} id="avg-cost" />
        </div>
        {name && <div class="muted" style={{ fontSize: "13px" }}>{name}{sc && <span style={{ marginLeft: "6px" }}><RatingPill rating={sc.refOnly ? "參考" : sc.rating} /></span>}</div>}
        <div class="seg tight" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)" }}>
          <button aria-pressed={mode === "shares"} onClick={() => setMode("shares")} data-testid="avg-mode-shares">加碼股數</button>
          <button aria-pressed={mode === "amount"} onClick={() => setMode("amount")} data-testid="avg-mode-amount">加碼金額</button>
          <button aria-pressed={mode === "target"} onClick={() => setMode("target")} data-testid="avg-mode-target">目標均價</button>
        </div>
        <div class="formgrid">
          {mode === "shares" && <Field label="加碼股數（1 張＝1000 股）" value={addShares} set={setAddShares} id="avg-add" mode="numeric" />}
          {mode === "amount" && <Field label="加碼金額（元）" value={addAmount} set={setAddAmount} id="avg-amount" mode="numeric" />}
          {mode === "target" && <Field label="想把均價壓到" value={target} set={setTarget} id="avg-target" />}
          <Field label="加碼價格" value={addPrice} set={setAddPrice} id="avg-addprice" />
        </div>
        {mode !== "shares" && ok && <div style={{ fontSize: "13px" }} data-testid="avg-derived">換算：要買 <b>{n0(add)}</b> 股（{lotsTxt(add)}）</div>}
        {mode === "target" && num(target) > 0 && !Number.isFinite(add) && <div class="error">目標均價要介於加碼價格與目前均價之間，才做得到</div>}
        <label class="field" style={{ maxWidth: "50%" }}><span>手續費折扣（折）</span><input inputMode="decimal" value={discount} onInput={(e) => setDiscount((e.target as HTMLInputElement).value)} /></label>
        <div class="muted" style={{ fontSize: "12px" }}>{us ? "美股複委託手續費 0.1%、無證交稅" : "折扣填 10 是不打折、6 是六折。手續費 0.1425%（整股最低 20 元、零股 1 元）・證交稅股票 0.3%、ETF 0.1%"}</div>
      </div>

      {!ok ? <div class="card empty" style={{ marginTop: "12px" }} data-testid="avg-empty">點上面的持股，或輸入代號、股數、均價和現價，就會算出加碼後的均價與回本價。</div> : r && <>
        <div class="section-title"><span>試算結果</span><span>加碼 {lotsTxt(add)}</span></div>
        <div class="card stack" style={{ gap: "8px" }} data-testid="avg-result">
          <table class="calc">
            <tr><th></th><th>加碼前</th><th>加碼後</th></tr>
            <tr><td>均價</td><td>{p2(r.before.avg)}</td><td><b>{p2(r.after.avg)}</b></td></tr>
            <tr><td>回本價（含手續費、稅）</td><td>{p2(r.before.breakEven)}</td><td><b>{p2(r.after.breakEven)}</b></td></tr>
            <tr><td>還要漲多少才回本</td><td class={cls(r.before.needPct)}>{fmtPct(r.before.needPct)}</td><td class={cls(r.after.needPct)}><b>{fmtPct(r.after.needPct)}</b></td></tr>
            <tr><td>累計損益</td><td class={cls(r.before.pnl)}>{signed(r.before.pnl)}</td><td class={cls(r.after.pnl)}>{signed(r.after.pnl)}</td></tr>
            <tr><td>總股數</td><td>{n0(r.before.shares)}</td><td>{n0(r.after.shares)}</td></tr>
            <tr><td>投入成本</td><td>{n0(r.before.invested)}</td><td>{n0(r.after.invested)}</td></tr>
          </table>
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: "8px", fontSize: "13.5px", lineHeight: 1.8 }}>
            需要準備 <b>{n0(r.cash)} 元</b>（含手續費 {n0(r.addFee)} 元）<br />
            如果再跌 10%（{p2(r.ifDrop10.price)}）：損益 <b class={cls(r.ifDrop10.after)}>{signed(r.ifDrop10.after)}</b>（加碼前只會是 {signed(r.ifDrop10.before)}）<br />
            建議停損價 <b>{p2(r.stop)}</b>（新均價 −10%）
          </div>
        </div>

        <div class="section-title"><span>加碼多少比較</span><span>點一列帶入上面</span></div>
        <div class="card">
          <table class="calc" data-testid="avg-scen">
            <tr><th>加碼</th><th>新均價</th><th>回本要漲</th><th>需要資金</th></tr>
            {scen.map((x) => (
              <tr class={x.n === add ? "sel" : ""} onClick={() => { setMode("shares"); setAddShares(String(x.n)); }} style={{ cursor: "pointer" }}>
                <td>{lotsTxt(x.n)}</td><td>{p2(x.r.after.avg)}</td><td class={cls(x.r.after.needPct)}>{fmtPct(x.r.after.needPct)}</td><td>{n0(x.r.cash)}</td>
              </tr>
            ))}
          </table>
          <div class="muted" style={{ fontSize: "12px", marginTop: "6px" }}>加越多回本越快，但部位越大、風險越集中；越往下效果越遞減。</div>
        </div>

        {batches.length > 0 && <>
          <div class="section-title"><span>分批攤平試算</span></div>
          <div class="card" style={{ fontSize: "13.5px", lineHeight: 1.8 }} data-testid="avg-batch">
            {batches.map((b, i) => `${i === 0 ? "現價" : i === 1 ? "跌 5%" : "跌 10%"}（${p2(b.price)}）買 ${n0(b.shares)} 股`).join(" → ")}<br />
            三批都買到：均價 <b>{p2(batchAvg)}</b>、回本價 <b>{p2(averageDown({ ...input, addShares: 0, cost: batchAvg, shares: S + add }).before.breakEven)}</b>
          </div>
        </>}

        {sc && !sc.refOnly && <div class="warn-box" data-testid="avg-warn">
          {sc.rating === "離場" ? "App 評等「離場」：動能與籌碼都轉弱，不建議攤平，先看「持股 → 持股分析與建議」的停損換股。"
            : sc.rating === "觀望" ? "App 評等「觀望」：訊號分歧，攤平前先看「持股 → 持股分析與建議」的支撐、壓力與換股比較。"
              : "App 評等「買入」：動能、籌碼仍強，可以考慮分批加碼；跌破停損價一樣要停損。"}
        </div>}
      </>}
    </div>
  );
}

// ---------------- 股息計算 ----------------
function DividendTool() {
  const views = useMergedHoldings();
  const ex = useStore((s) => s.exdiv);
  const infoOf = (c: string, px: number) => (ex ? dividendInfo(ex.data.ev[c], px, ex.data.asOf) : undefined);
  const withDiv = useMemo(() => [...views].sort((a, b) => Number(!!infoOf(b.code, b.price)) - Number(!!infoOf(a.code, a.price))), [views.length, ex]);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [market, setMarket] = useState("TWSE");
  const [price, setPrice] = useState("");
  const [shares, setShares] = useState("");
  const [cost, setCost] = useState("");
  const [perPay, setPerPay] = useState("");
  const [perYear, setPerYear] = useState("4");
  const [years, setYears] = useState("10");
  const [drip, setDrip] = useState(true);
  const [growth, setGrowth] = useState("0");
  const [addYear, setAddYear] = useState("0");
  const [monthly, setMonthly] = useState("10000");
  const [hist, setHist] = useState<number[]>([]);
  const fill = (c: string, px: number) => {
    const d = infoOf(c, px);
    if (d?.last) { setPerPay(String(d.last.amt)); setPerYear(String(d.perYear ?? (d.freq === "月配" ? 12 : d.freq === "季配" ? 4 : d.freq === "半年配" ? 2 : 1))); }
    const ev = ex?.data.ev[c] ?? [];
    setHist(ev.filter((e) => e[1] >= 0.7 && e[1] < 1 && e[2] > 0).slice(-12).map((e) => e[2]));
  };
  const pick = (v: (typeof views)[number]) => {
    setCode(v.code); setName(v.name); setMarket(v.market); setShares(String(v.shares)); setCost(p2(v.cost).replace(/,/g, "")); setPrice(String(v.price)); fill(v.code, v.price);
  };
  const lookup = (c: string) => {
    setCode(c);
    const s = findScored(c.trim().toUpperCase());
    if (s) { setName(s.name); setMarket(s.market); const px = priceOf(s.code); setPrice(String(px)); fill(s.code, px); }
  };
  const P = num(price), S = num(shares), C = num(cost), D = num(perPay), N = Math.max(1, Math.round(num(perYear) || 1));
  const ok = P > 0 && S > 0 && D > 0;
  const plan = ok ? dividendPlan({ code, market, shares: S, cost: C, price: P, perPay: D, perYear: N, years: Math.min(40, Math.max(1, Math.round(num(years) || 10))), drip, priceGrowth: num(growth) / 100, addPerYear: num(addYear) }) : undefined;
  const first = plan?.first;
  const yearNet = first ? first.net * N : NaN;
  const need = sharesForMonthly(num(monthly), D, N, market);
  const us = market === "US";
  const showYears = plan ? plan.rows.filter((r) => [1, 3, 5, 10, 20, 30, 40].includes(r.year) || r.year === plan.rows.length) : [];
  return (
    <div>
      {withDiv.length > 0 && <>
        <div class="muted" style={{ fontSize: "12.5px", marginBottom: "4px" }}>從持股帶入（有配息紀錄的排前面）</div>
        <div class="chips" style={{ marginBottom: "10px" }} data-testid="div-chips">
          {withDiv.map((v) => <button class="chip" aria-pressed={code === v.code} onClick={() => pick(v)} data-testid="div-chip">{v.name}</button>)}
        </div>
      </>}
      <div class="card stack" style={{ gap: "10px" }}>
        <div class="formgrid">
          <Field label="股票代號" value={code} set={lookup} id="div-code" mode="text" />
          <Field label="現價" tag="即時" value={price} set={setPrice} id="div-price" />
          <Field label="持有股數" tag={views.some((v) => v.code === code) ? "持股" : undefined} value={shares} set={setShares} id="div-shares" mode="numeric" />
          <Field label="我的均價（可不填）" tag={views.some((v) => v.code === code) ? "持股" : undefined} value={cost} set={setCost} id="div-cost" />
          <Field label="每次配息（元）" tag={hist.length ? "近一次" : undefined} value={perPay} set={setPerPay} id="div-per" />
          <label class="field"><span>一年配幾次</span>
            <select value={perYear} onChange={(e) => setPerYear((e.target as HTMLSelectElement).value)} data-testid="div-freq">
              <option value="12">月配（12 次）</option><option value="4">季配（4 次）</option><option value="2">半年配（2 次）</option><option value="1">年配（1 次）</option>
            </select>
          </label>
        </div>
        {name && <div class="muted" style={{ fontSize: "13px" }}>{name}</div>}
        {hist.length > 0 && <div class="muted" style={{ fontSize: "12px" }} data-testid="div-hist">近一年實際配息：{hist.slice(-N).map((x) => x.toString()).join("、")} 元（證交所／櫃買除權息資料，和 ETF 配息卡同一份）</div>}
      </div>

      {!ok ? <div class="card empty" style={{ marginTop: "12px" }} data-testid="div-empty">點上面的持股，或輸入代號、股數、每次配息，就會算出每年領多少。</div> : first && plan && <>
        <div class="section-title"><span>每年領多少</span></div>
        <div class="card stack" style={{ gap: "8px" }} data-testid="div-result">
          <div class="grid2">
            <div class="metric"><div class="k">每次入帳</div><div class="v num">{n0(first.net)}</div><div class="d muted" style={{ fontSize: "11.5px" }}>{n0(first.gross)}{first.nhi ? ` − ${us ? "預扣稅" : "二代健保"} ${n0(first.nhi)}` : ""}{first.fee ? ` − 匯費 ${first.fee}` : ""}</div></div>
            <div class="metric"><div class="k">一年合計</div><div class="v num">{n0(yearNet)}</div><div class="d muted" style={{ fontSize: "11.5px" }}>平均每月 {n0(yearNet / 12)}</div></div>
            <div class="metric"><div class="k">現價殖利率</div><div class="v num">{pctPlain((D * N) / P)}</div><div class="d muted" style={{ fontSize: "11.5px" }}>{(D * N).toFixed(2)} ÷ {P}</div></div>
            <div class="metric"><div class="k">我的成本殖利率</div><div class="v num">{C > 0 ? pctPlain((D * N) / C) : "—"}</div><div class="d muted" style={{ fontSize: "11.5px" }}>{C > 0 ? `${(D * N).toFixed(2)} ÷ 均價 ${C}` : "填均價才算得出來"}</div></div>
          </div>
          <div style={{ fontSize: "13px", lineHeight: 1.7 }}>
            {us ? "美股股利預扣 30% 稅（W-8BEN 後，台灣未簽租稅協定）；複委託可能另收股利入帳手續費。"
              : <>二代健保：單次 {n0(first.gross)} 元{first.gross >= 20000 ? <>達 2 萬，<b>扣 2.11%</b></> : <>未達 2 萬，<b>不扣</b></>}<br />所得稅：股利併入綜所稅，可抵減 8.5%（每戶上限 8 萬）；或選分開計稅 28%</>}
          </div>
        </div>

        <div class="section-title"><span>股息再投入（複利）</span><span>配息金額不變的假設</span></div>
        <div class="card stack" style={{ gap: "8px" }}>
          <div class="seg tight" style={{ display: "inline-grid", width: "fit-content" }}>
            <button aria-pressed={drip} onClick={() => setDrip(true)} data-testid="div-drip">領到就買回</button>
            <button aria-pressed={!drip} onClick={() => setDrip(false)} data-testid="div-cash">領現金</button>
          </div>
          <div class="formgrid">
            <Field label="試算幾年" value={years} set={setYears} id="div-years" mode="numeric" />
            <Field label="每年股價漲跌（%）" value={growth} set={setGrowth} id="div-growth" />
            <Field label="每年另外加碼（元）" value={addYear} set={setAddYear} id="div-add" mode="numeric" />
          </div>
          <table class="calc" data-testid="div-table">
            <tr><th>第幾年</th><th>持有股數</th><th>當年股息</th><th>累計實領</th></tr>
            {showYears.map((r) => <tr><td>{r.year} 年</td><td>{n0(r.shares)}</td><td>{n0(r.yearGross)}</td><td>{n0(r.cumNet)}</td></tr>)}
          </table>
          <div class="muted" style={{ fontSize: "12px" }}>當年股息是扣稅費前；累計實領已扣二代健保與匯費。{drip ? "再投入用除息後的股價買零股（含手續費）。" : ""}</div>
        </div>

        <div class="section-title"><span>目標反推</span></div>
        <div class="card stack" style={{ gap: "8px" }}>
          <div class="formgrid">
            <Field label="想要每月領（元）" value={monthly} set={setMonthly} id="div-monthly" mode="numeric" />
            <div class="field"><span>需要持有</span><div class="v num" style={{ fontSize: "18px", fontWeight: 700, padding: "8px 0" }} data-testid="div-need">{need ? lotsTxt(need) : "—"}</div></div>
          </div>
          {need > 0 && <div style={{ fontSize: "13.5px" }} data-testid="div-need-txt">大約要投入 <b>{n0(need * P)} 元</b>（現價 {P} × {n0(need)} 股）{S > 0 && (need > S ? `；你已有 ${lotsTxt(S)}，還差 ${lotsTxt(need - S)}、約 ${n0((need - S) * P)} 元` : "；你目前的持股已經達到")}。</div>}
        </div>

        <div class="warn-box">配息不是額外賺的：除息當天股價會扣掉配息，要「填息」才是真的賺到。高息 ETF 的配息可能含收益平準金或本金，請和股價、淨值走勢一起看。</div>
      </>}
    </div>
  );
}

