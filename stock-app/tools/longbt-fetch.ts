// 長期回測第二段：分批下載 2018 起的全市場日資料、除權息、月營收，存成可續傳的快取，最後驗證並印一行 LBT_SUMMARY。
// 快取用和 TwLoader 相同的鍵（tw2:q:twse:日期 等），之後回測引擎可以直接用 TwLoader 讀。
// 執行：npx vite build --ssr tools/longbt-fetch.ts --outDir .lbt-build && node .lbt-build/longbt-fetch.js .lbt-cache
import fs from "node:fs";
import path from "node:path";
import { TwLoader, type FRow } from "../src/data/twLoader";
import { parseTpexFlows, twUrls } from "../src/data/tw";
import { parseTpexExright, parseTwt49u, mergeEx, type ExMap } from "../src/engine/exdiv";
import { parseRevHtml, prevYm, type RevEntry } from "../src/engine/revHist";
import { addDays, taipeiToday, weekdaysBack } from "../src/lib/dates";
import type { KV } from "../src/lib/kv";

const cacheDir = process.argv[2] ?? ".lbt-cache";
const START = process.env.LBT_START ?? "20180102";
const budgetMs = Number(process.env.LBT_BUDGET_MIN ?? 75) * 60_000;
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
const kv = fileKV(cacheDir);

const GAP: Record<string, number> = { "www.twse.com.tw": 2100, "www.tpex.org.tw": 1100 };
const last = new Map<string, Promise<void>>();
let requests = 0, retries = 0;
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
      retries++;
      await new Promise((r) => setTimeout(r, Math.min(60_000, 10_000 * 2 ** a)));
    }
  }
}
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...a);
const over = () => Date.now() - t0 > budgetMs;
const ld = (s: string) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));

async function main() {
  const today = taipeiToday();
  const loader = new TwLoader(fetcher, kv);

  // ---- A. 除權息（上市 TWT49U、上櫃 exright），每段約 3 個月，已下載的段落不重抓 ----
  const exStats = { seg: 0, hit: 0, twseN: 0, tpexN: 0, fail: 0 };
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const slash = (d: Date, roc: boolean) => { const [y, m, dd] = d.toISOString().slice(0, 10).split("-"); return `${roc ? Number(y) - 1911 : y}/${m}/${dd}`; };
  const endAll = new Date(`${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6)}T00:00:00Z`);
  for (let st = new Date(`${START.slice(0, 4)}-${START.slice(4, 6)}-${START.slice(6)}T00:00:00Z`); st < endAll; st = new Date(st.getTime() + 92 * 864e5)) {
    const e = new Date(Math.min(st.getTime() + 91 * 864e5, endAll.getTime()));
    const full = e.getTime() < endAll.getTime() - 5 * 864e5; // 還沒結束的段落（含今天附近）不存，下次重抓
    exStats.seg++;
    const key = `lbt:ex:${fmt(st)}`;
    const hit = await kv.get<{ twse: ExMap; tpex: ExMap }>(key);
    if (hit) { exStats.hit++; exStats.twseN += Object.keys(hit.twse).length; exStats.tpexN += Object.keys(hit.tpex).length; continue; }
    let twse: ExMap = {}, tpex: ExMap = {}, ok1 = false, ok2 = false;
    for (const u of [`https://www.twse.com.tw/rwd/zh/exRight/TWT49U?response=json&startDate=${fmt(st)}&endDate=${fmt(e)}`, `https://www.twse.com.tw/exchangeReport/TWT49U?response=json&strDate=${fmt(st)}&endDate=${fmt(e)}`]) {
      try { const j = await fetcher(u); const p = parseTwt49u(j); if (j?.stat === "OK" || Object.keys(p).length) { twse = p; ok1 = true; break; } } catch { /* 試下一個網址 */ }
    }
    for (const u of [`https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?startDate=${encodeURIComponent(slash(st, false))}&endDate=${encodeURIComponent(slash(e, false))}&response=json`, `https://www.tpex.org.tw/web/stock/exright/dailyquo/exDailyQ_result.php?l=zh-tw&d=${encodeURIComponent(slash(st, true))}&ed=${encodeURIComponent(slash(e, true))}&o=json`]) {
      try { const p = parseTpexExright(await fetcher(u)); if (Object.keys(p).length) { tpex = p; ok2 = true; break; } } catch { /* 試下一個網址 */ }
    }
    if (!ok1 || !ok2) exStats.fail++;
    exStats.twseN += Object.keys(twse).length; exStats.tpexN += Object.keys(tpex).length;
    if (ok1 && ok2 && full) await kv.set(key, { twse, tpex });
  }
  log(`除權息：${exStats.seg} 段（快取 ${exStats.hit}），上市 ${exStats.twseN} 檔次、上櫃 ${exStats.tpexN} 檔次，缺 ${exStats.fail} 段`);

  // ---- B. 月營收（上市 sii、上櫃 otc），公布月 15 日後的才存 ----
  const rev = { got: 0, hit: 0, bad: [] as string[] };
  {
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
    const dec = new TextDecoder("big5");
    const lastYm = prevYm(today.slice(0, 6), 1);
    for (let ym = prevYm(START.slice(0, 6), 1); ym <= lastYm && !over(); ym = prevYm(ym, -1)) {
      for (const mk of ["sii", "otc"] as const) {
        const file = path.join(cacheDir, `rev-${mk}-${ym}.json`);
        if (fs.existsSync(file)) { rev.hit++; continue; }
        const roc = `${Number(ym.slice(0, 4)) - 1911}_${Number(ym.slice(4))}`;
        let rows: RevEntry[] | undefined, err = "";
        for (const host of ["mopsov.twse.com.tw", "mops.twse.com.tw"]) {
          try {
            requests++;
            const r = await fetch(`https://${host}/nas/t21/${mk}/t21sc03_${roc}_0.html`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(40_000) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const p = parseRevHtml(dec.decode(await r.arrayBuffer()));
            if (p.length < 300) throw new Error(`只解析到 ${p.length} 家`);
            rows = p; break;
          } catch (e) { err = String(e).slice(0, 60); }
          await new Promise((r) => setTimeout(r, 2000));
        }
        await new Promise((r) => setTimeout(r, 1500));
        if (rows) { rev.got++; if (today >= `${prevYm(ym, -1)}15`) fs.writeFileSync(file, JSON.stringify(rows)); } else rev.bad.push(`${mk}${ym}(${err})`);
      }
    }
    log(`月營收：快取 ${rev.hit}、新下載 ${rev.got}、失敗 ${rev.bad.length}${rev.bad.length ? " " + rev.bad.slice(0, 6).join(",") : ""}`);
  }

  // ---- C. 每日行情與三大法人（舊到新），逐日存快取，超過時間預算就停，下次接著下載 ----
  const weekdays = weekdaysBack(today, 3000).filter((d) => d >= START).reverse();
  let done = 0, fetched = 0, holidays = 0, budgetHit = false, stopErr = "";
  for (const d of weekdays) {
    if (over()) { budgetHit = true; break; }
    const had = [`tw2:q:twse:${d}`, `tw2:f:twse:${d}`, `tw2:q:tpex:${d}`, `tw2:f:tpex:${d}`, `lbt:nf:${d}`];
    const before = requests;
    try {
      const qa = await loader.twseQuotes(d);
      if (!qa) { holidays++; done++; continue; }
      const jobs: Promise<unknown>[] = [loader.twseFlows(d), loader.tpexQuotes(d)];
      // 櫃買法人：格式不認得時存「格式資訊」，不要每次重抓；之後修好解析再刪掉這些標記重跑
      jobs.push((async () => {
        if (await kv.get(`tw2:f:tpex:${d}`) !== undefined || await kv.get(`lbt:nf:${d}`) !== undefined) return;
        const j = await fetcher(twUrls.tpexFlows(ld(d)));
        const f = parseTpexFlows(j);
        if (f && f.length) await kv.set(`tw2:f:tpex:${d}`, f.map((x): FRow => [x.code, x.foreign, x.trust, x.dealer]));
        else { const t = j?.tables?.[0]; await kv.set(`lbt:nf:${d}`, { n: t?.fields?.length ?? 0, fields: (t?.fields ?? []).slice(0, 30), rows: t?.data?.length ?? 0, keys: Object.keys(j ?? {}) }); }
      })());
      await Promise.all(jobs);
    } catch (e) { stopErr = `${d} ${String(e).slice(0, 100)}`; log("下載失敗，先停在這裡（下次接著下載）：", stopErr); break; }
    done++;
    if (requests > before) fetched++;
    void had;
    if (fetched > 0 && fetched % 25 === 0 && requests > before) log(`進度 ${done}/${weekdays.length}（本次新下載 ${fetched} 天，請求 ${requests}，重試 ${retries}）`);
  }
  log(`每日資料：本次新下載 ${fetched} 天，已處理到第 ${done}/${weekdays.length} 個平日${budgetHit ? "（時間預算用完，下次接著）" : ""}`);

  // ---- D. 驗證（只讀快取）----
  const tradingDays: string[] = [];
  const miss = { twseF: [] as string[], tpexQ: [] as string[], tpexF: [] as string[] };
  const schemas = new Map<string, { first: string; last: string; n: number }>();
  const drops: string[] = [];
  let prevN = 0, no50 = 0;
  const closes = new Map<string, Map<string, number>>(); // 日期 → 代號 → 收盤
  for (const d of weekdays.slice(0, done)) {
    const qa = await kv.get<any>(`tw2:q:twse:${d}`);
    if (!qa || qa.holiday) continue;
    tradingDays.push(d);
    const qb = await kv.get<any>(`tw2:q:tpex:${d}`);
    if (!(await kv.get<any>(`tw2:f:twse:${d}`))) miss.twseF.push(d);
    if (!qb) miss.tpexQ.push(d);
    const f = await kv.get<any>(`tw2:f:tpex:${d}`);
    if (!f) {
      miss.tpexF.push(d);
      const nf = await kv.get<any>(`lbt:nf:${d}`);
      const sig = nf ? `欄數${nf.n}｜${(nf.fields ?? []).slice(0, 4).join("/")}｜列數${nf.rows}` : "無資料";
      const s = schemas.get(sig); if (s) { s.last = d; s.n++; } else schemas.set(sig, { first: d, last: d, n: 1 });
    }
    const n = qa.rows.length;
    if (prevN && n < prevN * 0.8) drops.push(`${d}(${prevN}→${n})`);
    prevN = n;
    const m = new Map<string, number>();
    for (const r of [...qa.rows, ...(qb?.rows ?? [])]) m.set(r[0], r[2]);
    closes.set(d, m);
    if (!m.has("0050")) no50++;
  }
  // 除權息事件日（上市＋上櫃官方表）：價格跳動超過 ±11% 又不在事件日的才算異常
  const ex: ExMap = {};
  for (const k of await kv.keys()) if (k.startsWith("lbt:ex:")) { const v = await kv.get<{ twse: ExMap; tpex: ExMap }>(k); if (v) { const mm = mergeEx(v.twse, v.tpex); for (const [c, l] of Object.entries(mm)) (ex[c] ??= []).push(...l); } }
  const jumps: string[] = [];
  let jumpN = 0;
  for (let i = 1; i < tradingDays.length; i++) {
    const a = closes.get(tradingDays[i - 1])!, b = closes.get(tradingDays[i])!;
    for (const [c, p1] of b) {
      const p0 = a.get(c);
      if (!p0 || !(p1 > 0) || Math.abs(p1 / p0 - 1) <= 0.11) continue;
      if (ex[c]?.some((e) => e[0] === tradingDays[i])) continue;
      jumpN++;
      if (jumps.length < 6 && /^\d{4}$|^00\d{2,3}$/.test(c)) jumps.push(`${tradingDays[i]} ${c} ${p0}→${p1}`);
    }
  }
  const perYear = new Map<string, number>();
  for (const d of tradingDays) perYear.set(d.slice(0, 4), (perYear.get(d.slice(0, 4)) ?? 0) + 1);
  log("每年交易日數：" + [...perYear].map(([y, n]) => `${y}:${n}`).join(" "));
  log("上櫃法人缺少的格式：" + ([...schemas].map(([s, v]) => `[${s}] ${v.first}～${v.last} ${v.n} 天`).join("；") || "無"));
  log(`上市行情筆數較前一交易日掉 20% 以上：${drops.length ? drops.slice(0, 8).join(" ") : "無"}`);
  log(`未被除權息表解釋的單日漲跌超過 ±11%：${jumpN} 次，例：${jumps.join("；") || "無"}`);
  const files = fs.readdirSync(cacheDir);
  const mb = files.reduce((s, f) => s + fs.statSync(path.join(cacheDir, f)).size, 0) / 1e6;
  const remain = weekdays.length - done;
  console.log(`LBT_SUMMARY 交易日 ${tradingDays.length}／已處理平日 ${done}／全部 ${weekdays.length}（剩 ${remain}）｜缺 上市法人 ${miss.twseF.length}、上櫃行情 ${miss.tpexQ.length}、上櫃法人 ${miss.tpexF.length}｜0050 缺 ${no50} 天｜無法解釋的跳動 ${jumpN}｜除權息缺 ${exStats.fail} 段｜月營收失敗 ${rev.bad.length}｜快取 ${files.length} 檔 ${mb.toFixed(0)}MB｜本次請求 ${requests}、重試 ${retries}、耗時 ${((Date.now() - t0) / 60000).toFixed(1)} 分${stopErr ? "｜中斷：" + stopErr : ""}${remain === 0 ? "｜下載完成" : "｜尚未完成，需再跑一次"}`);
}
main().catch((e) => { console.error("LBT_FATAL", e); process.exit(1); });
