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
import { knownYm, parseRevHtml, prevYm, revTable, type RevEntry, type RevTable } from "../src/engine/revHist";
import { adjustedSeries, indicators } from "../src/engine/turning";
import { addDays, taipeiToday, usLatestSession, weekdaysBack } from "../src/lib/dates";
import { buildTwInputs } from "../src/data/twLoader";
import { isEtf } from "../src/data/tw";
import { scoreStocks } from "../src/engine/score";
import { adjustReturns, exEventsFromDays, exRefOn, mergeEx, parseTpexExright, parseTwt49u, type ExMap } from "../src/engine/exdiv";
import { appendPicks, applyFinal, assertAppendOnly, assertFinalAppendOnly, BOOK_INFO, emptyFinal, emptyLog, freezeResults, type FinalLog, ETF_TOP_N, evaluatePick, PICK_NOTIONAL, PICK_STOP, FEE_RATE, FEE_MIN_LOT, FEE_MIN_ODD, sortPerfRows, TAX_STOCK, TAX_ETF, toCsv, US_FEE_RATE, US_NOTIONAL, type PathPoint, type PickBook, type PickLog, type PickPerfFile } from "../src/engine/pickLog";
import { UsLoader } from "../src/data/usLoader";
import type { KV } from "../src/lib/kv";

const [cacheDir = ".bt-cache", outFile = "backtest.json", factorsFile = "factors.json", compareFile = "scorecompare.json", steadyFile = "steady.json", watchFile = "n5.json", wideFile = "wide.json", regimeFile = "regime.json", leadFile = "lead.json", aiFile = "ai.json", realFile = "real.json", turnFile = "turn.json", dualFile = "dual.json"] = process.argv.slice(2);
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

/** 美股（Nasdaq、CNBC）：用瀏覽器的 User-Agent；失敗只重試 2 次，不要像證交所那樣等很久（美股失敗不影響台股） */
async function usFetcher(url: string): Promise<any> {
  for (let a = 0; ; a++) {
    try {
      requests++;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", Accept: "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(25_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (a >= 2) throw e;
      await new Promise((r) => setTimeout(r, 3000 * (a + 1)));
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

// 除權息還原（11/9）：從每日行情找出除權息事件；評分用還原後的漲跌幅（App 下載 exdiv.json 用同一份事件）
// 上市：證交所官方「除權除息計算結果表」（行情在除權息當天漲跌欄只標 X，推算不可靠）；上櫃：櫃買官方計算結果表（抓不到才用推算）
const exInferred = exEventsFromDays(days);
let exTwse: ExMap = {}, twseOk = false;
{
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const end = new Date(`${days[0].date.slice(0, 4)}-${days[0].date.slice(4, 6)}-${days[0].date.slice(6)}T00:00:00Z`);
  for (let k = 0; k < 5; k++) { // 近 15 個月，每段 3 個月
    const e = new Date(end.getTime() - k * 92 * 864e5), st = new Date(e.getTime() - 91 * 864e5);
    const urls = [`https://www.twse.com.tw/rwd/zh/exRight/TWT49U?response=json&startDate=${fmt(st)}&endDate=${fmt(e)}`, `https://www.twse.com.tw/exchangeReport/TWT49U?response=json&strDate=${fmt(st)}&endDate=${fmt(e)}`];
    for (const u of urls) {
      try {
        const j = await fetcher(u);
        const part = parseTwt49u(j);
        const n = Object.values(part).reduce((a, v) => a + v.length, 0);
        log(`證交所除權除息 ${fmt(st)}～${fmt(e)}：${n} 筆（${u.includes("/rwd/") ? "rwd" : "exchangeReport"}）`);
        if (n > 0 || j?.stat === "OK") { exTwse = mergeEx(part, exTwse); twseOk = true; break; }
      } catch (err) { log(`證交所除權除息下載失敗：${String(err).slice(0, 120)}`); }
    }
  }
}
// 上櫃：櫃買中心「除權除息計算結果表」（上櫃行情除權息當天漲跌欄不是數字，推算抓不到）
let exTpex: ExMap = {}, tpexOk = false;
{
  const end = new Date(`${days[0].date.slice(0, 4)}-${days[0].date.slice(4, 6)}-${days[0].date.slice(6)}T00:00:00Z`);
  const ymd = (d: Date, roc: boolean) => { const [y, m, dd] = d.toISOString().slice(0, 10).split("-"); return `${roc ? Number(y) - 1911 : y}/${m}/${dd}`; };
  for (let k = 0; k < 5; k++) {
    const e = new Date(end.getTime() - k * 92 * 864e5), st = new Date(e.getTime() - 91 * 864e5);
    const urls = [
      `https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?startDate=${encodeURIComponent(ymd(st, false))}&endDate=${encodeURIComponent(ymd(e, false))}&response=json`,
      `https://www.tpex.org.tw/web/stock/exright/dailyquo/exDailyQ_result.php?l=zh-tw&d=${encodeURIComponent(ymd(st, true))}&ed=${encodeURIComponent(ymd(e, true))}&o=json`,
    ];
    for (const u of urls) {
      try {
        const j = await fetcher(u);
        const part = parseTpexExright(j);
        const n = Object.values(part).reduce((a, v) => a + v.length, 0);
        log(`櫃買除權除息 ${ymd(st, false)}～${ymd(e, false)}：${n} 筆（${u.includes("/www/") ? "www" : "web"}）` + (n ? "" : ` 欄位 ${JSON.stringify(j?.tables?.[0]?.fields ?? j?.fields ?? Object.keys(j ?? {})).slice(0, 300)} 首列 ${JSON.stringify((j?.tables?.[0]?.data ?? j?.aaData ?? [])[0] ?? null).slice(0, 300)}`));
        if (n > 0) { exTpex = mergeEx(part, exTpex); tpexOk = true; break; }
      } catch (err) { log(`櫃買除權除息下載失敗：${String(err).slice(0, 120)}`); }
    }
  }
}
const twseCodes = new Set(days[0].quotes.map((q) => q[0]).filter((c) => !days[0].tpexCodes.has(c)));
// 證交所資料抓不到時，上市的不還原（不用不可靠的推算）；櫃買抓得到時上櫃也只用官方
const skip = new Set([...twseCodes, ...(tpexOk ? days[0].tpexCodes : [])]);
const exAll = mergeEx(mergeEx(exTpex, exTwse), exInferred, skip);
log(`除權息來源：上市 ${twseOk ? "證交所官方" : "抓不到，上市不還原"}；上櫃 ${tpexOk ? "櫃買官方" : "行情推算"}。樣本：` + ["00406A", "0056", "00878", "2330", "00679B", "00687B", "6488"].map((c) => `${c} ${JSON.stringify((exAll[c] ?? []).slice(-2))}`).join("；"));
{
  const cut = days[Math.min(days.length - 1, 260)].date; // App 只需要約一年（配息資訊）＋三個月（評分還原）
  const ev: ExMap = {};
  let n = 0;
  for (const [code, list] of Object.entries(exAll)) { const l = list.filter((e) => e[0] > cut); if (l.length) { ev[code] = l; n += l.length; } }
  fs.writeFileSync("exdiv.json", JSON.stringify({ version: 1, asOf: days[0].date, from: cut, source: "證交所、櫃買中心每日收盤行情（參考價與前一日收盤的差）", ev }));
  log(`除權息事件：${Object.keys(ev).length} 檔、${n} 次（${cut} 之後）；00406A：${JSON.stringify(ev["00406A"]?.slice(-3) ?? [])}`);
}
const r = runBacktest(days, companies, { ex: exAll });
// 驗證還原有沒有讓評分變差：同一段期間，還原前（原始收盤）vs 還原後
try {
  const raw = runBacktest(days, companies);
  const line = (name: string, x: typeof r) => (["stocks", "etf"] as const).map((k) => { const b = x[k].groups["買入"], a = x[k].groups["全部"]; return `${k === "stocks" ? "個股" : "ETF"} 買入 5日 ${(b[5]!.avg * 100).toFixed(2)}%（贏過一半 ${(b[5]!.beat * 100).toFixed(1)}%、n=${b[5]!.n}）20日 ${(b[20]!.avg * 100).toFixed(2)}%（贏過一半 ${(b[20]!.beat * 100).toFixed(1)}%）｜全部 20日 ${(a[20]!.avg * 100).toFixed(2)}%`; }).map((t) => `${name}｜${t}`);
  for (const t of [...line("除權息還原前", raw), ...line("除權息還原後", r)]) log(t);
} catch (e) { log("除權息還原比較失敗（不影響回測）：", e); }
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
// 歷史月營收（雙引擎的成長組用，使用者 11/14 同意上線）：公開資訊觀測站每月一頁（Big5），已公布滿一段時間的月份存快取。
// 下載失敗不影響其他回測：少了營收，雙引擎的成長組那一半會先放現金，說明裡會寫。
let rev: RevTable | undefined;
try {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
  const dec = new TextDecoder("big5");
  const latestYm = knownYm(days[0].date), firstYm = prevYm(days[days.length - 1].date.slice(0, 6), 8);
  const todayYmd = taipeiToday();
  const months: { ym: string; rows: RevEntry[] }[] = [];
  let hit = 0, got = 0, bad = 0;
  for (let ym = firstYm; ym <= latestYm; ym = prevYm(ym, -1)) {
    for (const mk of ["sii", "otc"] as const) {
      const file = path.join(cacheDir, `rev-${mk}-${ym}.json`);
      let rows: RevEntry[] | undefined;
      try { rows = JSON.parse(fs.readFileSync(file, "utf8")); hit++; } catch { /* 沒有快取 */ }
      if (!rows) {
        const roc = `${Number(ym.slice(0, 4)) - 1911}_${Number(ym.slice(4))}`;
        for (const host of ["mopsov.twse.com.tw", "mops.twse.com.tw"]) {
          try {
            requests++;
            const r = await fetch(`https://${host}/nas/t21/${mk}/t21sc03_${roc}_0.html`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(40_000) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const parsed = parseRevHtml(dec.decode(await r.arrayBuffer()));
            if (parsed.length < 300) throw new Error(`只解析到 ${parsed.length} 家`);
            rows = parsed;
            break;
          } catch (e) { log(`月營收 ${mk} ${ym}（${host}）下載失敗：${String(e).slice(0, 100)}`); }
          await new Promise((r) => setTimeout(r, 2000));
        }
        await new Promise((r) => setTimeout(r, 1500));
        if (rows) {
          got++;
          // 公布月（下個月）15 日以後才存快取：10 日的期限前後還有公司陸續補申報
          if (todayYmd >= `${prevYm(ym, -1)}15`) fs.writeFileSync(file, JSON.stringify(rows));
        } else bad++;
      }
      if (rows) months.push({ ym, rows });
    }
  }
  rev = revTable(months);
  const chk = rev.get(latestYm)?.get("2330");
  log(`歷史月營收：${firstYm}～${latestYm}，快取 ${hit}、下載 ${got}、失敗 ${bad}；最新月份家數 ${rev.get(latestYm)?.size ?? 0}；台積電 ${latestYm} 營收 ${chk?.rev ?? "無"}（千元）、去年同月 ${chk?.lastYear ?? "無"}`);
  if (!(rev.get(latestYm)?.size! > 1000)) { log("最新月份的營收家數太少，雙引擎的成長組這次不選股"); rev = undefined; }
} catch (e) { log("歷史月營收下載失敗（雙引擎的成長組先放現金）：", e); rev = undefined; }
// 穩健選股（研究用）：逐日模擬組合，和現行買入、0050 比較；失敗也不能讓回測失敗
try {
  const sr = runSteady(days, companies, { rev });
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
// 雙引擎觀察組合（使用者 11/14 同意上線）：成長組五成（營收年增＋營收創高＋外資買超）＋低波動方案 A 五成；11/13 起算（規則定案前最後一個資料日）
try {
  const w = runWatch(days, companies, { mode: "dual", rev });
  fs.writeFileSync(dualFile, JSON.stringify(w));
  log(`雙引擎觀察組合：${w.start} 起，資料日 ${w.asOf || "（尚未開始）"}，成交 ${w.trades.length} 筆，淨值 ${w.nav.at(-1)?.nav ?? WATCH.budget}（0050 對照 ${w.nav.at(-1)?.bench ?? WATCH.budget}），明天委託 ${w.pending.length} 筆`);
  log("雙引擎最後說明：", w.notes.at(-1)?.text);
  const trial = runWatch(days, companies, { mode: "dual", rev, start: days[Math.min(days.length - 1, 30)].date });
  const tv = trial.nav.at(-1);
  log(`雙引擎試跑（${trial.start} 起，不發布）：成交 ${trial.trades.length} 筆，淨值 ${tv?.nav}（${tv ? ((tv.nav / trial.budget - 1) * 100).toFixed(2) : "—"}%）0050 對照 ${tv?.bench}（${tv ? ((tv.bench / trial.budget - 1) * 100).toFixed(2) : "—"}%）`);
} catch (e) { log("雙引擎觀察組合失敗（不影響回測）：", e); }
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
// 推薦績效追蹤（使用者 11/7 要求）：PICKLOG 指到 stock-radar-log 分支裡的 picks.json（同一個資料夾還有 picks-etf.json、picks-us.json）；
// 只新增當天的名單，不改舊紀錄。三本各自 try，一本失敗不影響其他本與回測。
const pickLogFile = process.env.PICKLOG;
if (pickLogFile) {
  const logDir = path.dirname(pickLogFile);
  /** 一本紀錄：讀舊檔 → 加今天的名單 → 確認只新增 → 寫回；再算每筆績效寫 perf／csv */
  const runBook = (book: PickBook, today: { date: string; picks: Parameters<typeof appendPicks>[2] } | string, pathOf: (code: string, from: string) => PathPoint[], benchOf: (from: string) => { tai: Map<string, number>; b: Map<string, number> }, dataTo: string, source: string, cost: PickPerfFile["cost"]) => {
    const info = BOOK_INFO[book];
    const file = path.join(logDir, info.files.log);
    const before: PickLog = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : emptyLog(book);
    let logNow = before;
    if (typeof today === "string") log(`推薦績效（${info.label}）：${today}`);
    else {
      const res = appendPicks(before, today.date, today.picks, info.source);
      logNow = res.log;
      log(`推薦績效（${info.label}）：${today.date} ${info.source === "買入" ? "買入" : "分數前 10 名"} ${today.picks.length} 檔，新增 ${res.added} 筆（累計 ${logNow.picks.length} 筆，${logNow.start || "—"} 起）`);
    }
    assertAppendOnly(before, logNow);
    fs.writeFileSync(file, JSON.stringify(logNow, null, 1));
    const benchCache = new Map<string, ReturnType<typeof benchOf>>();
    // 已定案的持有期間沿用定案值；剛滿天數的這次定案（只新增，舊的不改）
    const finalFile = path.join(logDir, info.files.final);
    const finalBefore: FinalLog = fs.existsSync(finalFile) ? JSON.parse(fs.readFileSync(finalFile, "utf8")) : emptyFinal();
    const rows = sortPerfRows(logNow.picks.map((p) => { let bm = benchCache.get(p.date); if (!bm) benchCache.set(p.date, (bm = benchOf(p.date))); return applyFinal(evaluatePick(p, pathOf(p.code, p.date), bm.tai, bm.b), finalBefore); }));
    const fz = freezeResults(finalBefore, rows);
    assertFinalAppendOnly(finalBefore, fz.final);
    fs.writeFileSync(finalFile, JSON.stringify(fz.final, null, 1));
    if (fz.added) log(`推薦績效（${info.label}）：新定案 ${fz.added} 個持有期間結果（之後不再重算）`);
    const perf: PickPerfFile = { version: 1, generatedAt: Date.now(), start: logNow.start, dataTo, rule: logNow.rule, source, book, bench: info.bench, currency: info.currency, cost, rows };
    fs.writeFileSync(info.files.perf, JSON.stringify(perf));
    fs.writeFileSync(info.files.csv, toCsv(perf));
    log(`推薦績效（${info.label}）：${rows.length} 筆，已滿 5／10／20 日 ${[5, 10, 20].map((h) => rows.filter((r) => r.h[h as 5]).length).join("／")} 筆`);
  };
  const twCost: PickPerfFile["cost"] = { notional: PICK_NOTIONAL, feeRate: FEE_RATE, feeMinLot: FEE_MIN_LOT, feeMinOdd: FEE_MIN_ODD, taxStock: TAX_STOCK, taxEtf: TAX_ETF, stop: PICK_STOP };
  const twSource = "證交所、櫃買中心每日收盤行情與三大法人；加權指數為證交所每日收盤；報酬以每日漲跌連乘（已排除除權息）。由 GitHub Actions 每個交易日收盤後計算。";

  // 台股個股與 ETF：同一份行情
  try {
    const d0 = days[0];
    const dateIdx = new Map(days.map((d, i) => [d.date, i]));
    const onOrBefore = (ymd: string) => { for (let x = 0; x < 10; x++) { const i = dateIdx.get(addDays(ymd, -x)); if (i !== undefined) return i; } return undefined; };
    const m1 = onOrBefore(addDays(d0.date, -28)), m3 = onOrBefore(addDays(d0.date, -88));
    let todayTw: Parameters<typeof runBook>[1] = `${d0.date} 三大法人還沒公布，今天先不記錄`, todayEtf: Parameters<typeof runBook>[1] = todayTw;
    if (d0.flows.length && (m1 === undefined || m3 === undefined)) todayTw = todayEtf = "歷史資料不足，今天先不記錄";
    else if (d0.flows.length) {
      // 和 App 一樣：個股和 ETF 分開評分
      const all = adjustReturns(buildTwInputs({ latest: d0.quotes, week: days[5].quotes, month: days[m1!].quotes, quarter: days[m3!].quotes, flows: days.slice(0, 10).map((d) => d.flows), companies, tpexCodes: d0.tpexCodes }), exAll, { w1: days[5].date, m1: days[m1!].date, m3: days[m3!].date }, d0.date); // 和 App 一樣用還原除權息後的漲跌幅
      const rec = (x: { code: string; name: string; close: number; score: number; reasons: string[] }) => ({ code: x.code, name: x.name, market: d0.tpexCodes.has(x.code) ? "TPEX" as const : "TWSE" as const, price: x.close, score: x.score, reasons: x.reasons.slice(0, 2), dataDate: d0.date });
      todayTw = { date: d0.date, picks: scoreStocks(all.filter((x) => !isEtf(x.code))).scored.filter((x) => x.rating === "買入").map(rec) };
      todayEtf = { date: d0.date, picks: scoreStocks(all.filter((x) => isEtf(x.code))).scored.slice(0, ETF_TOP_N).map(rec) };
    }
    // 每檔每天的漲跌倍數（對除權息後的參考價）、0050 同理；加權指數用收盤
    const asc = [...days].reverse();
    const factor = new Map<string, Map<string, number>>(); // code → date → 當天倍數
    for (const d of asc) for (const r of d.quotes) { const c = r[2], ch = r[3], prev = exRefOn(exAll, r[0], d.date) ?? c - ch; if (c > 0 && prev > 0) { /* 除權息當天用官方參考價（行情漲跌欄只標 X） */ let m = factor.get(r[0]); if (!m) factor.set(r[0], (m = new Map())); m.set(d.date, c / prev); } }
    const pathOf = (code: string, from: string): PathPoint[] => { const m = factor.get(code); let f = 1; const out: PathPoint[] = []; for (const d of asc) { if (d.date <= from) continue; f *= m?.get(d.date) ?? 1; out.push({ date: d.date, f }); } return out; };
    const benchOf = (from: string) => {
      const t0 = taiexClose.get(from), tai = new Map<string, number>(), b = new Map<string, number>();
      for (const x of pathOf("0050", from)) { b.set(x.date, x.f - 1); const tc = taiexClose.get(x.date); if (t0 && tc) tai.set(x.date, tc / t0 - 1); }
      return { tai, b };
    };
    try { runBook("TW", todayTw, pathOf, benchOf, d0.date, twSource, twCost); } catch (e) { log("推薦績效（台股）失敗（不影響回測）：", e); }
    try { runBook("ETF", todayEtf, pathOf, benchOf, d0.date, twSource, twCost); } catch (e) { log("推薦績效（ETF）失敗（不影響回測）：", e); }
  } catch (e) { log("推薦績效（台股／ETF）失敗（不影響回測）：", e); }

  // 美股：Nasdaq 日 K（和 App 同一個來源與評分），只用已收盤的交易日
  try {
    const memKV = (): KV => { const m = new Map<string, unknown>(); return { async get(k) { return m.get(k) as any; }, async set(k, v) { m.set(k, v); }, async del(k) { m.delete(k); }, async keys() { return [...m.keys()]; } }; };
    const ul = new UsLoader(usFetcher, memKV());
    const snap = await ul.load();
    const closed = usLatestSession();
    const [qqq] = await Promise.all([ul.history("QQQ", true).catch(() => [])]);
    const barsOf = (sym: string) => (sym === "QQQ" ? qqq : snap.bars[sym] ?? []).filter((b) => b.date <= closed);
    const asOf = barsOf("SPY").at(-1)?.date ?? "";
    let today: Parameters<typeof runBook>[1];
    if (!asOf) today = "美股資料下載失敗，今天先不記錄";
    else if (snap.asOf > closed) today = `美股 ${snap.asOf} 還沒收盤，今天先不記錄`;
    else if (snap.failed.length > 10) today = `美股有 ${snap.failed.length} 檔下載失敗，今天先不記錄（避免名單不完整）`;
    else today = { date: asOf, picks: scoreStocks(snap.stocks).scored.filter((x) => x.rating === "買入").map((x) => ({ code: x.code, name: x.name, market: "US" as const, price: x.close, score: x.score, reasons: x.reasons.slice(0, 2), dataDate: asOf })) };
    if (snap.failed.length) log(`美股下載失敗：${snap.failed.join("、")}`);
    const closeMap = (sym: string) => new Map(barsOf(sym).map((b) => [b.date, b.close]));
    const cache = new Map<string, Map<string, number>>();
    const cm = (sym: string) => { let m = cache.get(sym); if (!m) cache.set(sym, (m = closeMap(sym))); return m; };
    const pathOf = (code: string, from: string): PathPoint[] => {
      const bars = barsOf(code), base = cm(code).get(from);
      if (!base) return [];
      return bars.filter((b) => b.date > from && b.close > 0).map((b) => ({ date: b.date, f: b.close / base }));
    };
    const benchOf = (from: string) => {
      const ret = (sym: string) => { const m = cm(sym), b0 = m.get(from), out = new Map<string, number>(); if (b0) for (const [d, c] of m) if (d > from) out.set(d, c / b0 - 1); return out; };
      return { tai: ret("SPY"), b: ret("QQQ") };
    };
    const usCost: PickPerfFile["cost"] = { notional: US_NOTIONAL, feeRate: US_FEE_RATE, feeMinLot: 0, feeMinOdd: 0, taxStock: 0, taxEtf: 0, stop: PICK_STOP };
    runBook("US", today, pathOf, benchOf, asOf || closed, "Nasdaq 每日收盤（日 K）、收盤後未更新時用 CNBC 正式收盤補上；S&P 500 用 SPY、那斯達克 100 用 QQQ 的收盤；報酬未含股利。由 GitHub Actions 每天計算前一個美股交易日。", usCost);
  } catch (e) { log("推薦績效（美股）失敗（不影響回測）：", e); }
}
log("完成", outFile, fs.statSync(outFile).size, "bytes，網路請求", requests);
}

main().catch((e) => { console.error("回測失敗：", e); process.exit(1); });
