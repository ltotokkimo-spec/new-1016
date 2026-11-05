import { useEffect, useRef, useState } from "preact/hooks";
import { autoRefresh, etfAlertsNow, findScored, init, refreshEsb, refreshMacro, refreshTw, refreshUs, useStore, type AiJob, type Market } from "./store";
import type { Scored } from "./engine/score";
import { pretty, taipeiToday } from "./lib/dates";
import { livePolling } from "./data/twLive";
import { AiEtfScreen } from "./ui/aiEtf";
import { EtfRankScreen } from "./ui/etfRank";
import { AiJobBanner, HoldingsScreen, MacroScreen, PicksScreen, SectorsScreen, SettingsScreen, StockDetail, UpdateBanner } from "./ui/screens";

type Tab = "picks" | "sectors" | "holdings" | "aietf" | "macro" | "etfrank" | "settings";

const ICONS: Record<Tab, string> = {
  picks: "M3 17l5-5 4 4 8-9M14 7h6v6",
  sectors: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  holdings: "M3 7h18v12H3zM8 7V5h8v2M3 12h18",
  aietf: "M21 12a9 9 0 11-9-9v9zM12 3a9 9 0 019 9h-9z",
  macro: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  etfrank: "M8 6h13M8 12h9M8 18h5M3 6h.01M3 12h.01M3 18h.01",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
};
const LABELS: Record<Tab, string> = { picks: "選股", sectors: "族群", holdings: "持股", aietf: "自組ETF", macro: "數據", etfrank: "ETF排行", settings: "設定" };

// 標題雷達：扇形前緣在正上方，往逆時針拖出 38 片漸淡的殘影（約半圈）；目標點在掃描線掃到的那一刻亮起
const radarPt = (deg: number, r: number) => { const a = (deg - 90) * Math.PI / 180; return [r * Math.cos(a), r * Math.sin(a)]; };
const RADAR_FAN = Array.from({ length: 38 }, (_, i) => {
  const step = 190 / 38, a1 = -i * step, a0 = a1 - step, p0 = radarPt(a0, 32), p1 = radarPt(a1, 32);
  return { d: `M0 0 L${p0[0].toFixed(2)} ${p0[1].toFixed(2)} A32 32 0 0 1 ${p1[0].toFixed(2)} ${p1[1].toFixed(2)} Z`, op: +(0.8 * Math.exp(-(i + 0.5) * (3.2 / 38))).toFixed(3) };
});
const RADAR_BLIPS = [[40, 27], [130, 16], [215, 28], [300, 17]].map(([deg, r]) => { const p = radarPt(deg, r); return { x: +p[0].toFixed(1), y: +p[1].toFixed(1), delay: +(deg / 360 * 4.5).toFixed(2) }; });

export function App() {
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) in LABELS ? (location.hash.slice(1) as Tab) : "picks");
  const [market, setMarket] = useState<Market>("TW");
  const [sector, setSector] = useState("");
  const [detail, setDetail] = useState<Scored | null>(null);
  // 打開個股時記住是從哪份清單點進來的，個股頁右上的箭頭可以切到下一檔
  const [detailList, setDetailList] = useState<Scored[]>([]);
  const openDetail = (s: Scored, list?: Scored[]) => { setDetail(s); setDetailList(list ?? []); };
  const nextIdx = detail && detailList.length > 1 ? detailList.findIndex((x) => x.code === detail.code && x.market === detail.market) : -1;
  const next = nextIdx >= 0 ? detailList[(nextIdx + 1) % detailList.length] : undefined;
  const prev = nextIdx >= 0 ? detailList[(nextIdx - 1 + detailList.length) % detailList.length] : undefined;
  const nav = next && prev ? { pos: nextIdx + 1, total: detailList.length, next: () => setDetail(next), prev: () => setDetail(prev), nextName: `${next.name} ${next.code}`, prevName: `${prev.name} ${prev.code}`, around: [1, -1, 2].map((k) => detailList[(nextIdx + k + detailList.length) % detailList.length]).filter((x, i, a) => x && x.code !== detail?.code && a.findIndex((y) => y.code === x.code) === i).map((x) => ({ code: x.code, market: x.market })) } : undefined;
  const { tw, etf, us, loaded } = useStore((s) => ({ tw: s.tw, etf: s.etf, us: s.us, loaded: s.loaded, aiEtf: s.aiEtf, prices: s.prices }));
  // 已抓到今天的台股即時價（盤中、試搓或收盤後）：頂端日期顯示今天，不要停在上個交易日的收盤
  const liveToday = useStore((s): { date: string; final: boolean } | null => {
    const today = taipeiToday();
    // 收盤後（13:30 起）到傍晚評分更新前，持股價是今天的收盤價，日期也要是今天
    const qs = Object.values(s.live).filter((q) => q && q.date === today && !q.session);
    return qs.length ? { date: today, final: qs.every((q) => q.final) || !livePolling() } : null;
  });
  const etfAlert = etfAlertsNow().length > 0;
  useEffect(() => { init(); }, []);
  // 從背景切回 App 時，資料過時就自動更新（例如傍晚 4:30 後有當天評分）
  useEffect(() => {
    const onShow = () => { if (document.visibilityState === "visible") autoRefresh(); };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, []);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => { history.replaceState(null, "", `#${tab}`); mainRef.current?.scrollTo(0, 0); }, [tab, market, sector]);

  const ms = market === "TW" ? tw : market === "ETF" ? etf : us;
  const busy = !!ms.progress || ms.status === "loading";
  // 點上方的解析提醒：個股就打開那一檔，數據解讀就切到「數據」分頁
  const openJob = (j: AiJob) => {
    if (j.kind === "brief") { setTab("macro"); return; }
    if (j.kind === "aietf") { setTab("aietf"); return; }
    const s = j.code ? findScored(j.code, j.market === "US" ? "US" : "TW") : undefined;
    if (s) openDetail(s);
  };
  const refresh = () => { if (market === "US") refreshUs(); else { refreshTw(); refreshEsb(); } refreshMacro(); };

  return (
    <div class="shell">
      <div class="topbar">
        <div class="brand">
          <svg class="radar-logo" viewBox="-36 -36 72 72" aria-hidden="true">
            <g class="radar-sweep">
              <g class="radar-fan">{RADAR_FAN.map((d, i) => <path key={i} d={d.d} opacity={d.op} />)}</g>
              <line class="radar-edge" x1="0" y1="0" x2="0" y2="-32" />
            </g>
            <circle class="radar-ring" r="32" /><circle class="radar-ring" r="21" /><circle class="radar-ring" r="10" />
            {RADAR_BLIPS.map((b, i) => <circle key={i} class="radar-blip" cx={b.x} cy={b.y} r="3" style={`animation-delay:${b.delay}s;transform-origin:${b.x}px ${b.y}px`} />)}
            <polyline points="-28,14 -14,2 -4,9 18,-16" class="radar-line" />
          </svg>
          <span class="brand-fx" data-testid="brand">金雷達</span>
        </div>
        <div class="asof num">
          {market !== "US" && liveToday && (!ms.asOf || liveToday.date > ms.asOf)
            ? <span data-testid="asof-live">台股資料 {pretty(liveToday.date)} {liveToday.final ? "收盤" : "盤中"}</span>
            : ms.asOf ? <>{market === "US" ? "美股" : "台股"}資料 {pretty(ms.asOf)}</> : loaded ? "尚無資料" : ""}
          {ms.progress && ms.status === "ready" && <div>更新中 {Math.round((ms.progress.done / Math.max(ms.progress.total, 1)) * 100)}%</div>}
        </div>
        <button class="iconbtn" aria-label="重新整理" onClick={refresh} disabled={busy}>
          <svg class={busy ? "spin" : ""} viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5" /></svg>
        </button>
      </div>
      <main ref={mainRef}>
        {tab !== "settings" && <UpdateBanner />}
        <AiJobBanner open={openJob} />
        {tab === "picks" && <PicksScreen market={market} setMarket={setMarket} sector={sector} setSector={setSector} open={openDetail} />}
        {tab === "sectors" && <SectorsScreen market={market} setMarket={setMarket} pick={(s) => { setSector(s); setTab("picks"); }} />}
        {tab === "holdings" && <HoldingsScreen open={openDetail} />}
        {tab === "aietf" && <AiEtfScreen />}
        {tab === "macro" && <MacroScreen />}
        {tab === "etfrank" && <EtfRankScreen open={openDetail} />}
        {tab === "settings" && <SettingsScreen />}
      </main>
      <nav class="tabs" aria-label="主選單">
        {(Object.keys(LABELS) as Tab[]).map((t) => (
          <button aria-current={tab === t ? "page" : undefined} onClick={() => setTab(t)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d={ICONS[t]} /></svg>
            {LABELS[t]}
            {t === "aietf" && etfAlert && <span class="dot" aria-label="有提醒" data-testid="etf-dot" />}
          </button>
        ))}
      </nav>
      {detail && <StockDetail key={`${detail.market}:${detail.code}`} s={detail} onClose={() => setDetail(null)} nav={nav} />}
    </div>
  );
}
