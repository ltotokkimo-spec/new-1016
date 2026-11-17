// 長期回測第一段（可行性）：抽樣不同年份的交易日，實測證交所／櫃買老資料的格式、耗時、成功率。
// 不寫快取、不影響每日回測。最後印一行 PROBE_SUMMARY。
// 執行：npx vite build --ssr tools/longbt-probe.ts --outDir .probe-build && node .probe-build/longbt-probe.js
import { parseTpexFlows, parseTpexQuotes, parseTwseFlows, parseTwseQuotes, twUrls } from "../src/data/tw";
import { parseTwt49u } from "../src/engine/exdiv";

// 抽樣日：涵蓋 2018 起各種行情；若遇休市，往後找最多 4 天（用該日資料是否為空判斷）
const SAMPLES = [
  "20180102", "20180611", "20181228", "20190301", "20190830", "20191231",
  "20200102", "20200319", "20200520", "20201130", "20210104", "20210719",
  "20211231", "20220103", "20220630", "20221019", "20221230", "20230116",
  "20230731", "20231229", "20240103", "20240805", "20241231", "20250402",
  "20250805", "20251231", "20260105", "20261030",
];
const GAP: Record<string, number> = { "www.twse.com.tw": 2100, "www.tpex.org.tw": 1100 };
const last = new Map<string, Promise<void>>();
const lat: number[] = [];
let fails = 0;
async function get(url: string): Promise<{ ok: boolean; json?: any; err?: string }> {
  const host = new URL(url).host;
  const prev = last.get(host) ?? Promise.resolve();
  const mine = prev.then(() => new Promise<void>((r) => setTimeout(r, GAP[host] ?? 500)));
  last.set(host, mine);
  await prev;
  for (let a = 0; a < 3; a++) {
    const t = Date.now();
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
      lat.push(Date.now() - t);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return { ok: true, json: await r.json() };
    } catch (e: any) {
      if (a === 2) { fails++; return { ok: false, err: String(e?.message ?? e) }; }
      await new Promise((r) => setTimeout(r, 10_000 * 2 ** a));
    }
  }
  return { ok: false };
}
const ld = (s: string) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
const shape = (j: any) => j ? `keys=${Object.keys(j).join("|")} stat=${j.stat ?? "-"}${j.tables ? ` tables=${j.tables.length}` : ""}` : "null";

async function main() {
  const t0 = Date.now();
  const rows: string[] = [];
  let usable = 0;
  for (const d of SAMPLES) {
    const dt = ld(d);
    const [a, b, c, e] = await Promise.all([
      get(twUrls.twseQuotes(dt)), get(twUrls.twseFlows(dt)), get(twUrls.tpexQuotes(dt)), get(twUrls.tpexFlows(dt)),
    ]);
    const tq = a.ok ? parseTwseQuotes(a.json) : null;
    const tf = b.ok ? parseTwseFlows(b.json) : null;
    const oq = c.ok ? parseTpexQuotes(c.json) : null;
    const of = e.ok ? parseTpexFlows(e.json) : null;
    const hasDelisted = tq ? tq.quotes.length : 0;
    if (tq && tf && oq && of) usable++;
    rows.push(`${d} twseQ=${tq ? tq.quotes.length : "FAIL"}(${tq?.date ?? ""}) twseF=${tf ? tf.length : "FAIL"} tpexQ=${oq ? oq.quotes.length : "FAIL"} tpexF=${of ? of.length : "FAIL"}${tq ? "" : " [" + (a.ok ? shape(a.json) : a.err) + "]"}${tf ? "" : " [" + (b.ok ? shape(b.json) : b.err) + "]"}${oq ? "" : " [" + (c.ok ? shape(c.json) : c.err) + "]"}${of ? "" : " [" + (e.ok ? shape(e.json) : e.err) + "]"}`);
    void hasDelisted;
  }
  // 除權息：2018 與 2022 各一年
  const ex: string[] = [];
  for (const [s, en] of [["20180101", "20181231"], ["20220101", "20221231"]]) {
    const r = await get(`https://www.twse.com.tw/rwd/zh/exRight/TWT49U?response=json&startDate=${s}&endDate=${en}`);
    ex.push(`TWT49U ${s.slice(0, 4)}: ${r.ok ? Object.keys(parseTwt49u(r.json)).length + " 檔 " + shape(r.json) : "FAIL " + r.err}`);
  }
  console.log(rows.join("\n"));
  console.log(ex.join("\n"));
  const avg = lat.length ? Math.round(lat.reduce((x, y) => x + y, 0) / lat.length) : 0;
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`PROBE_SUMMARY 抽樣 ${SAMPLES.length} 天，四項資料都可解析 ${usable} 天，請求失敗 ${fails} 次，平均回應 ${avg}ms，總耗時 ${mins} 分鐘（全期約 2600 天×4 請求，估 ${Math.round(2600 * 4 * 1.7 / 60)} 分鐘以上）`);
}
main();
