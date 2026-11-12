import { describe, expect, it } from "vitest";
import { flagOf, parseDisposal, parseEligible, periodOf, rowsOf, toYmd } from "../src/engine/dtFlags";

describe("當沖標示", () => {
  it("民國日期與期間", () => {
    expect(toYmd("115/11/12")).toBe("20261112");
    expect(toYmd("1151112")).toBe("20261112");
    expect(periodOf("115/11/12～115/11/25")).toEqual(["20261112", "20261125"]);
    expect(periodOf("1151110~1151116")).toEqual(["20261110", "20261116"]);
  });
  it("處置股：證交所 OpenAPI 格式，只留期間內、4 碼股票", () => {
    const j = [
      { Number: "1", Date: "1151111", Code: "2360", Name: "致茂", ReasonsOfDisposition: "連續三次", DispositionPeriod: "115/11/12～115/11/25", DispositionMeasures: "第一次處置" },
      { Code: "2455", Name: "全新", DispositionPeriod: "115/11/01～115/11/10" },
      { Code: "064019", Name: "權證", DispositionPeriod: "115/11/12～115/11/25" },
    ];
    const m = parseDisposal(j, "20261112");
    expect([...m.keys()]).toEqual(["2360"]);
    expect(m.get("2360")?.period).toBe("11/12～11/25");
  });
  it("處置股：櫃買格式", () => {
    const j = [{ SecuritiesCompanyCode: "4542", CompanyName: "科嶠", DispositionPeriod: "1151110~1151116", DispositionReasons: "連續3個營業日" }];
    expect([...parseDisposal(j, "20261112").keys()]).toEqual(["4542"]);
  });
  it("可當沖標的：證交所 tables 格式，含暫停先賣後買註記", () => {
    const rows = Array.from({ length: 250 }, (_, i) => [String(1000 + i), `測試${i}`, i === 3 ? "Y" : "", "1,000"]);
    const j = { stat: "OK", tables: [{ title: "統計", fields: ["項目", "成交股數"], data: [["當日沖銷交易總成交股數", "3,997,002,000"]] }, { title: "標的", fields: ["證券代號", "證券名稱", "暫停現股賣出後現款買進當沖註記", "當日沖銷交易成交股數"], data: rows }] };
    expect(rowsOf(j).length).toBe(251);
    const el = parseEligible(j)!;
    expect(el.size).toBe(250);
    expect(el.get("1003")).toBe(true);
    expect(el.get("1004")).toBe(false);
    expect(parseEligible({ tables: [{ fields: ["證券代號"], data: [["2330"]] }] })).toBeUndefined();
    const lists = { disposal: new Map([["1005", { period: "11/12～11/25" }]]), eligible: { TWSE: el } };
    expect(flagOf("1003", "TWSE", lists)).toEqual({ noSellFirst: true });
    expect(flagOf("9999", "TWSE", lists)).toEqual({ noDayTrade: true });
    expect(flagOf("1005", "TWSE", lists).disposal?.period).toBe("11/12～11/25");
    expect(flagOf("9999", "TPEX", lists)).toEqual({});
  });
});
