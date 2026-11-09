// 個股「即時走勢」：當日分時圖（價格線以昨收為界，上紅下綠；白色均價線；下方每分鐘成交量），
// 左軸價格、右軸漲跌幅；點圖看那一分鐘。資料：Yahoo 1 分鐘線＋證交所即時價（每 30 秒）。
import { useEffect, useMemo, useState } from "preact/hooks";
import { avgLine, cachedIntraday, clockOf, esbOpen, loadIntraday, mergeLive, sessionOf, type Intraday } from "../data/intraday";
import { marketOpen } from "../data/twLive";
import { isEtf } from "../data/tw";
import { limitDownPrice, limitUpPrice } from "../lib/limit";
import { getFetcher, useStore } from "../store";
import { fmtPrice } from "./common";

const ticksByCode = new Map<string, { date: string; ticks: { m: number; price: number; cum?: number }[] }>(); // 這次開 App 以來記下的即時價（含累計成交量）

const isOpen = (market: string) => (market === "ESB" ? esbOpen() : marketOpen());
const maxAge = (market = "TWSE") => (isOpen(market) ? 50_000 : 30 * 60_000);

/** 預先載入（清單裡前後幾檔）：背景抓好放快取，切過去馬上有圖 */
export function prefetchIntraday(list: { code: string; market: string }[]) {
  for (const x of list) if (x.market === "TWSE" || x.market === "TPEX") loadIntraday(getFetcher(), x.code, x.market, maxAge()).catch(() => {});
}

export function IntradayChart({ code, market, prefetch }: { code: string; market: string; prefetch?: { code: string; market: string }[] }) {
  const live = useStore((s) => s.live[code]);
  const esb = market === "ESB", span = sessionOf(market), open = isOpen(market);
  const [yd, setYd] = useState<Intraday | null>(() => cachedIntraday(code)?.d ?? null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(() => !cachedIntraday(code)?.at);
  const [sel, setSel] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    // 換股票時先拿快取（有就馬上畫，沒有才顯示載入中），再視需要背景更新
    const c = cachedIntraday(code);
    setYd(c?.d ?? null); setSel(null); setErr(""); setLoading(!c?.at);
    const pull = async () => {
      try { const d = await loadIntraday(getFetcher(), code, market, maxAge(market)); if (alive) { setYd(d); setErr(""); } }
      catch (e: any) { if (alive) setErr(String(e?.message ?? e).slice(0, 80)); }
      finally { if (alive) setLoading(false); }
    };
    pull().then(() => { if (alive && prefetch?.length) prefetchIntraday(prefetch); });
    const t = setInterval(() => { if (isOpen(market)) pull(); }, 60_000); // 盤中每分鐘重抓分鐘線（即時價另外每 30 秒更新）
    return () => { alive = false; clearInterval(t); };
  }, [code]);
  // 記下即時價：Yahoo 落後時，這幾分鐘用它補
  if (live?.time && live.time >= "09:00" && !live.trial && live.price > 0 && live.date) {
    const rec = ticksByCode.get(code);
    const r = rec && rec.date === live.date ? rec : { date: live.date, ticks: [] };
    const [h, mm] = live.time.split(":").map(Number);
    const m = Math.min(span, (h - 9) * 60 + mm);
    if (m >= 0) { const k = r.ticks.findIndex((x) => x.m === m); const t = { m, price: live.price, cum: live.volume }; if (k >= 0) r.ticks[k] = t; else r.ticks.push(t); }
    ticksByCode.set(code, r);
  }
  const d = useMemo(() => mergeLive(yd, live && !live.trial ? live : undefined, ticksByCode.get(code)?.ticks ?? [], span), [yd, live?.price, live?.time, live?.volume]);

  if (loading && !d) return <div class="empty" data-testid="intra-loading">即時走勢載入中…</div>;
  if (!d || !d.points.length) return <div class="empty" data-testid="intra-empty">{err ? `即時走勢下載失敗（${err}）` : "今天還沒有成交（09:00 開盤後出現）"}</div>;

  const pts = d.points, ref = d.prevClose, etf = isEtf(code);
  const avg = avgLine(pts);
  const hi = Math.max(...pts.map((p) => p.price)), lo = Math.min(...pts.map((p) => p.price));
  const dev = Math.max(Math.abs(hi - ref), Math.abs(lo - ref), ref * 0.01) * 1.12;
  const top = ref + dev, bot = ref - dev;
  const W = 340, H = 170, VH = 60, padL = 44, padR = 40, padT = 8, gap = 14;
  const x = (m: number) => padL + (m / span) * (W - padL - padR);
  const y = (p: number) => padT + ((top - p) / (top - bot)) * (H - padT);
  const line = (vs: number[]) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.m).toFixed(1)},${y(vs[i]).toFixed(1)}`).join("");
  const est = d.est ?? [];
  const maxV = Math.max(1, ...pts.map((p) => p.vol), ...est.map((e) => e.vol));
  const lastVol = pts[pts.length - 1].vol;
  const vy0 = H + gap + VH;
  const last = pts[pts.length - 1];
  const cur = sel !== null ? pts[sel] : last;
  const chg = cur.price - ref, pct = chg / ref;
  const cc = chg > 0 ? "up" : chg < 0 ? "down" : "";
  const totalVol = pts.reduce((a, p) => a + p.vol, 0);
  const hiI = pts.findIndex((p) => p.price === hi), loI = pts.findIndex((p) => p.price === lo);
  const up = limitUpPrice(ref, etf), dn = limitDownPrice(ref, etf);
  const pick = (ev: any) => {
    const svg = ev.currentTarget as SVGSVGElement;
    const r = svg.getBoundingClientRect();
    const mx = ((ev.clientX - r.left) / r.width) * W;
    let best = 0;
    pts.forEach((p, i) => { if (Math.abs(x(p.m) - mx) < Math.abs(x(pts[best].m) - mx)) best = i; });
    setSel(best === pts.length - 1 ? null : best);
  };
  const md = d.date.length === 8 ? `${d.date.slice(4, 6)}/${d.date.slice(6)} ` : "";
  const lag = d.lastYahoo !== undefined && last.m - d.lastYahoo > 1;
  return (
    <div data-testid="intraday-chart" data-date={d.date} data-yahoo={yd ? yd.points.length : 0} data-src={(yd as any)?.src ?? ""} data-twerr={yd?.twErr ?? ""} data-err={err} data-loaded={loading ? "0" : "1"}>
      <div class="row num" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "2px 10px" }}>
        <span data-testid="intra-head">
          <b class={cc} style={{ fontSize: "20px" }}>{fmtPrice(cur.price)}</b>{" "}
          <span class={cc}>{chg > 0 ? "▲" : chg < 0 ? "▼" : ""}{fmtPrice(Math.abs(chg))}（{pct >= 0 ? "+" : ""}{(pct * 100).toFixed(2)}%）</span>
        </span>
        <span class="muted" style={{ fontSize: "12px" }}>{sel !== null ? `${clockOf(cur.m)}・量 ${Math.round(cur.vol / 1000).toLocaleString()} 張` : `${md}${clockOf(last.m)}${open ? " 盤中" : " 收盤"}`}</span>
      </div>
      <div class="row num muted" style={{ fontSize: "12px", gap: "4px 12px", flexWrap: "wrap", marginTop: "2px" }} data-testid="intra-stats">
        <span>{esb ? "參考價" : "昨收"} {fmtPrice(ref)}</span><span>最高 <span class={hi > ref ? "up" : hi < ref ? "down" : ""}>{fmtPrice(hi)}</span></span><span>最低 <span class={lo > ref ? "up" : lo < ref ? "down" : ""}>{fmtPrice(lo)}</span></span>
        <span>均價 {fmtPrice(avg[avg.length - 1])}</span><span>總量 {Math.round(Math.max(totalVol + est.reduce((a, e) => a + e.vol, 0), live?.volume ?? 0) / 1000).toLocaleString()} 張</span><span data-testid="intra-lastvol">單量 {Math.round(lastVol / 1000).toLocaleString()} 張</span>
        {!esb && <span>漲停 <span class="up">{fmtPrice(up)}</span>・跌停 <span class="down">{fmtPrice(dn)}</span></span>}
      </div>
      <svg viewBox={`0 0 ${W} ${vy0 + 16}`} width="100%" role="img" aria-label="即時走勢" onClick={pick} style={{ touchAction: "pan-y", marginTop: "6px" }}>
        <defs>
          <clipPath id={`ia-${code}`}><rect x="0" y="0" width={W} height={y(ref)} /></clipPath>
          <clipPath id={`ib-${code}`}><rect x="0" y={y(ref)} width={W} height={H - y(ref)} /></clipPath>
        </defs>
        {Array.from({ length: Math.floor((span - 1) / 60) }, (_, k) => k + 1).map((h) => <line key={h} x1={x(h * 60)} x2={x(h * 60)} y1={padT} y2={H} stroke="var(--line)" />)}
        {[top, (top + ref) / 2, (ref + bot) / 2, bot].map((p) => <line key={p} x1={padL} x2={W - padR} y1={y(p)} y2={y(p)} stroke="var(--line)" />)}
        <line x1={padL} x2={W - padR} y1={y(ref)} y2={y(ref)} stroke="var(--muted)" stroke-dasharray="3 3" />
        <text x={padL - 3} y={y(top) + 9} font-size="10" text-anchor="end" fill="var(--up)">{fmtPrice(top)}</text>
        <text x={padL - 3} y={y(ref) + 3} font-size="10" text-anchor="end" fill="var(--fg)">{fmtPrice(ref)}</text>
        <text x={padL - 3} y={y(bot) - 2} font-size="10" text-anchor="end" fill="var(--down)">{fmtPrice(bot)}</text>
        <text x={W - padR + 3} y={y(top) + 9} font-size="10" fill="var(--up)">+{((dev / ref) * 100).toFixed(1)}%</text>
        <text x={W - padR + 3} y={y(bot) - 2} font-size="10" fill="var(--down)">-{((dev / ref) * 100).toFixed(1)}%</text>
        <path d={line(avg)} fill="none" stroke="var(--muted)" stroke-width="1.2" data-testid="intra-avg" />
        <path d={line(pts.map((p) => p.price))} fill="none" stroke="var(--up)" stroke-width="1.6" clip-path={`url(#ia-${code})`} data-testid="intra-line" />
        <path d={line(pts.map((p) => p.price))} fill="none" stroke="var(--down)" stroke-width="1.6" clip-path={`url(#ib-${code})`} />
        {hiI >= 0 && hi > ref && <text x={Math.min(W - padR - 20, Math.max(padL + 16, x(pts[hiI].m)))} y={Math.max(padT + 9, y(hi) - 3)} font-size="10" text-anchor="middle" fill="var(--fg)">{fmtPrice(hi)}</text>}
        {loI >= 0 && lo < ref && <text x={Math.min(W - padR - 20, Math.max(padL + 16, x(pts[loI].m)))} y={Math.min(H - 2, y(lo) + 11)} font-size="10" text-anchor="middle" fill="var(--fg)">{fmtPrice(lo)}</text>}
        <circle cx={x(cur.m)} cy={y(cur.price)} r="3" fill={chg >= 0 ? "var(--up)" : "var(--down)"} />
        {sel !== null && <line x1={x(cur.m)} x2={x(cur.m)} y1={padT} y2={vy0} stroke="var(--fg)" stroke-opacity="0.5" />}
        <line x1={padL} x2={W - padR} y1={vy0} y2={vy0} stroke="var(--line)" />
        <text x={padL - 3} y={vy0 - VH + 9} font-size="10" text-anchor="end" fill="var(--muted)">{Math.round(maxV / 1000).toLocaleString()}</text>
        <text x={padL - 3} y={vy0 - 2} font-size="10" text-anchor="end" fill="var(--muted)">量</text>
        {est.map((e) => { const h = (e.vol / maxV) * VH; return <rect key={`e${e.m}`} x={x(e.m) - 0.6} y={vy0 - h} width="1.2" height={h} fill="var(--muted)" opacity="0.35" data-testid="intra-est" />; })}
        {pts.map((p, i) => { const h = (p.vol / maxV) * VH; const pr = i ? pts[i - 1].price : ref; return h > 0 ? <rect key={p.m} data-testid="intra-vol" x={x(p.m) - 0.6} y={vy0 - h} width="1.2" height={h} fill={p.price >= pr ? "var(--up)" : "var(--down)"} opacity="0.75" /> : null; })}
        {Array.from({ length: Math.floor((span - 1) / 60) + 1 }, (_, k) => k * 60).filter((m) => span - m >= 40).map((m) => <text key={m} x={x(m)} y={vy0 + 12} font-size="10" text-anchor={m === 0 ? "start" : "middle"} fill="var(--muted)">{9 + m / 60}</text>)}
        <text x={x(span)} y={vy0 + 12} font-size="10" text-anchor="end" fill="var(--muted)">{clockOf(span)}</text>
      </svg>
      <div class="muted" style={{ fontSize: "11.5px", lineHeight: 1.6 }} data-testid="intra-note">
        {loading ? "分鐘線下載中，先畫即時價…" : ""}{esb ? "參考價" : "昨收"}以上紅色、以下綠色；灰線是均價（成交量加權）；下方是每分鐘成交量（張），「單量」是最新一分鐘{est.length ? "，淡色量柱是分鐘線還沒到的那幾分鐘、平均估算" : ""}。點圖看那一分鐘，再點最右邊回到最新。{esb ? "盤中每分鐘用櫃買中心興櫃行情更新" : "盤中每 30 秒用證交所即時價更新"}{lag ? `（分鐘線到 ${clockOf(d.lastYahoo!)}，之後是即時價）` : ""}。
      </div>
    </div>
  );
}
