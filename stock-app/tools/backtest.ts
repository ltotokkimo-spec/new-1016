// GitHub Actions 每天跑：下載約 2 年的證交所／櫃買資料（有快取，之後只補新的一天），
// 用 App 的評分規則做回測，輸出 backtest.json 給 App 下載。
// 執行：npx vite build --ssr tools/backtest.ts --outDir .bt-build && node .bt-build/backtest.js <快取資料夾> <輸出檔>
import fs from "node:fs";
import path from "node:path";
import { TwLoader } from "../src/data/twLoader";
import { runBacktest, type BtDay } from "../src/engine/backtest";
import { formatFactors, runFactors } from "../src/engine/factors";
import { adjustedSeries, indicators } from "../src/engine/turning";
import { taipeiToday, weekdaysBack } from "../src/lib/dates";
import type { KV } from "../src/lib/kv";

const [cacheDir = ".bt-cache", outFile = "backtest.json", factorsFile = "factors.json"] = process.argv.slice(2);
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
      if (a >= 5) throw e;
      // 證交所連續請求太多會暫時重置連線：等久一點再試（10、20、40、60、60 秒）
      await new Promise((r) => setTimeout(r, Math.min(60_000, 10_000 * 2 ** a)));
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
const weekdays = weekdaysBack(today, 520); // 約 2 年；從最新往回下載，已下載的有快取
// 第一次要下載很多天：超過時間預算就先用已有的天數算（新到舊連續），進度已存在快取，下一次接著下載
const budgetMs = Number(process.env.BT_BUDGET_MIN ?? 80) * 60_000;
const days: BtDay[] = [];
let k = 0;
for (const d of weekdays) {
  k++;
  if (Date.now() - t0 > budgetMs) { log(`超過下載時間預算，先用已下載的 ${days.length} 個交易日（其餘下次接著下載）`); break; }
  let qa, qb, fa, fb;
  try {
    [qa, qb] = await Promise.all([loader.twseQuotes(d), loader.tpexQuotes(d)]);
    if (!qa) continue; // 休市或今天還沒公布
    [fa, fb] = await Promise.all([loader.twseFlows(d), loader.tpexFlows(d)]);
  } catch (e) {
    // 單日下載失敗（證交所連線被重置）：最新的日子一定要成功，更舊的就先用已下載的（新到舊連續），進度已存快取，下次接著下載
    if (days.length < 60) throw e;
    log(`${d} 下載失敗，先用已下載的 ${days.length} 個交易日（其餘下次接著下載）：`, e);
    break;
  }
  days.push({ date: d, quotes: [...qa.rows, ...(qb?.rows ?? [])], tpexCodes: new Set((qb?.rows ?? []).map((r) => r[0])), flows: [...(fa ?? []), ...(fb ?? [])] });
  if (k % 10 === 0) log(`已處理 ${k}/${weekdays.length} 個平日，交易日 ${days.length}，網路請求 ${requests}`);
}
log("交易日", days.length, "最新", days[0]?.date, "最舊", days[days.length - 1]?.date);
if (days.length < 60) throw new Error("交易日太少，資料可能下載失敗");

const r = runBacktest(days, companies);
fs.writeFileSync(outFile, JSON.stringify(r));
// 因子分析（研究用，不影響 App 的評分）：失敗也不能讓回測失敗
try {
  const fr = runFactors(days, companies);
  fs.writeFileSync(factorsFile, JSON.stringify(fr));
  for (const line of formatFactors(fr)) log(line);
} catch (e) { log("因子分析失敗（不影響回測）：", e); }
const pct = (x?: number) => (x === undefined || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(2)}%`);
for (const u of ["stocks", "etf"] as const) {
  log(`== ${u}：${r[u].signals} 個評等日（${r.from} ~ ${r.to}）`);
  for (const g of ["買入", "觀望", "離場", "全部"] as const) {
    const s5 = r[u].groups[g][5], s20 = r[u].groups[g][20];
    log(`${g}  5日 n=${s5?.n ?? 0} 平均 ${pct(s5?.avg)} 上漲 ${pct(s5?.win)} 贏過一半 ${pct(s5?.beat)} | 20日 n=${s20?.n ?? 0} 平均 ${pct(s20?.avg)} 中位數 ${pct(s20?.median)} 上漲 ${pct(s20?.win)} 贏過一半 ${pct(s20?.beat)}`);
  }
}
const t = r.turning;
if (t) {
  log(`== 剛轉強 ${t.asOf}：${t.picks.length} 檔`, t.picks.map((p) => `${p.code}${p.name} 離20日線${pct(p.gap20)} RSI${p.rsi.toFixed(0)} 翻正${p.turnedAgo}天 停損${p.stop}`).join("；"));
  for (const h of [5, 20] as const) { const x = t.stat[h]; log(`剛轉強 ${h}日 n=${x?.n ?? 0} 平均 ${pct(x?.avg)} 上漲 ${pct(x?.win)} 贏過一半 ${pct(x?.beat)}（${t.signals} 個評等日有訊號）`); }
  // 和證交所 MCP 的技術指標對照用（還原價，數值應接近）
  const ser = adjustedSeries(days);
  for (const code of ["9945", "2002", "2409", "2330"]) {
    const s = ser.get(code); if (!s) continue;
    const x = indicators(s.adj), p = s.adj.length - 1, f = days[0].quotes.find((q) => q[0] === code)?.[2] ?? NaN;
    const k = f / s.adj[p];
    log(`指標 ${code} 收${f} MA20 ${(x.ma20[p] * k).toFixed(2)} MA60 ${(x.ma60[p] * k).toFixed(2)} RSI ${x.rsi[p].toFixed(2)} OSC ${(x.osc[p] * k).toFixed(3)} 上軌 ${(x.upper[p] * k).toFixed(2)}`);
  }
}
log("完成", outFile, fs.statSync(outFile).size, "bytes，網路請求", requests);
}

main().catch((e) => { console.error("回測失敗：", e); process.exit(1); });
