// 美股「即時走勢」：盤前（04:00～9:30）、盤中（9:30～16:00）、盤後（16:00～20:00）三段分底色，
// 價格線以昨收為界上紅下綠、灰色均價線（只算盤中）、下方每分鐘成交量；點圖看那一分鐘。時間是美東時間，旁邊附台北時間。
import { useEffect, useState } from "preact/hooks";
import { avgLine } from "../data/intraday";
import { fixPrevClose, fetchUsIntraday, usClock, usSessionOf, usSessionStats, usToTaipei, US_SPAN, type UsIntraday } from "../data/usIntraday";
import { nyParts, usQuoteHours, usSession } from "../lib/dates";
import { getFetcher, useStore } from "../store";
import { fmtPrice } from "./common";

const cache = new Map<string, { at: number; d: UsIntraday | null }>(); // 切到別檔再回來不用重抓（交易時段 50 秒、其他 30 分鐘）
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const cls = (x: number) => (x > 0 ? "up" : x < 0 ? "down" : "");
const vol = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)} 百萬股` : v >= 1e4 ? `${(v / 1e4).toFixed(1)} 萬股` : `${Math.round(v).toLocaleString()} 股`);

export function UsIntradayChart({ code }: { code: string }) {
  const live = useStore((st) => st.live[code]);
  const c0 = cache.get(code);
  const [d0, setD] = useState<UsIntraday | null>(c0?.d ?? null);
  const [loading, setLoading] = useState(!c0);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const c = cache.get(code);
    setD(c?.d ?? null); setLoading(!c); setErr(""); setSel(null);
    const pull = async (force = false) => {
      const now = Date.now(), cc = cache.get(code);
      if (!force && cc && now - cc.at < (usQuoteHours() ? 50_000 : 30 * 60_000)) { if (alive) { setD(cc.d); setLoading(false); } return; }
      try { const x = await fetchUsIntraday(getFetcher(), code); cache.set(code, { at: Date.now(), d: x }); if (alive) { setD(x); setErr(""); } }
      catch (e: any) { if (alive) setErr(String(e?.message ?? e).slice(0, 80)); }
      finally { if (alive) setLoading(false); }
    };
    pull();
    const t = setInterval(() => { if (usQuoteHours()) pull(true); }, 60_000); // 盤前到盤後每分鐘更新
    return () => { alive = false; clearInterval(t); };
  }, [code]);

  if (loading && !d0) return <div class="empty" data-testid="us-intra-loading">即時走勢載入中…</div>;
  if (!d0) return <div class="empty" data-testid="us-intra-empty">{err ? `即時走勢下載失敗（${err}）` : "還沒有今天的分時資料"}</div>;
  const { d, src: refSrc } = fixPrevClose(d0, live);

  const pts = d.points, ref = d.prevClose;
  const st = usSessionStats(d);
  const regPts = pts.filter((p) => p.m >= d.regStart && p.m < d.regEnd);
  const avg = avgLine(regPts);
  const hi = Math.max(...pts.map((p) => p.price)), lo = Math.min(...pts.map((p) => p.price));
  const dev = Math.max(Math.abs(hi - ref), Math.abs(lo - ref), ref * 0.01) * 1.12;
  const top = ref + dev, bot = ref - dev;
  const W = 340, H = 170, VH = 50, padL = 44, padR = 40, padT = 14, gap = 14;
  const x = (m: number) => padL + (m / US_SPAN) * (W - padL - padR);
  const y = (p: number) => padT + ((top - p) / (top - bot)) * (H - padT);
  const path = (a: { m: number }[], vs: number[]) => a.map((p, i) => `${i ? "L" : "M"}${x(p.m).toFixed(1)},${y(vs[i]).toFixed(1)}`).join("");
  const maxV = Math.max(1, ...pts.map((p) => p.vol));
  const vy0 = H + gap + VH;
  const last = pts[pts.length - 1];
  const cur = sel !== null ? pts[sel] : last;
  const curSess = usSessionOf(d, cur.m);
  const chgRef = curSess === "盤後" ? (regPts.at(-1)?.price ?? ref) : ref;
  const chg = cur.price - chgRef, cp = chg / chgRef;
  const now = usSession();
  const today = d.date === nyParts().ymd;
  const liveLabel = today && (now === "盤前" || now === "盤中" || now === "盤後") ? `現在${now}・即時` : today ? "今天已收盤" : "最近一個交易日";
  const pick = (ev: any) => {
    const r = (ev.currentTarget as SVGSVGElement).getBoundingClientRect();
    const mx = ((ev.clientX - r.left) / r.width) * W;
    let best = 0;
    pts.forEach((p, i) => { if (Math.abs(x(p.m) - mx) < Math.abs(x(pts[best].m) - mx)) best = i; });
    setSel(best === pts.length - 1 ? null : best);
  };
  const band = (a: number, b: number, label: string, shade: boolean) => (
    <g>
      {shade && <rect x={x(a)} y={padT - 12} width={x(b) - x(a)} height={vy0 - padT + 12} fill="var(--surface-2)" />}
      <text x={(x(a) + x(b)) / 2} y={padT - 3} font-size="10" text-anchor="middle" fill="var(--muted)">{label}</text>
    </g>
  );
  const md = `${d.date.slice(4, 6)}/${d.date.slice(6)}`;
  const sess = (k: "pre" | "reg" | "post", label: string, note: string) => {
    const s = st[k];
    return (
      <div style={{ flex: "1 1 0", minWidth: 0, textAlign: "center", padding: "4px 2px", borderRadius: "8px", background: curSess === label ? "var(--surface-2)" : "transparent" }} data-testid={`us-intra-${k}`}>
        <div class="muted" style={{ fontSize: "11px" }}>{label}</div>
        {s ? <><div class="num" style={{ fontSize: "14px", fontWeight: 700 }}>{fmtPrice(s.last)}</div><div class={`num ${cls(s.chg)}`} style={{ fontSize: "11.5px" }}>{pct(s.chg)}</div></> : <div class="muted" style={{ fontSize: "12px" }}>—</div>}
        <div class="muted" style={{ fontSize: "10px" }}>{note}</div>
      </div>
    );
  };

  return (
    <div data-testid="us-intraday-chart" data-pts={pts.length} data-loaded={loading ? "0" : "1"} data-ref={refSrc} data-prev={ref}>
      <div class="row num" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "2px 10px" }}>
        <span data-testid="us-intra-head">
          <b class={cls(chg)} style={{ fontSize: "20px" }}>{fmtPrice(cur.price)}</b>{" "}
          <span class={cls(chg)}>{chg > 0 ? "▲" : chg < 0 ? "▼" : ""}{fmtPrice(Math.abs(chg))}（{pct(cp)}）</span>
        </span>
        <span class="muted" style={{ fontSize: "12px" }}>{sel !== null ? `${curSess} 美東 ${usClock(cur.m)}・量 ${vol(cur.vol)}` : `${md} ${curSess} 美東 ${usClock(cur.m)}（台北 ${usToTaipei(cur.m, d.tz)}）・${liveLabel}`}</span>
      </div>
      <div class="row" style={{ flexWrap: "nowrap", gap: "4px", marginTop: "6px" }} data-testid="us-intra-sessions">
        {sess("pre", "盤前", "對照昨收")}
        {sess("reg", "盤中", "對照昨收")}
        {sess("post", "盤後", "對照盤中收盤")}
      </div>
      <div class="row num muted" style={{ fontSize: "12px", gap: "4px 12px", flexWrap: "wrap", marginTop: "4px" }} data-testid="us-intra-stats">
        <span>昨收 {fmtPrice(ref)}</span>
        {st.regHigh !== undefined && <span>盤中最高 <span class={cls(st.regHigh - ref)}>{fmtPrice(st.regHigh)}</span></span>}
        {st.regLow !== undefined && <span>最低 <span class={cls(st.regLow - ref)}>{fmtPrice(st.regLow)}</span></span>}
        <span>盤中量 {vol(st.regVol)}</span>
        {st.extVol > 0 && <span>盤前後量 {vol(st.extVol)}</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${vy0 + 16}`} width="100%" role="img" aria-label="美股即時走勢" onClick={pick} style={{ touchAction: "pan-y", marginTop: "6px" }}>
        <defs>
          <clipPath id={`ua-${code}`}><rect x="0" y="0" width={W} height={y(ref)} /></clipPath>
          <clipPath id={`ub-${code}`}><rect x="0" y={y(ref)} width={W} height={H - y(ref)} /></clipPath>
        </defs>
        {band(0, d.regStart, "盤前", true)}
        {band(d.regStart, d.regEnd, "盤中", false)}
        {band(d.regEnd, US_SPAN, "盤後", true)}
        {[top, (top + ref) / 2, (ref + bot) / 2, bot].map((p) => <line key={p} x1={padL} x2={W - padR} y1={y(p)} y2={y(p)} stroke="var(--line)" />)}
        <line x1={padL} x2={W - padR} y1={y(ref)} y2={y(ref)} stroke="var(--muted)" stroke-dasharray="3 3" />
        <text x={padL - 3} y={y(top) + 9} font-size="10" text-anchor="end" fill="var(--up)">{fmtPrice(top)}</text>
        <text x={padL - 3} y={y(ref) + 3} font-size="10" text-anchor="end" fill="var(--fg)">{fmtPrice(ref)}</text>
        <text x={padL - 3} y={y(bot) - 2} font-size="10" text-anchor="end" fill="var(--down)">{fmtPrice(bot)}</text>
        <text x={W - padR + 3} y={y(top) + 9} font-size="10" fill="var(--up)">+{((dev / ref) * 100).toFixed(1)}%</text>
        <text x={W - padR + 3} y={y(bot) - 2} font-size="10" fill="var(--down)">-{((dev / ref) * 100).toFixed(1)}%</text>
        {regPts.length > 1 && <path d={path(regPts, avg)} fill="none" stroke="var(--muted)" stroke-width="1.2" data-testid="us-intra-avg" />}
        <path d={path(pts, pts.map((p) => p.price))} fill="none" stroke="var(--up)" stroke-width="1.5" clip-path={`url(#ua-${code})`} data-testid="us-intra-line" />
        <path d={path(pts, pts.map((p) => p.price))} fill="none" stroke="var(--down)" stroke-width="1.5" clip-path={`url(#ub-${code})`} />
        <circle cx={x(cur.m)} cy={y(cur.price)} r="3" fill={chg >= 0 ? "var(--up)" : "var(--down)"} />
        {sel !== null && <line x1={x(cur.m)} x2={x(cur.m)} y1={padT} y2={vy0} stroke="var(--fg)" stroke-opacity="0.5" />}
        <line x1={padL} x2={W - padR} y1={vy0} y2={vy0} stroke="var(--line)" />
        {pts.map((p, i) => { const h = (p.vol / maxV) * VH; const pr = i ? pts[i - 1].price : ref; return h > 0 ? <rect key={p.m} x={x(p.m) - 0.5} y={vy0 - h} width="1" height={h} fill={p.price >= pr ? "var(--up)" : "var(--down)"} opacity="0.7" /> : null; })}
        {[[0, "4:00"], [d.regStart, "9:30"], [d.regEnd, "16:00"], [US_SPAN, "20:00"]].map(([m, t], i) => <text key={t} x={x(m as number)} y={vy0 + 12} font-size="10" text-anchor={i === 0 ? "start" : i === 3 ? "end" : "middle"} fill="var(--muted)">{t}</text>)}
      </svg>
      <div class="muted" style={{ fontSize: "11.5px", lineHeight: 1.6 }} data-testid="us-intra-note">
        時間是美東時間（台北 {usToTaipei(0, d.tz)} 盤前開始、{usToTaipei(d.regStart, d.tz)} 開盤、{usToTaipei(d.regEnd, d.tz)} 收盤）。灰底是盤前、盤後；灰線是盤中均價；昨收以上紅、以下綠。點圖看那一分鐘，再點最右邊回到最新。盤前到盤後每分鐘更新。
      </div>
    </div>
  );
}
