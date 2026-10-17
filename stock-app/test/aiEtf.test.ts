import { describe, expect, it } from "vitest";
import { cashFlow, emptyEtf, fitBudget, parsePlan, positions, recordNav, valuate, FEE, TAX } from "../src/engine/aiEtf";

const t = (code: string, side: "buy" | "sell", shares: number, price: number, benchPrice = 100, date = "20261017") =>
  ({ id: code + side + date, date, code, name: code, side, shares, price, benchPrice });

describe("自組 ETF 計算", () => {
  it("買賣現金流含手續費與證交稅", () => {
    expect(cashFlow({ side: "buy", shares: 1000, price: 50 })).toBeCloseTo(-50000 * (1 + FEE));
    expect(cashFlow({ side: "sell", shares: 1000, price: 50 })).toBeCloseTo(50000 * (1 - FEE - TAX));
  });

  it("平均成本與已實現損益", () => {
    const ps = positions([t("2330", "buy", 10, 1000), t("2330", "buy", 10, 1200, 100, "20261018"), t("2330", "sell", 5, 1300, 100, "20261019")]);
    const p = ps[0];
    expect(p.shares).toBe(15);
    expect(p.avgCost).toBeCloseTo(1100 * (1 + FEE));
    expect(p.realized).toBeCloseTo(5 * 1300 * (1 - FEE - TAX) - 5 * 1100 * (1 + FEE));
  });

  it("淨值、報酬率與 0050 對照", () => {
    const etf = { ...emptyEtf(100_000), trades: [t("2330", "buy", 40, 1000, 100), t("2454", "buy", 20, 1500, 100)] };
    // 股票都漲 10%，0050 漲 5%
    const v = valuate(etf, (c) => ({ "2330": 1100, "2454": 1650, "0050": 105 } as any)[c]);
    const spent = 40 * 1000 * (1 + FEE) + 20 * 1500 * (1 + FEE);
    expect(v.cash).toBeCloseTo(100_000 - spent);
    expect(v.marketValue).toBeCloseTo(40 * 1100 + 20 * 1650);
    expect(v.ret).toBeCloseTo((v.cash + v.marketValue) / 100_000 - 1);
    // 對照組：花同樣的 70,000 買 0050（700 單位），漲 5%
    expect(v.bench).toBeCloseTo(100_000 - spent + 700 * 105);
    expect(v.ret).toBeGreaterThan(v.benchRet);
    expect(v.missing).toEqual([]);
  });

  it("沒有現價的股票用成本計算並標示", () => {
    const etf = { ...emptyEtf(), trades: [t("9999", "buy", 10, 100)] };
    const v = valuate(etf, () => undefined);
    expect(v.missing).toEqual(["9999", "0050"]);
    expect(v.marketValue).toBeCloseTo(10 * 100 * (1 + FEE));
  });

  it("每天記一筆淨值，同一天覆蓋", () => {
    let etf = { ...emptyEtf(), trades: [t("2330", "buy", 10, 1000)] };
    const v = valuate(etf, () => 1000);
    etf = recordNav(etf, "20261017", v);
    etf = recordNav(etf, "20261017", { ...v, nav: 99000 });
    etf = recordNav(etf, "20261020", v);
    expect(etf.nav.map((x) => x.date)).toEqual(["20261017", "20261020"]);
    expect(etf.nav[0].nav).toBe(99000);
  });
});

describe("Claude 建議清單", () => {
  const reply = "## 組合說明\n- 理由\n\n```json\n{\"trades\":[{\"code\":\"2330\",\"side\":\"buy\",\"shares\":30,\"reason\":\"龍頭\"},{\"code\":\"6515\",\"shares\":\"5\",\"reason\":\"探針卡\"},{\"code\":\"x\",\"shares\":0}]}\n```\n以上為研究參考，非投資建議。";
  it("取出 JSON 清單並移除 JSON 區塊", () => {
    const { items, body } = parsePlan(reply);
    expect(items).toEqual([
      { code: "2330", side: "buy", shares: 30, reason: "龍頭" },
      { code: "6515", side: "buy", shares: 5, reason: "探針卡" },
    ]);
    expect(body).not.toMatch(/```/);
    expect(body).toMatch(/非投資建議/);
  });
  it("壞掉或沒有 JSON 時只回傳文字", () => {
    expect(parsePlan("沒有清單").items).toEqual([]);
    expect(parsePlan("```json\n{壞掉\n```").items).toEqual([]);
  });
  it("超過預算時等比例縮小股數", () => {
    const items = [{ code: "A", side: "buy" as const, shares: 100, reason: "" }, { code: "B", side: "buy" as const, shares: 100, reason: "" }];
    const fit = fitBudget(items, () => 1000, 100_000); // 需要 20 萬，只有 10 萬
    expect(fit.map((x) => x.shares)).toEqual([49, 49]);
    expect(fitBudget(items, () => 100, 100_000)).toEqual(items);
  });
});

describe("valuate 缺 0050 價格", () => {
  it("用最後一次成交時的 0050 價格估算，不會變成賠光", () => {
    const etf = { ...emptyEtf(100000), trades: [{ id: "a", date: "20261016", code: "2330", name: "台積電", side: "buy" as const, shares: 50, price: 1000, benchPrice: 200 }] };
    const v = valuate(etf, () => undefined);
    expect(v.benchRet).toBeCloseTo(-(50 * 1000 * 0.001425) / 100000, 6); // 只差買進手續費
    expect(v.missing).toEqual(["2330", "0050"]);
  });
});
