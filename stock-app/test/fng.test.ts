import { describe, expect, it } from "vitest";
import { fngLabel, parseFng } from "../src/data/fng";

// alternative.me /fng/ 的回應格式（最新在最前面）
const mk = (vals: number[], cls = "Greed") => ({
  name: "Fear and Greed Index",
  data: vals.map((v, i) => ({ value: String(v), value_classification: i === 0 ? cls : "Neutral", timestamp: String(1793664000 - i * 86400) })),
  metadata: { error: null },
});

describe("虛擬幣恐懼貪婪指數", () => {
  it("今天、昨天、一週前、一個月前與中文分級", () => {
    const vals = Array.from({ length: 31 }, (_, i) => 70 - i);
    const f = parseFng(mk(vals, "Greed"))!;
    expect(f).toMatchObject({ value: 70, label: "貪婪", prev: 69, weekAgo: 63, monthAgo: 40 });
    expect(f.date).toMatch(/^\d{8}$/);
  });
  it("近一年歷史（由舊到新）、一年內最高最低與日期、連續幾天在同一分級", () => {
    // 最新在前：今天 80、昨天 78、前天 60、之前都 30（其中一天 5）
    const vals = [80, 78, 60, 30, 30, 5, 30];
    const f = parseFng(mk(vals, "Extreme Greed"))!;
    expect(f.hist!.map((h) => h.value)).toEqual([...vals].reverse());
    expect(f.hist![0].date < f.hist!.at(-1)!.date).toBe(true);
    expect(f.high!.value).toBe(80);
    expect(f.high!.date).toBe(f.date);
    expect(f.low!.value).toBe(5);
    expect(f.streak).toBe(2); // 80、78 都是極度貪婪，60 是貪婪
  });
  it("只有一天的資料也能顯示", () => {
    expect(parseFng(mk([12], "Extreme Fear"))).toMatchObject({ value: 12, label: "極度恐懼", prev: undefined });
  });
  it("分級不認得時用分數切點", () => {
    expect(parseFng(mk([50], "???"))!.label).toBe("中立");
    expect([0, 24, 25, 44, 45, 55, 56, 75, 76, 100].map(fngLabel)).toEqual(["極度恐懼", "極度恐懼", "恐懼", "恐懼", "中立", "中立", "貪婪", "貪婪", "極度貪婪", "極度貪婪"]);
  });
  it("格式不對就回傳 undefined，不報錯", () => {
    expect(parseFng(undefined)).toBeUndefined();
    expect(parseFng({ data: [] })).toBeUndefined();
    expect(parseFng({ data: [{ value: "abc" }] })).toBeUndefined();
  });
});
