import { describe, expect, it } from "vitest";
import { dtPicks } from "../src/engine/volRank";

const q = (code: string, o: Partial<{ price: number; prevClose: number; volume: number; open: number; high: number; low: number; limit: "up" | "down" }>) =>
  ({ code, name: code, price: 100, prevClose: 100, volume: 5_000_000, open: 100, high: 103, low: 98, ...o });

describe("當沖推薦", () => {
  it("排除漲停鎖住、振幅太小、成交值太小、處置；量能大振幅大的排前面", () => {
    const r = dtPicks([
      q("A", { price: 102, high: 104, low: 97, volume: 9_000_000 }), // 大量、振幅 7%、偏多
      q("B", { high: 100.5, low: 99.8 }), // 振幅太小
      q("C", { price: 110, high: 110, low: 104, limit: "up" }), // 漲停鎖住
      q("D", { volume: 500_000 }), // 成交值 5 千萬
      q("E", {}), // 處置
      q("F", { price: 98.5, open: 100, high: 101, low: 98, volume: 4_000_000 }),
    ], new Map([["A", 3_000_000], ["F", 4_000_000]]), 1, (c) => c === "E");
    expect(r.map((x) => x.code)).toEqual(["A", "F"]);
    expect(r[0].bias).toBe("高檔");
    expect(r[1].bias).toBe("低檔");
    expect(r[0].relVol).toBeCloseTo(3);
  });
});
