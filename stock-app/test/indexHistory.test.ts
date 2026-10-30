import { describe, expect, it } from "vitest";
import { closesToBars, indexDay, indexHistory, INDEX_HIST_URL, parseCnbcBars, parseIndexDay, parseTaiexHist, parseTpexIndex } from "../src/data/indexHistory";

const memKv = (init: Record<string, unknown> = {}) => {
  const m = new Map<string, unknown>(Object.entries(init));
  return { get: async (k: string) => m.get(k), set: async (k: string, v: unknown) => { m.set(k, v); }, del: async (k: string) => { m.delete(k); }, _m: m } as any;
};
const noRemote = <T extends (u: string) => any>(f: T) => (async (u: string) => { if (u.startsWith(INDEX_HIST_URL)) throw new Error("沒有累積檔"); return f(u); }) as unknown as T;
const NOW = Date.UTC(2026, 9, 30, 8, 0); // 10/30 16:00 台北

describe("指數歷史", () => {
  it("解析加權 MI_5MINS_HIST（民國日期、逗號）", () => {
    const bars = parseTaiexHist({ stat: "OK", data: [["115/10/29", "23,000.10", "23,100.00", "22,900.50", "23,050.25"], ["115/10/30", "x", "1", "1", "x"]] });
    expect(bars).toEqual([{ date: "20261029", open: 23000.1, high: 23100, low: 22900.5, close: 23050.25, volume: 0 }]);
    expect(parseTaiexHist({ stat: "很抱歉" })).toEqual([]);
  });
  it("解析櫃買 tpex_index", () => {
    const bars = parseTpexIndex([{ Date: "20261030", Open: "300.5", High: "302", Low: "299", Close: "301.2", Change: "0.5" }, { Date: "bad", Close: "1" }]);
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ date: "20261030", open: 300.5, close: 301.2 });
  });
  it("只有收盤：開＝前一天收盤", () => {
    const b = closesToBars([{ date: "20261030", close: 90 }, { date: "20261029", close: 100 }]);
    expect(b[0]).toMatchObject({ date: "20261029", open: 100, close: 100 });
    expect(b[1]).toMatchObject({ date: "20261030", open: 100, high: 100, low: 90, close: 90 });
  });
  it("解析 MI_INDEX type=IND：只取追蹤的指數、休市回傳 null", () => {
    const j = { stat: "OK", tables: [
      { title: "價格指數(臺灣證券交易所)", fields: ["指數", "收盤指數", "漲跌(+/-)"], data: [["寶島股價指數", "52,047.99", "x"], ["發行量加權股價指數", "47,035.58", "x"], ["半導體類指數", "1,564.79", "x"], ["電子工業類指數", "5,000.5", "x"]] },
      { title: "報酬指數", fields: ["報酬指數", "收盤指數"], data: [["發行量加權股價報酬指數", "108,763.96"]] },
    ] };
    expect(parseIndexDay(j)).toEqual({ 發行量加權股價指數: 47035.58, 半導體類指數: 1564.79, 電子工業類指數: 5000.5 });
    expect(parseIndexDay({ stat: "很抱歉，沒有符合條件的資料!" })).toBeNull();
  });
  it("指數收盤：連網補抓並存起來、休市存空值、失敗不存", async () => {
    const kv = memKv();
    const calls: string[] = [];
    const f = async (u: string) => { calls.push(u); if (u.includes("20261029")) return { stat: "OK", tables: [{ fields: ["指數", "收盤指數"], data: [["電子類指數", "1,000.5"]] }] }; if (u.includes("20261028")) return { stat: "很抱歉" }; throw new Error("斷線"); };
    expect(await indexDay(f as any, kv, "20261029", NOW)).toEqual({ 電子類指數: 1000.5 });
    expect(await indexDay(f as any, kv, "20261028", NOW)).toEqual({});
    expect(await indexDay(f as any, kv, "20261027", NOW)).toBeUndefined();
    expect(kv._m.has("idx:d:20261027")).toBe(false);
    const n0 = calls.length;
    await indexDay(f as any, kv, "20261029", NOW); await indexDay(f as any, kv, "20261028", NOW);
    expect(calls.length).toBe(n0); // 都已存起來，不再連網
    expect(await indexDay(f as any, kv, "20261030", Date.UTC(2026, 9, 30, 2, 0))).toBeUndefined(); // 今天 10:00 還沒收盤：不問
  });
  it("臺灣50等：缺的交易日自動補抓，手機已有的先回報，串成開＝前一天收盤的 K 棒", async () => {
    const kv = memKv({ "idx:d:20261029": { 電子類指數: 1000 } });
    const parts: number[] = [];
    const f = async (u: string) => { const d = /date=(\d{8})/.exec(u)![1]; return { stat: "OK", tables: [{ fields: ["指數", "收盤指數"], data: [["電子類指數", String(1000 + (+d.slice(6)))]] }] }; };
    const h = await indexHistory(noRemote(f) as any, kv, "電子類指數", 6, NOW, (p) => parts.push(p.bars.length), 6);
    expect(h.kind).toBe("close");
    expect(parts[0]).toBe(1); // 先畫手機已有的那 1 天
    expect(h.bars.length).toBeGreaterThanOrEqual(5);
    const last = h.bars[h.bars.length - 1];
    expect(last.date).toBe("20261030");
    expect(last.open).toBe(h.bars[h.bars.length - 2].close);
    expect(parts[parts.length - 1]).toBe(h.bars.length);
  });
  it("使用者關掉畫面（stop）就不再繼續抓，已抓到的留在手機", async () => {
    const kv = memKv();
    let calls = 0, closed = false;
    const f = async (u: string) => { calls++; closed = true; const d = /date=(\d{8})/.exec(u)![1]; return { stat: "OK", tables: [{ fields: ["指數", "收盤指數"], data: [["電子類指數", String(1000 + (+d.slice(6)))]] }] }; };
    await indexHistory(noRemote(f) as any, kv, "電子類指數", 6, NOW, undefined, 30, () => closed);
    expect(calls).toBe(2); // 第一批 2 天之後就停
    expect([...kv._m.keys()].filter((k) => k.startsWith("idx:d:")).length).toBe(2);
  });
  it("電子類指數：每日資料叫「電子工業類指數」，舊快取叫「電子類指數」都認得", async () => {
    const kv = memKv({ "idx:d:20261029": { 電子工業類指數: 5000 }, "tw2:q:twse:20261028": { rows: [], indices: [{ name: "電子類指數", close: 4900 }] } });
    const f = async (u: string) => { throw new Error("不該連網 " + u); };
    const h = await indexHistory(noRemote(f) as any, kv, "電子類指數", 6, NOW, undefined, 3);
    expect(h.bars.map((b) => b.close)).toEqual([4900, 5000]);
  });
  it("App 舊的每日行情快取沒有要的指數（只存了其他指數）→ 照樣補抓，不能當作休市跳過", async () => {
    const kv = memKv({ "tw2:q:twse:20261029": { rows: [], indices: [{ name: "臺灣50指數", close: 41000 }] } });
    const calls: string[] = [];
    const f = async (u: string) => { calls.push(u); return { stat: "OK", tables: [{ fields: ["指數", "收盤指數"], data: [["電子工業類指數", "2,887.2"]] }] }; };
    const h = await indexHistory(noRemote(f) as any, kv, "電子類指數", 6, NOW, undefined, 2);
    expect(calls.some((u) => u.includes("20261029"))).toBe(true);
    expect(h.bars.map((b) => b.date)).toContain("20261029");
  });
  it("全部都連不上且手機沒有資料 → 丟錯", async () => {
    await expect(indexHistory((async () => { throw new Error("斷線"); }) as any, memKv(), "電子類指數", 6, NOW, undefined, 6)).rejects.toThrow();
  });
  it("櫃買：新資料與手機存的合併、同一天以新的為準", async () => {
    const kv = memKv({ "idx:o00": [{ date: "20260930", open: 1, high: 2, low: 1, close: 2, volume: 0 }, { date: "20261029", open: 5, high: 5, low: 5, close: 5, volume: 0 }] });
    const parts: number[] = [];
    const h = await indexHistory(async () => [{ Date: "20261029", Open: "6", High: "7", Low: "5", Close: "6.5" }, { Date: "20261030", Open: "6.5", High: "8", Low: "6", Close: "7" }], kv, "櫃買指數", 6, NOW, (p) => parts.push(p.bars.length));
    expect(parts).toEqual([2]);
    expect(h.bars.map((b) => [b.date, b.close])).toEqual([["20260930", 2], ["20261029", 6.5], ["20261030", 7]]);
    expect((kv._m.get("idx:o00") as any[]).length).toBe(3);
  });
  it("加權：先回報手機裡已有的月份，再下載其餘；失敗但已有資料就不丟錯", async () => {
    const ok = (ym: string, d: string) => ({ stat: "OK", data: [[`115/${d}`, "100", "110", "90", "105"]] });
    const calls: string[] = [];
    const kv = memKv();
    const h = await indexHistory(noRemote(async (u: string) => { calls.push(u); const ym = /date=(\d{6})/.exec(u)![1]; if (ym < "202608") throw new Error("斷線"); return ok(ym, `${ym.slice(4)}/01`); }), kv, "加權指數", 6, NOW);
    expect(calls[0]).toContain("date=20261001"); // 最新月份先抓
    expect(h.kind).toBe("ohlc");
    expect(h.bars.length).toBe(3); // 8、9、10 月
    // 第二次：8、9 月（已過去的月份）直接用快取，10 月因收盤後 key 不同也已存
    const calls2: string[] = [];
    await indexHistory(async (u: string) => { calls2.push(u); throw new Error("斷線"); }, kv, "加權指數", 6, NOW);
    expect(calls2.filter((u) => u.includes("MI_5MINS_HIST")).every((u) => /date=2026(0[1-7])01/.test(u))).toBe(true);
  });
  it("美股指數：CNBC bars 解析", () => {
    const bars = parseCnbcBars({ barData: { priceBars: [{ open: "7504.7800", high: "7610.0400", low: "7504.7800", close: "7600.5000", volume: 0, tradeTime: "20260803040000" }, { open: "x", high: "1", low: "1", close: "1", tradeTime: "20260804040000" }] } });
    expect(bars).toEqual([{ date: "20260803", open: 7504.78, high: 7610.04, low: 7504.78, close: 7600.5, volume: 0 }]);
    expect(parseCnbcBars({})).toEqual([]);
  });
  it("美股指數：手機存的先回報，抓到新的就存起來；斷線但有存的照樣回傳", async () => {
    const kv = memKv({ "idx:us:.SPX": [{ date: "20261001", open: 1, high: 2, low: 1, close: 2, volume: 0 }] });
    const parts: number[] = [];
    const f = async (u: string) => ({ barData: { priceBars: [{ open: "1", high: "3", low: "1", close: "2", tradeTime: "20261001040000" }, { open: "2", high: "4", low: "2", close: "3", tradeTime: "20261002040000" }] }, u });
    const h = await indexHistory(f as any, kv, ".SPX", 6, NOW, (p) => parts.push(p.bars.length));
    expect(parts).toEqual([1]);
    expect(h.bars).toHaveLength(2);
    expect((kv._m.get("idx:us:.SPX") as any[]).length).toBe(2);
    const h2 = await indexHistory((async () => { throw new Error("斷線"); }) as any, kv, ".SPX", 6, NOW);
    expect(h2.bars).toHaveLength(2);
  });
  it("每日排程累積檔：第一次打開就有完整走勢，只補檔案之後缺的交易日", async () => {
    const remote = { version: 1, ohlc: { 加權指數: [["20261028", 1, 2, 0.5, 1.5], ["20261029", 1.5, 3, 1, 2]], 櫃買指數: [["20260901", 10, 12, 9, 11]] },
      closes: { 電子工業類指數: [["20261027", 100], ["20261028", 110], ["20261029", 120]] }, seen: ["20261023", "20261026", "20261027", "20261028", "20261029"] };
    const urls: string[] = [];
    const f = async (u: string) => {
      urls.push(u);
      if (u.startsWith(INDEX_HIST_URL)) return remote;
      if (u.includes("MI_5MINS_HIST")) return { stat: "OK", data: [["115/10/30", "2", "3", "1", "2.5"]] };
      if (u.includes("tpex_index")) return [{ Date: "20261030", Open: "11", High: "13", Low: "10", Close: "12" }];
      if (u.includes("type=IND")) return { stat: "OK", tables: [{ fields: ["指數", "收盤指數"], data: [["電子工業類指數", "130"]] }] };
      throw new Error("意外的網址 " + u);
    };
    const kv = memKv();
    const parts: number[] = [];
    const w = await indexHistory(f as any, kv, "加權指數", 6, NOW, (p) => parts.push(p.bars.length));
    expect(parts[0]).toBe(2); // 一開始就用累積檔畫出來
    expect(w.bars.map((b) => b.date)).toEqual(["20261028", "20261029", "20261030"]);
    expect(urls.filter((u) => u.includes("MI_5MINS_HIST")).length).toBe(1); // 只補 10 月，不重抓更早月份
    const e = await indexHistory(f as any, kv, "電子類指數", 6, NOW, undefined, 6);
    expect(e.bars.map((b) => b.close)).toEqual([100, 110, 120, 130]);
    expect(urls.filter((u) => u.includes("type=IND")).map((u) => /date=(\d{8})/.exec(u)![1])).toEqual(["20261030"]); // 累積檔看過的日子都不再抓
    const o = await indexHistory(f as any, kv, "櫃買指數", 6, NOW);
    expect(o.bars.map((b) => b.date)).toEqual(["20260901", "20261030"]);
    expect(urls.filter((u) => u.startsWith(INDEX_HIST_URL)).length).toBe(1); // 累積檔一天內只下載一次
  });
});
