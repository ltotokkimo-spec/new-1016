import { describe, expect, it } from "vitest";
import { knownYm, parseRevHtml, prevYm, revFactors, revTable, type RevEntry } from "../src/engine/revHist";

describe("歷史月營收（雙引擎成長組用）", () => {
  it("解析公開資訊觀測站的營收彙總表（大小寫混用的 td、千分位、合計列與表頭略過）", () => {
    const html = `<table><tr><th>公司代號</th><th>公司名稱</th></tr>
      <tr align=right><td align=center>2330</td><td align=left>台積電</td><td nowrap> 511,857,399</td><td nowrap> 514,805,337</td><td nowrap> 330,980,920</td><td nowrap> -0.57</td><Td nowrap> 54.64</td><td nowrap> 3,898,726,974</td><td nowrap> 2,762,963,851</td><td nowrap> 41.10</td><td align=left>因先進製程產品需求增加所致。</td></tr>
      <tr align=right><td align=center>2337</td><td align=left>旺宏</td><td nowrap> 8,367,275</td><td nowrap> 8,145,267</td><td nowrap> </td><td nowrap> 2.72</td><Td nowrap> 188.23</td><td nowrap> 1</td><td nowrap> 1</td><td nowrap> 1</td><td>-</td></tr>
      <tr align=right><th colspan=2>合計</th><td nowrap> 520,224,674</td><td nowrap> 1</td><td nowrap> 1</td><td nowrap> 1</td><td nowrap> 1</td><td nowrap> 1</td><td nowrap> 1</td><td nowrap> 1</td></tr></table>`;
    const rows = parseRevHtml(html);
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual(["2330", 511857399, 330980920]);
    expect(rows[1][0]).toBe("2337");
    expect(rows[1][2]).toBeNaN(); // 去年同月是空的（新上市）：不能當成 0
  });
  it("每月 11 日起才用上個月的營收（10 日以前還沒公布完）", () => {
    expect(knownYm("20261110")).toBe("202609");
    expect(knownYm("20261111")).toBe("202610");
    expect(knownYm("20260105")).toBe("202511");
    expect(knownYm("20260112")).toBe("202512");
    expect(prevYm("202601", 1)).toBe("202512");
    expect(prevYm("202612", -1)).toBe("202701");
  });
  it("近 3 個月年增率、營收創 12 個月新高；資料有缺就不給", () => {
    const months: { ym: string; rows: RevEntry[] }[] = [];
    for (let k = 0; k < 12; k++) months.push({ ym: prevYm("202610", k), rows: [["1111", k === 0 ? 300 : 100 + k, 100], ["2222", 100 - k, 200], ["3333", 100, 100]] });
    months[1].rows = months[1].rows.filter((r) => r[0] !== "3333"); // 3333 少一個月
    const t = revTable(months);
    const a = revFactors(t, "1111", "20261113")!;
    expect(a.ym).toBe("202610");
    expect(a.yoy3).toBeCloseTo((300 + 101 + 102) / 300 - 1, 10);
    expect(a.newHigh).toBe(1);
    const b = revFactors(t, "2222", "20261113")!;
    expect(b.yoy3).toBeLessThan(0);
    expect(b.newHigh).toBe(1); // 每月遞增（越新越高）
    expect(revFactors(t, "3333", "20261113")).toBeUndefined();
    expect(revFactors(t, "1111", "20261110")!.ym).toBe("202609"); // 10 日還不能用 10 月營收
    expect(revFactors(t, "9999", "20261113")).toBeUndefined();
  });
});
