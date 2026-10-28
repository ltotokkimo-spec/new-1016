import { describe, expect, it } from "vitest";
import { activeRank, addSnap, buildActiveData, buildActiveDays, mergeLive, parseMoneyDjHoldings, etfBreakdown, etfHoldings, type ActiveHist } from "../src/lib/activeEtf";

// MoneyDJ「全部持股」頁的實際結構（10/27 從 GitHub Actions 探測取得，節錄）
const html = `<div>首頁 / ETF介紹 / 個別ETF-全部持股</div><h3>主動統一台股增長(00981A.TW)-全部持股</h3><div>資料日期：2026/10/22</div>
<table class="datalist" id="ctl00_ctl00_MainContent_MainContent_stable3"><thead><tr><th scope="col">個股名稱</th><th scope="col">投資比例(%)</th><th scope="col">持有股數 / 口數</th></tr></thead><tbody>
<tr class="even"><td class="col05"><a href='/etf/ea/ETZCW.djhtm?c=1&etfid=2330.TW&back=00981A.TW'>台積電(2330.TW)</a></td><td class="col06">11.34</td><td class="col07">12,671,000</td></tr>
<tr class="odd"><td class="col05"><a href='x'>國巨*(2327.TW)</a></td><td class="col06">4.47</td><td class="col07">23,519,000</td></tr>
<tr class="even"><td class="col05">台指期貨 2026/11(FITXN*1.TF)</td><td class="col06">2.36</td><td class="col07">679</td></tr>
<tr class="odd"><td class="col05"><a href='x'>貿聯-KY(3665.TW)</a></td><td class="col06">2.03</td><td class="col07">2,887,848</td></tr>
</tbody></table>`;

describe("主動式 ETF 持股解析", () => {
  it("解析代號、名稱、資料日與台股股數，期貨不算", () => {
    const p = parseMoneyDjHoldings(html)!;
    expect(p.code).toBe("00981A");
    expect(p.name).toBe("主動統一台股增長");
    expect(p.date).toBe("20261022");
    expect(p.shares).toEqual({ "2330": 12_671_000, "2327": 23_519_000, "3665": 2_887_848 });
  });
  it("頁面沒有資料日或代號就回傳 undefined", () => {
    expect(parseMoneyDjHoldings("<html>查無資料</html>")).toBeUndefined();
  });
});

describe("主動式 ETF 個股買賣超", () => {
  let h: ActiveHist = { version: 1, etfs: {} };
  h = addSnap(h, "A1", "甲", { date: "20261021", shares: { "2330": 1000, "2454": 5000 } });
  h = addSnap(h, "A1", "甲", { date: "20261022", shares: { "2330": 3000, "3037": 2000 } }); // 2330 +2000、2454 全賣 -5000、3037 新買 +2000
  h = addSnap(h, "A2", "乙", { date: "20261022", shares: { "2330": 9000 } }); // 只有一份，不能比對
  h = addSnap(h, "A2", "乙", { date: "20261027", shares: { "2330": 8000 } }); // 10/27 -1000
  it("同一天重抓會覆蓋，不重複", () => {
    const h2 = addSnap(h, "A1", "甲", { date: "20261022", shares: { "2330": 3000, "3037": 2000 } });
    expect(h2.etfs.A1.snaps).toHaveLength(2);
  });
  it("相鄰兩份持股相減，算在後一份的日期；新買、全部賣出都算", () => {
    const days = buildActiveDays(h);
    expect(days.map((d) => d.date)).toEqual(["20261027", "20261022"]);
    const d22 = days[1];
    expect(d22.flows["2330"]).toEqual({ s: 2000, b: [["A1", 2000]] });
    expect(d22.flows["2454"].s).toBe(-5000);
    expect(d22.flows["3037"].s).toBe(2000);
    expect(d22.prev).toEqual({ A1: "20261021" });
    expect(days[0].flows["2330"]).toEqual({ s: -1000, b: [["A2", -1000]] });
  });
  it("排名：近 N 天合計、依金額，列出是哪幾檔 ETF 買的", () => {
    const data = buildActiveData(h, "t");
    expect(data.etfs.map((e) => [e.code, e.date, e.n])).toEqual([["A1", "20261022", 2], ["A2", "20261027", 1]]);
    const px: Record<string, number> = { "2330": 1000, "2454": 1500, "3037": 200 };
    const look = (c: string) => (px[c] ? { code: c, close: px[c] } : undefined);
    const r1 = activeRank(data, 1, look);
    expect(r1.used.map((d) => d.date)).toEqual(["20261027"]);
    expect(r1.sell.map((x) => [x.item.code, x.amount])).toEqual([["2330", -1_000_000]]);
    const r5 = activeRank(data, 5, look);
    expect(r5.buy.map((x) => [x.item.code, x.shares, x.amount])).toEqual([["3037", 2000, 400_000], ["2330", 1000, 1_000_000]].sort((a, b) => (b[2] as number) - (a[2] as number)));
    expect(r5.buy.find((x) => x.item.code === "2330")!.buyers).toEqual([["A1", 2000], ["A2", -1000]]);
    expect(r5.sell.map((x) => x.item.code)).toEqual(["2454"]);
    expect(activeRank(undefined, 1, look).buy).toEqual([]);
  });
});

describe("App 自己補抓最新持股", () => {
  let h: ActiveHist = { version: 1, etfs: {} };
  h = addSnap(h, "A1", "甲", { date: "20261021", shares: { "2330": 1000 } });
  h = addSnap(h, "A1", "甲", { date: "20261022", shares: { "2330": 3000 } });
  h = addSnap(h, "A2", "乙", { date: "20261022", shares: { "2454": 500 } });
  const data = buildActiveData(h, "t");
  it("GitHub 資料帶各 ETF 最新一份持股", () => {
    expect(data.latest).toEqual({ A1: { date: "20261022", shares: { "2330": 3000 } }, A2: { date: "20261022", shares: { "2454": 500 } } });
  });
  it("抓到較新的持股就算出新的一天；舊的或同一天不重複", () => {
    const m = mergeLive(data, [
      { code: "A1", name: "甲", date: "20261027", shares: { "2330": 2000, "3037": 100 } },
      { code: "A2", name: "乙", date: "20261022", shares: { "2454": 9999 } }, // 同一天，不算
    ]);
    expect(m.days.map((d) => d.date)).toEqual(["20261027", "20261022"]);
    expect(m.days[0].flows).toEqual({ "2330": { s: -1000, b: [["A1", -1000]] }, "3037": { s: 100, b: [["A1", 100]] } });
    expect(m.days[0].prev).toEqual({ A1: "20261022" });
    expect(m.latest!.A1.date).toBe("20261027");
    expect(m.etfs.find((e) => e.code === "A1")!.date).toBe("20261027");
    expect(m.live).toBe("20261027");
    // 再補 A2 的 10/27：併進同一天，A1 不重算
    const m2 = mergeLive(m, [{ code: "A1", name: "甲", date: "20261027", shares: { "2330": 2000, "3037": 100 } }, { code: "A2", name: "乙", date: "20261027", shares: { "2454": 700 } }]);
    expect(m2.days[0].flows["2330"].s).toBe(-1000);
    expect(m2.days[0].flows["2454"]).toEqual({ s: 200, b: [["A2", 200]] });
    expect(Object.keys(m2.days[0].prev).sort()).toEqual(["A1", "A2"]);
    expect(mergeLive(data, [])).toBe(data);
  });
});

describe("點進個股看是哪幾檔主動式 ETF 買賣", () => {
  let h: ActiveHist = { version: 1, etfs: {} };
  h = addSnap(h, "A1", "主動甲", { date: "20261021", shares: { "2330": 1000, "2454": 5000 } });
  h = addSnap(h, "A1", "主動甲", { date: "20261022", shares: { "2330": 3000, "3037": 2000 } });
  h = addSnap(h, "A1", "主動甲", { date: "20261027", shares: { "2330": 2500, "3037": 2000 } });
  h = addSnap(h, "A2", "主動乙", { date: "20261022", shares: { "2330": 9000 } });
  h = addSnap(h, "A2", "主動乙", { date: "20261027", shares: { "2330": 9800 } });
  const data = buildActiveData(h, "t");
  it("最新一天：每檔 ETF 的增減與持股前後", () => {
    const r = etfBreakdown(data, "2330", 1);
    expect(r.used.map((d) => d.date)).toEqual(["20261027"]);
    expect(r.rows.map((x) => [x.etf, x.name, x.delta, x.before, x.after])).toEqual([["A2", "主動乙", 800, 9000, 9800], ["A1", "主動甲", -500, 3000, 2500]]);
  });
  it("多天合計並保留每天明細；新增與清倉也看得出來", () => {
    const r = etfBreakdown(data, "2330", 5);
    const a1 = r.rows.find((x) => x.etf === "A1")!;
    expect(a1.delta).toBe(1500); // +2000（10/22）−500（10/27）
    expect(a1.perDay).toEqual([["20261027", -500], ["20261022", 2000]]);
    expect(a1.before).toBe(1000);
    const n = etfBreakdown(data, "3037", 5).rows[0];
    expect([n.delta, n.before, n.after]).toEqual([2000, 0, 2000]); // 新增
    const out = etfBreakdown(data, "2454", 5).rows[0];
    expect([out.delta, out.after]).toEqual([-5000, 0]); // 清倉
    expect(etfBreakdown(undefined, "2330", 1).rows).toEqual([]);
  });
});

describe("點進主動式 ETF 看買賣的成份", () => {
  let h: ActiveHist = { version: 1, etfs: {} };
  h = addSnap(h, "A1", "主動甲", { date: "20261022", shares: { "2330": 3000, "2454": 5000, "1101": 700 } });
  h = addSnap(h, "A1", "主動甲", { date: "20261027", shares: { "2330": 2500, "3037": 2000, "1101": 700 } });
  const data = buildActiveData(h, "t");
  it("列出買進、賣出（含新增、清倉）與完整持股，持股依股數大到小", () => {
    const r = etfHoldings(data, "A1", 1)!;
    expect(r.date).toBe("20261027");
    expect(r.moves.map((m) => [m.code, m.delta, m.before, m.after])).toEqual([["2454", -5000, 5000, 0], ["2330", -500, 3000, 2500], ["3037", 2000, 0, 2000]].sort((a, b) => Math.abs(b[1] as number) - Math.abs(a[1] as number)));
    expect(r.hold.map((x) => [x.code, x.shares, x.delta])).toEqual([["2330", 2500, -500], ["3037", 2000, 2000], ["1101", 700, 0]]);
    expect(r.n).toBe(3);
  });
  it("沒有這檔或沒有資料就回傳 undefined；只有一份持股時沒有買賣、仍列出持股", () => {
    expect(etfHoldings(data, "ZZ", 1)).toBeUndefined();
    expect(etfHoldings(undefined, "A1", 1)).toBeUndefined();
    const one = buildActiveData(addSnap({ version: 1, etfs: {} }, "B1", "主動丙", { date: "20261027", shares: { "2330": 100 } }), "t");
    const r = etfHoldings(one, "B1", 1)!;
    expect([r.moves.length, r.hold.length, r.used.length]).toEqual([0, 1, 0]);
  });
});
