// 詳情頁的 K 線圖（Canvas）：K 線＋5/20/60 日均線、成交量、下方可切換 KD／MACD／RSI。
// 手指：左右拖曳平移、兩指縮放、點一下看那一天的數字；另有 ＋／－／全部 按鈕（電腦滾輪也可縮放）。
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { kdSeries, macdSeries, rsiSeries, smaSeries } from "../engine/indicators";

export interface CandleBar { date: string; open: number; high: number; low: number; close: number; volume: number }
type Tab = "KD" | "MACD" | "RSI";

const MA_DEFS = [
  { n: 5, color: "#3b8bef", label: "5日" },
  { n: 20, color: "", label: "20日" }, // 空字串＝用主題的強調色
  { n: 60, color: "#a46be0", label: "60日" },
] as const;
const MIN_BARS = 20;
const DEFAULT_BARS = 90;

const fmtP = (v: number) => (Number.isFinite(v) ? (v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(v >= 100 ? 1 : 2)) : "—");
const fmtN = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const dstr = (s: string) => `${+s.slice(4, 6)}/${+s.slice(6, 8)}`;
const fmtVol = (v: number) => (v >= 1e8 ? `${(v / 1e8).toFixed(2)} 億股` : v >= 1e4 ? `${Math.round(v / 1e3).toLocaleString()} 張` : `${v} 股`);

interface View { start: number; count: number }
const clampView = (v: View, n: number): View => {
  const count = Math.min(n, Math.max(Math.min(MIN_BARS, n), Math.round(v.count)));
  const start = Math.min(n - count, Math.max(0, v.start));
  return { start, count };
};

export function CandleChart({ bars }: { bars: CandleBar[] }) {
  const n = bars.length;
  const ref = useRef<HTMLCanvasElement>(null);
  const [tab, setTab] = useState<Tab>("KD");
  const [view, setViewState] = useState<View>(() => clampView({ start: n, count: DEFAULT_BARS }, n));
  const [sel, setSel] = useState<number | null>(null);
  const viewRef = useRef(view);
  const setView = (v: View) => { const c = clampView(v, n); viewRef.current = c; setViewState(c); };
  useEffect(() => { setView({ start: n, count: viewRef.current.count }); setSel(null); }, [bars]);

  const ind = useMemo(() => {
    const closes = bars.map((b) => b.close);
    return {
      ma: MA_DEFS.map((m) => smaSeries(closes, m.n)),
      kd: kdSeries(bars),
      macd: macdSeries(closes),
      rsi: rsiSeries(closes),
    };
  }, [bars]);

  // ---------- 畫圖 ----------
  useEffect(() => {
    const c = ref.current;
    if (!c || n < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const col = (k: string) => css.getPropertyValue(k).trim();
    const up = col("--up"), down = col("--down"), muted = col("--muted"), line = col("--line"), accent = col("--accent");
    const maColor = MA_DEFS.map((m) => m.color || accent);
    const { start, count } = view;
    const end = start + count; // 不含
    const i0 = Math.max(0, Math.floor(start)), i1 = Math.min(n, Math.ceil(end)); // 平移時 start 可以是小數
    const padL = 4, padR = 46, padT = 6, priceH = 190, volH = 44, indH = 84, gap = 8, axisH = 14;
    const plotW = w - padL - padR;
    const sw = plotW / count;
    const cx = (i: number) => padL + (i - start + 0.5) * sw;
    g.font = "11px sans-serif"; g.textBaseline = "middle";

    // 價格範圍
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i < i1; i++) {
      lo = Math.min(lo, bars[i].low); hi = Math.max(hi, bars[i].high);
      for (const m of ind.ma) if (Number.isFinite(m[i])) { lo = Math.min(lo, m[i]); hi = Math.max(hi, m[i]); }
    }
    const pad = (hi - lo) * 0.05 || 1; lo -= pad; hi += pad;
    const py = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * priceH;
    const hline = (yy: number, color = line) => { g.strokeStyle = color; g.lineWidth = 1; g.beginPath(); g.moveTo(padL, yy); g.lineTo(w - padR, yy); g.stroke(); };
    g.fillStyle = muted; g.textAlign = "left";
    for (let k = 0; k <= 3; k++) { const v = lo + ((hi - lo) * k) / 3, yy = py(v); hline(yy); g.fillText(fmtP(v), w - padR + 4, yy); }

    // K 線
    const bw = Math.max(1, Math.min(14, sw * 0.7));
    for (let i = i0; i < i1; i++) {
      const b = bars[i];
      const color = b.close >= b.open ? up : down;
      g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 1;
      g.beginPath(); g.moveTo(cx(i), py(b.high)); g.lineTo(cx(i), py(b.low)); g.stroke();
      const y1 = py(Math.max(b.open, b.close)), y2 = py(Math.min(b.open, b.close));
      g.fillRect(cx(i) - bw / 2, y1, bw, Math.max(1, y2 - y1));
    }
    // 均線
    const drawLine = (vals: number[], color: string, yf: (v: number) => number, width = 1.2) => {
      g.strokeStyle = color; g.lineWidth = width; g.beginPath();
      let on = false;
      for (let i = i0; i < i1; i++) {
        const v = vals[i];
        if (!Number.isFinite(v)) { on = false; continue; }
        if (!on) { g.moveTo(cx(i), yf(v)); on = true; } else g.lineTo(cx(i), yf(v));
      }
      g.stroke();
    };
    ind.ma.forEach((m, k) => drawLine(m, maColor[k], py));

    // 成交量
    const vTop = padT + priceH + gap;
    let vmax = 1;
    for (let i = i0; i < i1; i++) if (Number.isFinite(bars[i].volume)) vmax = Math.max(vmax, bars[i].volume);
    for (let i = i0; i < i1; i++) {
      const b = bars[i];
      g.fillStyle = b.close >= b.open ? up : down; g.globalAlpha = 0.55;
      const hh = (b.volume / vmax) * volH;
      g.fillRect(cx(i) - bw / 2, vTop + volH - hh, bw, hh);
    }
    g.globalAlpha = 1;
    hline(vTop + volH);
    g.fillStyle = muted; g.fillText("量", w - padR + 4, vTop + 6);

    // 指標區
    const iTop = vTop + volH + gap;
    let ilo = 0, ihi = 100;
    if (tab === "MACD") {
      ilo = Infinity; ihi = -Infinity;
      for (let i = i0; i < i1; i++) for (const v of [ind.macd.dif[i], ind.macd.macd[i], ind.macd.osc[i]]) if (Number.isFinite(v)) { ilo = Math.min(ilo, v); ihi = Math.max(ihi, v); }
      if (!Number.isFinite(ilo)) { ilo = -1; ihi = 1; }
      const m = Math.max(Math.abs(ilo), Math.abs(ihi)) * 1.1 || 1; ilo = -m; ihi = m;
    }
    const iy = (v: number) => iTop + (1 - (v - ilo) / (ihi - ilo)) * indH;
    hline(iTop); hline(iTop + indH);
    g.fillStyle = muted;
    if (tab === "MACD") {
      hline(iy(0));
      g.fillText(fmtN(ihi, 2), w - padR + 4, iTop + 6); g.fillText(fmtN(ilo, 2), w - padR + 4, iTop + indH - 6);
      for (let i = i0; i < i1; i++) {
        const o = ind.macd.osc[i]; if (!Number.isFinite(o)) continue;
        g.fillStyle = o >= 0 ? up : down; g.globalAlpha = 0.6;
        const y0 = iy(0), y1 = iy(o);
        g.fillRect(cx(i) - bw / 2, Math.min(y0, y1), bw, Math.max(1, Math.abs(y1 - y0)));
      }
      g.globalAlpha = 1;
      drawLine(ind.macd.dif, "#3b8bef", iy); drawLine(ind.macd.macd, accent, iy);
    } else {
      const guides = tab === "KD" ? [20, 80] : [30, 70];
      for (const v of guides) { g.setLineDash([3, 3]); hline(iy(v)); g.setLineDash([]); g.fillStyle = muted; g.fillText(String(v), w - padR + 4, iy(v)); }
      if (tab === "KD") { drawLine(ind.kd.d, "#3b8bef", iy); drawLine(ind.kd.k, accent, iy); }
      else drawLine(ind.rsi, accent, iy);
    }

    // 日期（約 4 個刻度）
    g.fillStyle = muted; g.textBaseline = "alphabetic"; g.textAlign = "center";
    const ay = iTop + indH + axisH - 2;
    const ticks = Math.min(4, count);
    for (let k = 0; k < ticks; k++) {
      const i = Math.min(i1 - 1, i0 + Math.round(((i1 - i0 - 1) * k) / Math.max(1, ticks - 1)));
      g.fillText(dstr(bars[i].date), Math.min(w - padR - 14, Math.max(padL + 14, cx(i))), ay);
    }
    // 選取的那天：垂直線
    if (sel !== null && sel >= i0 && sel < i1) {
      g.strokeStyle = muted; g.setLineDash([4, 3]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(cx(sel), padT); g.lineTo(cx(sel), iTop + indH); g.stroke(); g.setLineDash([]);
    }
  }, [bars, view, tab, sel, ind]);

  // ---------- 手勢 ----------
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ moved: 0, startX: 0, startView: view as View, pinchDist: 0, pinchView: view as View });
  const geom = () => {
    const c = ref.current!; const w = c.clientWidth; const plotW = w - 4 - 46;
    return { w, plotW, rect: c.getBoundingClientRect() };
  };
  const onDown = (e: PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const gs = gesture.current;
    if (pts.current.size === 1) { gs.moved = 0; gs.startX = e.clientX; gs.startView = viewRef.current; }
    if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      gs.pinchDist = Math.hypot(a.x - b.x, a.y - b.y) || 1; gs.pinchView = viewRef.current; gs.moved = 99;
    }
  };
  const onMove = (e: PointerEvent) => {
    if (!pts.current.has(e.pointerId)) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const gs = gesture.current; const { plotW, rect } = geom();
    if (pts.current.size >= 2) {
      const [a, b] = [...pts.current.values()];
      const ratio = (Math.hypot(a.x - b.x, a.y - b.y) || 1) / gs.pinchDist;
      const pv = gs.pinchView;
      const count = Math.min(n, Math.max(MIN_BARS, pv.count / ratio));
      const mid = ((a.x + b.x) / 2 - rect.left - 4) / plotW; // 兩指中心在視窗中的位置
      const anchor = pv.start + pv.count * Math.min(1, Math.max(0, mid));
      setView({ start: anchor - count * Math.min(1, Math.max(0, mid)), count });
    } else {
      const dx = e.clientX - gs.startX; gs.moved = Math.max(gs.moved, Math.abs(dx));
      if (gs.moved > 6) { const per = plotW / gs.startView.count; setView({ start: gs.startView.start - dx / per, count: gs.startView.count }); }
    }
  };
  const onUp = (e: PointerEvent) => {
    const gs = gesture.current;
    if (pts.current.size === 1 && gs.moved <= 6) {
      const { plotW, rect } = geom(); const v = viewRef.current;
      const i = Math.floor(v.start + ((e.clientX - rect.left - 4) / plotW) * v.count);
      if (i >= v.start && i < v.start + v.count) setSel((cur) => (cur === i ? null : i));
    }
    pts.current.delete(e.pointerId);
    if (pts.current.size === 1) { const p = [...pts.current.values()][0]; gs.startX = p.x; gs.startView = viewRef.current; gs.moved = 99; }
  };
  const zoom = (f: number, anchorFrac = 1) => {
    const v = viewRef.current; const count = Math.min(n, Math.max(MIN_BARS, v.count * f));
    const anchor = v.start + v.count * anchorFrac;
    setView({ start: anchor - count * anchorFrac, count });
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const { plotW, rect } = geom();
    zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, Math.min(1, Math.max(0, (e.clientX - rect.left - 4) / plotW)));
  };
  useEffect(() => {
    const c = ref.current; if (!c) return;
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, [n]);

  // ---------- 文字資訊 ----------
  const idx = sel !== null && sel < n ? sel : n - 1;
  const b = bars[idx];
  const prev = idx > 0 ? bars[idx - 1].close : b.open;
  const chg = prev > 0 ? b.close / prev - 1 : 0;
  const indText = tab === "KD" ? `K ${fmtN(ind.kd.k[idx])}　D ${fmtN(ind.kd.d[idx])}`
    : tab === "MACD" ? `DIF ${fmtN(ind.macd.dif[idx], 2)}　MACD ${fmtN(ind.macd.macd[idx], 2)}　柱 ${fmtN(ind.macd.osc[idx], 2)}`
    : `RSI(14) ${fmtN(ind.rsi[idx])}`;
  return (
    <div data-testid="candle-chart">
      <div class="muted num" style={{ fontSize: "12px", lineHeight: 1.6 }} data-testid="candle-info">
        <span>{sel !== null ? dstr(b.date) : "最新"}　開 {fmtP(b.open)}　高 {fmtP(b.high)}　低 {fmtP(b.low)}　收 {fmtP(b.close)}　</span>
        <span class={chg >= 0 ? "up" : "down"}>{chg >= 0 ? "+" : ""}{(chg * 100).toFixed(2)}%</span>
        <span>　量 {fmtVol(b.volume)}</span>
      </div>
      <div class="row num" style={{ fontSize: "12px", gap: "10px", flexWrap: "wrap" }} data-testid="candle-ma">
        {MA_DEFS.map((m, k) => <span key={m.n} style={{ color: m.color || "var(--accent)" }}>{m.label} {fmtP(ind.ma[k][idx])}</span>)}
      </div>
      <canvas ref={ref} class="chart candle" aria-label="K 線圖"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
      <div class="row" style={{ justifyContent: "space-between", marginTop: "6px", gap: "8px" }}>
        <div class="seg" role="group" aria-label="技術指標">
          {(["KD", "MACD", "RSI"] as Tab[]).map((t) => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)} data-testid={`ind-${t}`}>{t}</button>)}
        </div>
        <div class="seg" role="group" aria-label="縮放">
          <button onClick={() => zoom(1 / 1.5)} aria-label="放大" data-testid="zoom-in">＋</button>
          <button onClick={() => zoom(1.5)} aria-label="縮小" data-testid="zoom-out">－</button>
          <button onClick={() => setView({ start: 0, count: n })} data-testid="zoom-all">全部</button>
        </div>
      </div>
      <div class="muted num" style={{ fontSize: "12px", marginTop: "4px" }} data-testid="candle-ind">{indText}　<span>（顯示 {view.count} 日・左右拖曳、兩指縮放、點一下看當天）</span></div>
    </div>
  );
}
