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
