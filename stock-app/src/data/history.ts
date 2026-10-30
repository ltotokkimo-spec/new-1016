// 個股詳細頁的日K：台股抓最近 6 個月的月資料，美股沿用已下載的資料。
import type { Fetcher } from "../lib/net";
import type { KV } from "../lib/kv";
import { taipeiHour, taipeiToday } from "../lib/dates";
import { parseTpexStockHist, parseTwseStockDay, twHistUrls, type DayBar } from "./tw";

// 前景（使用者正在看 K 線）正在下載時，背景預載要先停下來，不然會擋住證交所的請求間隔
let foreground = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 其他前景下載（例如指數走勢）也讓背景預載先停下來；回傳結束時要呼叫的函式 */
export function beginForeground(): () => void { foreground++; let done = false; return () => { if (!done) { done = true; foreground--; } }; }

function monthKeys(today: string, months: number): string[] {
  let y = +today.slice(0, 4), m = +today.slice(4, 6);
  const keys: string[] = [];
  for (let i = 0; i < months; i++) {
    keys.unshift(`${y}${String(m).padStart(2, "0")}01`);
    m--; if (m === 0) { m = 12; y--; }
  }
  return keys;
}

/**
 * 個股日 K：手機裡已經有的月份先全部讀出來馬上回報（onPartial），沒有的月份由「最近的月份」往回下載，
 * 每下載一個月就再回報一次，所以打開圖表不用等全部下載完；全部完成後回傳完整資料。
 * background＝背景預載：讓位給前景請求，且不回報中間結果。
 */
export async function twHistory(fetch: Fetcher, kv: KV, code: string, market: "TWSE" | "TPEX", months = 6, now = Date.now(), onPartial?: (bars: DayBar[]) => void, background = false): Promise<DayBar[]> {
  const today = taipeiToday(now);
  const keys = monthKeys(today, months);
  const keyOf = (ym: string) => {
    const thisMonth = ym.slice(0, 6) === today.slice(0, 6);
    // 本月的資料每天會變：收盤後（台北 15 點起）證交所才有當天那根，所以盤前盤中與收盤後各存一份
    return `tw:h:${market}:${code}:${ym.slice(0, 6)}${thisMonth ? ":" + today + (taipeiHour(now) >= 15 ? "c" : "") : ""}`;
  };
  const got = new Map<string, DayBar[]>();
  const merged = () => keys.flatMap((k) => got.get(k) ?? []).sort((a, b) => a.date.localeCompare(b.date));
  if (!background) foreground++;
  try {
    await Promise.all(keys.map(async (ym) => { const b = await kv.get<DayBar[]>(keyOf(ym)); if (b) got.set(ym, b); }));
    if (!background && got.size) onPartial?.(merged());
    for (const ym of [...keys].reverse()) { // 最近的月份先下載
      if (got.has(ym)) continue;
      if (background) while (foreground > 0) await sleep(500);
      let bars: DayBar[];
      try {
        const json = await fetch(market === "TWSE" ? twHistUrls.twse(code, ym) : twHistUrls.tpex(code, ym));
        bars = market === "TWSE" ? parseTwseStockDay(json) : parseTpexStockHist(json);
      } catch (e) {
        if (merged().length) break; // 已經有資料可畫：更早的月份下載失敗就先不管，不要讓整張圖消失
        throw e;
      }
      if (bars.length) await kv.set(keyOf(ym), bars);
      got.set(ym, bars);
      if (!background) onPartial?.(merged());
    }
    return merged();
  } finally {
    if (!background) foreground--;
  }
}
