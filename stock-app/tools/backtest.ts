// GitHub Actions 每天跑：下載約 2 年的證交所／櫃買資料（有快取，之後只補新的一天），
// 用 App 的評分規則做回測，輸出 backtest.json 給 App 下載。
// 執行：npx vite build --ssr tools/backtest.ts --outDir .bt-build && node .bt-build/backtest.js <快取資料夾> <輸出檔>
import fs from "node:fs";
import path from "node:path";
import { TwLoader } from "../src/data/twLoader";
import { runBacktest, type BtDay } from "../src/engine/backtest";
import { formatFactors, runFactors } from "../src/engine/factors";
import { formatCompare, runScoreCompare } from "../src/engine/scoreCompare";
import { AI_CODES, aiTargets, buildCtx, formatSteady, runSteady } from "../src/engine/steady";
import { runWatch, WATCH } from "../src/engine/watch";
import { adjustedSeries, indicators } from "../src/engine/turning";
import { addDays, taipeiToday, weekdaysBack } from "../src/lib/dates";
import { buildTwInputs } from "../src/data/twLoader";
import { isEtf } from "../src/data/tw";
import { scoreStocks } from "../src/engine/score";
import { appendPicks, assertAppendOnly, emptyLog, evaluatePick, PICK_NOTIONAL, PICK_STOP, FEE_RATE, FEE_MIN_LOT, FEE_MIN_ODD, TAX_STOCK, TAX_ETF, toCsv, type PathPoint, type PickLog, type PickPerfFile } from "../src/engine/pickLog";
import type { KV } from "../src/lib/kv";

const [cacheDir = ".bt-cache", outFile = "backtest.json", factorsFile = "factors.json", compareFile = "scorecompare.json", steadyFile = "steady.json", watchFile = "n5.json", wideFile = "wide.json", regimeFile = "regime.json", leadFile = "lead.json", aiFile = "ai.json", realFile = "real.json", turnFile = "turn.json"] = process.argv.slice(2);
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
const taiexClose = new Map<string, number>(); // 加權指數每日收盤（推薦績效的對照）
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
  const tw = qa.indices?.find((x) => x.name === "發行量加權股價指數");
  if (tw && tw.close > 0) taiexClose.set(d, tw.close);
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
// 新舊評分對照（研究用）：同樣失敗也不能讓回測失敗
try {
  const cr = runScoreCompare(days, companies);
  fs.writeFileSync(compareFile, JSON.stringify(cr));
  for (const line of formatCompare(cr)) log(line);
} catch (e) { log("評分對照失敗（不影響回測）：", e); }
// 穩健選股（研究用）：逐日模擬組合，和現行買入、0050 比較；失敗也不能讓回測失敗
try {
  const sr = runSteady(days, companies);
  fs.writeFileSync(steadyFile, JSON.stringify(sr));
  for (const line of formatSteady(sr)) log(line);
  // AI 清單檢查：最新資料日有行情的檔數，與依市值配置的權重（確認代號都對得上）
  const cx = buildCtx(days, companies), jl = cx.N - 1;
  const have = AI_CODES.filter((k) => cx.rows[jl].has(k));
  log(`AI 清單 ${AI_CODES.length} 檔，最新資料日有行情 ${have.length} 檔；沒有的：${AI_CODES.filter((k) => !cx.rows[jl].has(k)).join("、") || "無"}`);
  const aw = [...aiTargets(cx, jl, { weight: "cap" })].sort((a, b) => b[1] - a[1]);
  log("AI2 最新權重：" + aw.slice(0, 12).map(([k, w]) => `${cx.rows[jl].get(k)?.[1]}${k} ${(w * 100).toFixed(1)}%`).join("、") + `（共 ${aw.length} 檔）`);
} catch (e) { log("穩健選股回測失敗（不影響回測）：", e); }
// N5 觀察組合（0050 五成＋方案 A 五成）：從 WATCH.start 起每天重算，輸出給 App 顯示；失敗也不能讓回測失敗
try {
  const w = runWatch(days, companies);
  fs.writeFileSync(watchFile, JSON.stringify(w));
  log(`N5 觀察組合：${w.start} 起，資料日 ${w.asOf || "（尚未開始）"}，成交 ${w.trades.length} 筆，淨值 ${w.nav.at(-1)?.nav ?? WATCH.budget}（0050 對照 ${w.nav.at(-1)?.bench ?? WATCH.budget}）`);
  // 試跑（不發布）：從 30 個交易日前開始，確認規則在真實資料上跑得動
  const trial = runWatch(days, companies, { start: days[Math.min(days.length - 1, 30)].date });
  const tv = trial.nav.at(-1);
  log(`N5 試跑（${trial.start} 起）：成交 ${trial.trades.length} 筆，淨值 ${tv?.nav}（${tv ? ((tv.nav / trial.budget - 1) * 100).toFixed(2) : "—"}%）0050 對照 ${tv?.bench}（${tv ? ((tv.bench / trial.budget - 1) * 100).toFixed(2) : "—"}%）`);
  log("N5 試跑最後說明：", trial.notes.at(-1)?.text);
} catch (e) { log("N5 觀察組合失敗（不影響回測）：", e); }
// 攻守輪動 R1 觀察組合
try {
  const w = runWatch(days, companies, { mode: "regime" });
  fs.writeFileSync(regimeFile, JSON.stringify(w));
  log(`攻守輪動觀察組合：${w.start} 起，資料日 ${w.asOf || "（尚未開始）"}，成交 ${w.trades.length} 筆，淨值 ${w.nav.at(-1)?.nav ?? WATCH.budget}（0050 對照 ${w.nav.at(-1)?.bench ?? WATCH.budget}）`);
  const trial = runWatch(days, companies, { mode: "regime", start: days[Math.min(days.length - 1, 30)].date });
  const tv = trial.nav.at(-1);
  log(`攻守輪動試跑（${trial.start} 起）：成交 ${trial.trades.length} 筆，淨值 ${tv?.nav}（${tv ? ((tv.nav / trial.budget - 1) * 100).toFixed(2) : "—"}%）0050 對照 ${tv?.bench}（${tv ? ((tv.bench / trial.budget - 1) * 100).toFixed(2) : "—"}%）`);
  log("攻守輪動試跑最後說明：", trial.notes.at(-1)?.text);
} catch (e) { log("攻守輪動觀察組合失敗（不影響回測）：", e); }
// 權值強化觀察組合（Claude 設計，不放 0050）
try {
  log(`公司資料有實收資本額：${companies.filter((x) => (x.capital ?? 0) > 0).length}/${companies.length}（台積電 ${companies.find((x) => x.code === "2330")?.capital ?? "無"}）`);
  const w = runWatch(days, companies, { mode: "lead" });
  fs.writeFileSync(leadFile, JSON.stringify(w));
  log(`權值強化觀察組合：${w.start} 起，資料日 ${w.asOf || "（尚未開始）"}，成交 ${w.trades.length} 筆，淨值 ${w.nav.at(-1)?.nav ?? WATCH.budget}（0050 對照 ${w.nav.at(-1)?.bench ?? WATCH.budget}）`);
  const trial = runWatch(days, companies, { mode: "lead", start: days[Math.min(days.length - 1, 30)].date });
  const tv = trial.nav.at(-1);
  log(`權值強化試跑（${trial.start} 起）：成交 ${trial.trades.length} 筆，淨值 ${tv?.nav}（${tv ? ((tv.nav / trial.budget - 1) * 100).toFixed(2) : "—"}%）0050 對照 ${tv?.bench}（${tv ? ((tv.bench / trial.budget - 1) * 100).toFixed(2) : "—"}%）`);
  log("權值強化試跑最後說明：", trial.notes.at(-1)?.text);
} catch (e) { log("權值強化觀察組合失敗（不影響回測）：", e); }
// AI 供應鏈觀察組合（Claude 設計；使用者 10/26 指定，2 年回測 AI2 通過事先訂的標準）
try {
  const w = runWatch(days, companies, { mode: "ai" });
  fs.writeFileSync(aiFile, JSON.stringify(w));
  log(`AI 供應鏈觀察組合：${w.start} 起，資料日 ${w.asOf || "（尚未開始）"}，成交 ${w.trades.length} 筆，淨值 ${w.nav.at(-1)?.nav ?? WATCH.budget}（0050 對照 ${w.nav.at(-1)?.bench ?? WATCH.budget}）`);
  const trial = runWatch(days, companies, { mode: "ai", start: days[Math.min(days.length - 1, 30)].date });
  const tv = trial.nav.at(-1);
  log(`AI 供應鏈試跑（${trial.start} 起）：成交 ${trial.trades.length} 筆，淨值 ${tv?.nav}（${tv ? ((tv.nav / trial.budget - 1) * 100).toFixed(2) : "—"}%）0050 對照 ${tv?.bench}（${tv ? ((tv.bench / trial.budget - 1) * 100).toFixed(2) : "—"}%）`);
  log("AI 供應鏈試跑最後說明：", trial.notes.at(-1)?.text);
} catch (e) { log("AI 供應鏈觀察組合失敗（不影響回測）：", e); }
// 剛轉強觀察組合（使用者 11/04 看完回測選 T1-混合：剛轉強訊號、每檔 9%、跌 8% 停損、滿 20 天後還在 20 日線上就續抱；和其他組一樣 10/23 起算）
try {
  const w = runWatch(days, companies, { mode: "turn" });
  fs.writeFileSync(turnFile, JSON.stringify(w));
  log(`剛轉強觀察組合：${w.start} 起，資料日 ${w.asOf || "（尚未開始）"}，成交 ${w.trades.length} 筆，淨值 ${w.nav.at(-1)?.nav ?? WATCH.budget}（0050 對照 ${w.nav.at(-1)?.bench ?? WATCH.budget}）`);
  log("剛轉強最後說明：", w.notes.at(-1)?.text);
} catch (e) { log("剛轉強觀察組合失敗（不影響回測）：", e); }
// 實單規則觀察組合（使用者 11/03 要求：「我的實單」的選股規則沒比較過，和其他組同一天 10/23 起算同場比）
try {
  const w = runWatch(days, companies, { mode: "real" });
  fs.writeFileSync(realFile, JSON.stringify(w));
  log(`實單規則觀察組合：${w.start} 起，資料日 ${w.asOf || "（尚未開始）"}，成交 ${w.trades.length} 筆，淨值 ${w.nav.at(-1)?.nav ?? WATCH.budget}（0050 對照 ${w.nav.at(-1)?.bench ?? WATCH.budget}）`);
  log("實單規則最後說明：", w.notes.at(-1)?.text);
} catch (e) { log("實單規則觀察組合失敗（不影響回測）：", e); }
// 全個股觀察組合（不限檔數、每天局部修正）
try {
  const w = runWatch(days, companies, { mode: "wide" });
  fs.writeFileSync(wideFile, JSON.stringify(w));
  log(`全個股觀察組合：${w.start} 起，資料日 ${w.asOf || "（尚未開始）"}，成交 ${w.trades.length} 筆，淨值 ${w.nav.at(-1)?.nav ?? WATCH.budget}（0050 對照 ${w.nav.at(-1)?.bench ?? WATCH.budget}）`);
  const trial = runWatch(days, companies, { mode: "wide", start: days[Math.min(days.length - 1, 30)].date });
  const tv = trial.nav.at(-1);
  log(`全個股試跑（${trial.start} 起）：成交 ${trial.trades.length} 筆，淨值 ${tv?.nav}（${tv ? ((tv.nav / trial.budget - 1) * 100).toFixed(2) : "—"}%）0050 對照 ${tv?.bench}（${tv ? ((tv.bench / trial.budget - 1) * 100).toFixed(2) : "—"}%）`);
  log("全個股試跑最後說明：", trial.notes.at(-1)?.text);
} catch (e) { log("全個股觀察組合失敗（不影響回測）：", e); }
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
// 推薦績效追蹤（使用者 11/7 要求）：PICKLOG 指到 stock-radar-log 分支裡的 picks.json；只新增當天的買入名單，不改舊紀錄
const pickLogFile = process.env.PICKLOG;
if (pickLogFile) {
  try {
    const before: PickLog = fs.existsSync(pickLogFile) ? JSON.parse(fs.readFileSync(pickLogFile, "utf8")) : emptyLog();
    let logNow = before;
    const d0 = days[0];
    const dateIdx = new Map(days.map((d, i) => [d.date, i]));
    const onOrBefore = (ymd: string) => { for (let x = 0; x < 10; x++) { const i = dateIdx.get(addDays(ymd, -x)); if (i !== undefined) return i; } return undefined; };
    const m1 = onOrBefore(addDays(d0.date, -28)), m3 = onOrBefore(addDays(d0.date, -88));
    if (!d0.flows.length) log(`推薦績效：${d0.date} 三大法人還沒公布，今天先不記錄`);
    else if (m1 === undefined || m3 === undefined) log("推薦績效：歷史資料不足，今天先不記錄");
    else {
      const inputs = buildTwInputs({ latest: d0.quotes, week: days[5].quotes, month: days[m1].quotes, quarter: days[m3].quotes, flows: days.slice(0, 10).map((d) => d.flows), companies, tpexCodes: d0.tpexCodes }).filter((x) => !isEtf(x.code));
      const buys = scoreStocks(inputs).scored.filter((x) => x.rating === "買入");
      const res = appendPicks(before, d0.date, buys.map((x) => ({ code: x.code, name: x.name, market: d0.tpexCodes.has(x.code) ? "TPEX" as const : "TWSE" as const, price: x.close, score: x.score, reasons: x.reasons.slice(0, 2), dataDate: d0.date })));
      logNow = res.log;
      log(`推薦績效：${d0.date} 買入 ${buys.length} 檔，新增 ${res.added} 筆（累計 ${logNow.picks.length} 筆，${logNow.start || "—"} 起）`);
    }
    assertAppendOnly(before, logNow);
    fs.writeFileSync(pickLogFile, JSON.stringify(logNow, null, 1));
    // 每檔每天的漲跌倍數（對除權息後的參考價）、0050 同理；加權指數用收盤
    const asc = [...days].reverse();
    const factor = new Map<string, Map<string, number>>(); // code → date → 當天倍數
    for (const d of asc) for (const r of d.quotes) { const c = r[2], ch = r[3], prev = c - ch; if (c > 0 && prev > 0) { let m = factor.get(r[0]); if (!m) factor.set(r[0], (m = new Map())); m.set(d.date, c / prev); } }
    const pathOf = (code: string, from: string): PathPoint[] => { const m = factor.get(code); let f = 1; const out: PathPoint[] = []; for (const d of asc) { if (d.date <= from) continue; f *= m?.get(d.date) ?? 1; out.push({ date: d.date, f }); } return out; };
    const benchOf = (from: string) => {
      const t0 = taiexClose.get(from), tai = new Map<string, number>(), b = new Map<string, number>();
      for (const x of pathOf("0050", from)) { b.set(x.date, x.f - 1); const tc = taiexClose.get(x.date); if (t0 && tc) tai.set(x.date, tc / t0 - 1); }
      return { tai, b };
    };
    const benchCache = new Map<string, ReturnType<typeof benchOf>>();
    const rows = logNow.picks.map((p) => { let bm = benchCache.get(p.date); if (!bm) benchCache.set(p.date, (bm = benchOf(p.date))); return evaluatePick(p, pathOf(p.code, p.date), bm.tai, bm.b); });
    // 新的日期在前；同一天維持記錄時的順序（分數高到低，和選股頁買入名單一樣）。不能整串 reverse，否則同一天會變成分數低的在前
    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const perf: PickPerfFile = {
      version: 1, generatedAt: Date.now(), start: logNow.start, dataTo: d0.date, rule: logNow.rule,
      source: "證交所、櫃買中心每日收盤行情與三大法人；加權指數為證交所每日收盤；報酬以每日漲跌連乘（已排除除權息）。由 GitHub Actions 每個交易日收盤後計算。",
      cost: { notional: PICK_NOTIONAL, feeRate: FEE_RATE, feeMinLot: FEE_MIN_LOT, feeMinOdd: FEE_MIN_ODD, taxStock: TAX_STOCK, taxEtf: TAX_ETF, stop: PICK_STOP },
      rows,
    };
    fs.writeFileSync("picks-perf.json", JSON.stringify(perf));
    fs.writeFileSync("picks.csv", toCsv(perf));
    log(`推薦績效：${rows.length} 筆，已滿 5／10／20 日 ${[5, 10, 20].map((h) => rows.filter((r) => r.h[h as 5]).length).join("／")} 筆`);
  } catch (e) { log("推薦績效追蹤失敗（不影響回測）：", e); }
}
log("完成", outFile, fs.statSync(outFile).size, "bytes，網路請求", requests);
}

main().catch((e) => { console.error("回測失敗：", e); process.exit(1); });
