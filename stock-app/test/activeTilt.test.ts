import { describe, expect, it } from "vitest";
import { latestTilt, tiltDays, tiltOf } from "../src/lib/activeEtf";

describe("主動式 ETF 主動加減碼（扣掉申購造成的同比例買進）", () => {
  it("整檔申購 +10%：同比例加的不算，多加的才算加碼、少加的算減碼、新買算加碼、賣光算減碼", () => {
    const s0 = { "2330": 1000, "2317": 1000, "2454": 1000, "2412": 1000, "1301": 500 };
    const s1 = { "2330": 1100, "2317": 1100, "2454": 1400, "2412": 1000, "2603": 300 };
    const t = tiltOf(s0, s1);
    expect(t.buys.sort()).toEqual(["2454", "2603"]);
    expect(t.sells.sort()).toEqual(["1301", "2412"]);
  });
  it("tiltDays 依日期合計；latestTilt 從最新持股還原前一份", () => {
    const hist = { version: 1 as const, etfs: {
      A: { name: "A", snaps: [{ date: "20261125", shares: { "2330": 100, "2317": 100, "2454": 100 } }, { date: "20261126", shares: { "2330": 100, "2317": 100, "2454": 150 } }] },
      B: { name: "B", snaps: [{ date: "20261125", shares: { "2330": 100, "2317": 100, "2454": 100 } }, { date: "20261126", shares: { "2330": 100, "2317": 100, "2454": 130 } }] },
    } };
    const d = tiltDays(hist);
    expect(d.length).toBe(1);
    expect(d[0].buy["2454"]).toEqual(["A", "B"]);
    const data = { version: 1 as const, updatedAt: "", etfs: [], latest: { A: hist.etfs.A.snaps[1], B: hist.etfs.B.snaps[1] },
      days: [{ date: "20261126", prev: { A: "20261125", B: "20261125" }, flows: { "2454": { s: 80, b: [["A", 50], ["B", 30]] as [string, number][] } } }] };
    expect(latestTilt(data)?.buy["2454"]).toEqual(["A", "B"]);
  });
});
