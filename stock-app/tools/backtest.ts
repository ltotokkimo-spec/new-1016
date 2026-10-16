// GitHub Actions 每天跑：下載約 9 個月的證交所／櫃買資料（有快取，之後只補新的一天），
// 用 App 的評分規則做回測，輸出 backtest.json 給 App 下載。
// 執行：npx vite build --ssr tools/backtest.ts --outDir .bt-build && node .bt-build/backtest.js <快取資料夾> <輸出檔>
import fs from "node:fs";
import path from "node:path";
import { TwLoader } from "../src/data/twLoader";
import { runBacktest, type BtDay } from "../src/engine/backtest";
import { taipeiToday, weekdaysBack } from "../src/lib/dates";
import type { KV } from "../src/lib/kv";

const [cacheDir = ".bt-cache", outFile = "backtest.json"] = process.argv.slice(2);
fs.mkdirSync(cacheDir, { recursive: true });

const fileKV = (dir: string): KV => {
  const f = (k: string) => path.join(dir, encodeURIComponent(k) + ".json");
  return {
    async get(k) { try { return JSON.parse(fs.readFileSync(f(k), "utf8")); } catch { return undefined; } },
    async set(k, v) { fs.writeFileSync(f(k), JSON.stringify(v)); },
    async del(k) { fs.rmSync(f(k), { force: true }); },
    async keys() { return fs.readdirSync(dir).map((x) => decodeURIComponent(x.replace(/\.json$/, ""))); },
  };
};

// 證交所 5 秒超過 3 次會封鎖，間隔 2 秒；櫃買 1 秒
const GAP: Record<string, number> = { "www.twse.com.tw": 2100, "www.tpex.org.tw": 1100, "openapi.twse.com.tw": 800 };
const last = new Map<string, Promise<void>>();
let requests = 0;
async function fetcher(url: string): Promise<any> {
  const host = new URL(url).host;
  const prev = last.get(host) ?? Promise.resolve();
  const mine = prev.then(() => new Promise<void>((r) => setTimeout(r, GAP[host] ?? 500)));
  last.set(host, mine);
  await prev;
  for (let a = 0; ; a++) {
    try {
      requests++;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (a >= 3) throw e;
      await new Promise((r) => setTimeout(r, 5000 * (a + 1)));
    }
  }
}

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...a);

async function main() {
const loader = new TwLoader(fetcher, fileKV(cacheDir));
const companies = await loader.companies();
log("公司產業別", companies.length);

const today = taipeiToday();
const weekdays = weekdaysBack(today, 200); // 約 9 個月
const days: BtDay[] = [];
let k = 0;
for (const d of weekdays) {
  k++;
  const [qa, qb] = await Promise.all([loader.twseQuotes(d), loader.tpexQuotes(d)]);
  if (!qa) continue; // 休市或今天還沒公布
  const [fa, fb] = await Promise.all([loader.twseFlows(d), loader.tpexFlows(d)]);
  days.push({ date: d, quotes: [...qa.rows, ...(qb?.rows ?? [])], tpexCodes: new Set((qb?.rows ?? []).map((r) => r[0])), flows: [...(fa ?? []), ...(fb ?? [])] });
  if (k % 10 === 0) log(`已處理 ${k}/${weekdays.length} 個平日，交易日 ${days.length}，網路請求 ${requests}`);
}
log("交易日", days.length, "最新", days[0]?.date, "最舊", days[days.length - 1]?.date);
if (days.length < 60) throw new Error("交易日太少，資料可能下載失敗");

const r = runBacktest(days, companies);
fs.writeFileSync(outFile, JSON.stringify(r));
const pct = (x?: number) => (x === undefined || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(2)}%`);
for (const u of ["stocks", "etf"] as const) {
  log(`== ${u}：${r[u].signals} 個評等日（${r.from} ~ ${r.to}）`);
  for (const g of ["買入", "觀望", "離場", "全部"] as const) {
    const s5 = r[u].groups[g][5], s20 = r[u].groups[g][20];
    log(`${g}  5日 n=${s5?.n ?? 0} 平均 ${pct(s5?.avg)} 上漲 ${pct(s5?.win)} 贏過平均 ${pct(s5?.beat)} | 20日 n=${s20?.n ?? 0} 平均 ${pct(s20?.avg)} 上漲 ${pct(s20?.win)} 贏過平均 ${pct(s20?.beat)}`);
  }
}
log("完成", outFile, fs.statSync(outFile).size, "bytes，網路請求", requests);
}

main().catch((e) => { console.error("回測失敗：", e); process.exit(1); });
