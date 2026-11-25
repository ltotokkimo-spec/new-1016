// 當沖排行的背景更新（11/25 使用者：開 App 後就在背景自動刷新，切到當沖分頁不用再等）。
// 原本資料抓取寫在當沖分頁元件裡，切過去才開始抓；現在抓取與計時器放在這個模組，App 啟動時就開始，
// 分頁元件只負責顯示（切過去馬上有上一輪的結果）。
import { useEffect, useState } from "preact/hooks";
import { getState, subscribe } from "../store";
import { flagOf, type DtLists } from "../engine/dtFlags";
import { dtPicks, rankPool, rankQuotes, type DtPick, type RankBy, type RankRow } from "../engine/volRank";
import { loadDtFlags } from "./dtFlags";
import { livePolling } from "./twLive";
import { fetchRankQuotes } from "./volRank";

export const RANK_MS = 10_000;
export const TOP = 15;
/** 今天交易時段（9:00～13:30）已經過的比例；收盤後與非交易時間＝1 */
export const sessionFrac = () => { const d = new Date(Date.now() + 8 * 3600_000), m = d.getUTCHours() * 60 + d.getUTCMinutes() - 9 * 60; return m <= 0 ? 1 : Math.min(1, m / 270); };
const load = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 不記也沒關係 */ } };

export interface DtSnap { rows: Record<RankBy, RankRow[]>; picks: DtPick[]; at: number; time?: string; date?: string; failed: number; total: number }
export interface DtFlagsData { lists: DtLists; status: Record<string, string> }
export interface DtView { snap: DtSnap | null; busy: boolean; flags?: DtFlagsData; withEtf: boolean }

let snap: DtSnap | null = null;
let busy = false;
let flags: DtFlagsData | undefined;
let withEtf = load("dtEtf", "0") === "1";
let view: DtView = { snap, busy, flags, withEtf };
let prev: Record<RankBy, Map<string, number>> = { vol: new Map(), value: new Map() };
const listeners = new Set<() => void>();
const emit = () => { view = { snap, busy, flags, withEtf }; listeners.forEach((l) => l()); };

/** 候選名單：前一個交易日成交量最大的 200 檔（含 ETF 時另加 ETF 前 40） */
export function dtPool() {
  const s = getState();
  return rankPool(s.tw.scored, withEtf ? s.etf.scored : [], 200, withEtf ? 40 : 0);
}

export async function dtPull() {
  if (busy) return;
  const pool = dtPool();
  if (!pool.length) return;
  busy = true; emit();
  try {
    const r = await fetchRankQuotes(pool);
    const qs = Object.values(r.quotes);
    if (!qs.length) { snap = { rows: snap?.rows ?? { vol: [], value: [] }, picks: snap?.picks ?? [], at: snap?.at ?? 0, time: snap?.time, date: snap?.date, failed: r.failed, total: r.total }; return; }
    const s = getState();
    const find = (c: string) => s.tw.scored.find((x) => x.code === c) ?? s.etf.scored.find((x) => x.code === c);
    const rows = { vol: rankQuotes(qs, "vol", TOP, prev.vol), value: rankQuotes(qs, "value", TOP, prev.value) };
    const picks = dtPicks(qs as any, new Map(pool.map((x) => [x.code, x.volume ?? 0])), sessionFrac(), (c) => { const f = flagOf(c, find(c)?.market, flags?.lists); return !!(f.disposal || f.noDayTrade); });
    prev = { vol: new Map(rows.vol.map((x) => [x.code, x.rank])), value: new Map(rows.value.map((x) => [x.code, x.rank])) };
    const time = qs.reduce((m, q) => (q.time > m ? q.time : m), "");
    const date = qs.reduce((m, q) => (q.date > m ? q.date : m), "");
    snap = { rows, picks, at: Date.now(), time, date, failed: r.failed, total: r.total };
  } finally { busy = false; emit(); }
}

export function dtSetEtf(v: boolean) {
  withEtf = v; save("dtEtf", v ? "1" : "0");
  prev = { vol: new Map(), value: new Map() };
  emit(); void dtPull();
}

let started = false;
/** App 啟動時呼叫一次：載入處置股標示、台股資料備妥就抓第一輪，之後平日盤前盤中每 10 秒一輪（背景分頁不抓） */
export function startDtRank() {
  if (started) return;
  started = true;
  loadDtFlags().then((f) => { flags = f; emit(); }).catch(() => {});
  let lastTw: unknown, lastEtf: unknown;
  const check = () => {
    const s = getState();
    if (!s.tw.scored.length || (s.tw.scored === lastTw && s.etf.scored === lastEtf)) return;
    lastTw = s.tw.scored; lastEtf = s.etf.scored;
    prev = { vol: new Map(), value: new Map() };
    void dtPull();
  };
  subscribe(check);
  check();
  setInterval(() => { if (livePolling() && document.visibilityState !== "hidden") void dtPull(); }, RANK_MS);
  // 從背景切回 App：資料超過一輪沒更新就馬上抓
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && livePolling() && Date.now() - (snap?.at ?? 0) > RANK_MS) void dtPull(); });
}

/** 當沖分頁用：拿目前的排名結果（切過來馬上有上一輪的），資料超過一輪沒更新就補抓一次 */
export function useDtRank(): DtView {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    startDtRank();
    if (Date.now() - (snap?.at ?? 0) > RANK_MS) void dtPull();
    return () => { listeners.delete(l); };
  }, []);
  return view;
}
