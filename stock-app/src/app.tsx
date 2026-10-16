import { useEffect, useRef, useState } from "preact/hooks";
import { findScored, init, refreshEsb, refreshMacro, refreshTw, refreshUs, useStore, type AiJob, type Market } from "./store";
import type { Scored } from "./engine/score";
import { pretty } from "./lib/dates";
import { AiJobBanner, HoldingsScreen, MacroScreen, PicksScreen, SectorsScreen, SettingsScreen, StockDetail, UpdateBanner } from "./ui/screens";

type Tab = "picks" | "sectors" | "holdings" | "macro" | "settings";

const ICONS: Record<Tab, string> = {
  picks: "M3 17l5-5 4 4 8-9M14 7h6v6",
  sectors: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  holdings: "M3 7h18v12H3zM8 7V5h8v2M3 12h18",
  macro: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
};
const LABELS: Record<Tab, string> = { picks: "選股", sectors: "族群", holdings: "持股", macro: "數據", settings: "設定" };

export function App() {
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) in LABELS ? (location.hash.slice(1) as Tab) : "picks");
  const [market, setMarket] = useState<Market>("TW");
  const [sector, setSector] = useState("");
  const [detail, setDetail] = useState<Scored | null>(null);
  const { tw, etf, us, loaded } = useStore((s) => ({ tw: s.tw, etf: s.etf, us: s.us, loaded: s.loaded }));
  useEffect(() => { init(); }, []);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => { history.replaceState(null, "", `#${tab}`); mainRef.current?.scrollTo(0, 0); }, [tab, market, sector]);

  const ms = market === "TW" ? tw : market === "ETF" ? etf : us;
  const busy = !!ms.progress || ms.status === "loading";
  // 點上方的解析提醒：個股就打開那一檔，數據解讀就切到「數據」分頁
  const openJob = (j: AiJob) => {
    if (j.kind === "brief") { setTab("macro"); return; }
    const s = j.code ? findScored(j.code, j.market === "US" ? "US" : "TW") : undefined;
    if (s) setDetail(s);
  };
  const refresh = () => { if (market === "US") refreshUs(); else { refreshTw(); refreshEsb(); } refreshMacro(); };

  return (
    <div class="shell">
      <div class="topbar">
        <div class="brand">股市<b>雷達</b></div>
        <div class="asof num">
          {ms.asOf ? <>{market === "US" ? "美股" : "台股"}資料 {pretty(ms.asOf)}</> : loaded ? "尚無資料" : ""}
          {ms.progress && ms.status === "ready" && <div>更新中 {Math.round((ms.progress.done / Math.max(ms.progress.total, 1)) * 100)}%</div>}
        </div>
        <button class="iconbtn" aria-label="重新整理" onClick={refresh} disabled={busy}>
          <svg class={busy ? "spin" : ""} viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5" /></svg>
        </button>
      </div>
      <main ref={mainRef}>
        {tab !== "settings" && <UpdateBanner />}
        <AiJobBanner open={openJob} />
        {tab === "picks" && <PicksScreen market={market} setMarket={setMarket} sector={sector} setSector={setSector} open={setDetail} />}
        {tab === "sectors" && <SectorsScreen market={market} setMarket={setMarket} pick={(s) => { setSector(s); setTab("picks"); }} />}
        {tab === "holdings" && <HoldingsScreen open={setDetail} />}
        {tab === "macro" && <MacroScreen />}
        {tab === "settings" && <SettingsScreen />}
      </main>
      <nav class="tabs" aria-label="主選單">
        {(Object.keys(LABELS) as Tab[]).map((t) => (
          <button aria-current={tab === t ? "page" : undefined} onClick={() => setTab(t)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d={ICONS[t]} /></svg>
            {LABELS[t]}
          </button>
        ))}
      </nav>
      {detail && <StockDetail s={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
