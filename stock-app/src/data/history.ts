// 個股詳細頁的日K：台股抓最近 6 個月的月資料，美股沿用已下載的資料。
import type { Fetcher } from "../lib/net";
import type { KV } from "../lib/kv";
import { taipeiToday } from "../lib/dates";
import { parseTpexStockHist, parseTwseStockDay, twHistUrls, type DayBar } from "./tw";

export async function twHistory(fetch: Fetcher, kv: KV, code: string, market: "TWSE" | "TPEX", months = 6, now = Date.now()): Promise<DayBar[]> {
  const today = taipeiToday(now);
  const out: DayBar[] = [];
  let y = +today.slice(0, 4), m = +today.slice(4, 6);
  const keys: string[] = [];
  for (let i = 0; i < months; i++) {
    keys.unshift(`${y}${String(m).padStart(2, "0")}01`);
    m--; if (m === 0) { m = 12; y--; }
  }
  for (const ym of keys) {
    const thisMonth = ym.slice(0, 6) === today.slice(0, 6);
    const key = `tw:h:${market}:${code}:${ym.slice(0, 6)}${thisMonth ? ":" + today : ""}`;
    let bars = await kv.get<DayBar[]>(key);
    if (!bars) {
      const json = await fetch(market === "TWSE" ? twHistUrls.twse(code, ym) : twHistUrls.tpex(code, ym));
      bars = market === "TWSE" ? parseTwseStockDay(json) : parseTpexStockHist(json);
      if (bars.length) await kv.set(key, bars);
    }
    out.push(...bars);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
