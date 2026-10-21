import { describe, expect, it } from "vitest";
import { cashFlow, comparePlans, reconcilePhoto, emptyEtf, etfAlerts, fitBudget, looksLikePlanReply, parsePlan, tradePnls, positions, recordNav, stopOf, valuate, FEE, TAX } from "../src/engine/aiEtf";

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

describe("停損與離場提醒", () => {
  const etf = { ...emptyEtf(100000), trades: [t("2330", "buy", 10, 1000), t("2317", "buy", 100, 200), t("2454", "buy", 10, 1200)], stops: { "2330": 950 } };
  it("沒設定停損價就用成本 −10%", () => {
    const p = positions(etf.trades).find((x) => x.code === "2317")!;
    const s = stopOf(p, etf.stops);
    expect(s.isDefault).toBe(true);
    expect(s.stop).toBeCloseTo(200 * (1 + FEE) * 0.9, 2);
    expect(stopOf(positions(etf.trades)[0], etf.stops)).toEqual({ stop: 950, isDefault: false });
  });
  it("跌破停損與離場評等都會提醒，沒事的不提醒", () => {
    const px: Record<string, number> = { "2330": 940, "2317": 195, "2454": 1300 };
    const a = etfAlerts(etf, (c) => px[c], (c) => (c === "2454" ? "離場" : "買入"));
    expect(a.map((x) => `${x.code}:${x.kind}`)).toEqual(["2330:stop", "2454:exit"]);
    expect(a[0]).toMatchObject({ price: 940, stop: 950, isDefault: false });
  });
  it("剛好等於停損價也提醒；賣光的不提醒", () => {
    const sold = { ...etf, trades: [...etf.trades, t("2330", "sell", 10, 900, 100, "20261018")] };
    expect(etfAlerts(etf, (c) => (c === "2330" ? 950 : 9999), () => undefined).map((x) => x.code)).toEqual(["2330"]);
    expect(etfAlerts(sold, () => 1, () => undefined).map((x) => x.code)).toEqual(["2317", "2454"]);
  });
  it("parsePlan 讀出每筆買進的 stop 與 stops", () => {
    const r = parsePlan('說明\n```json\n{"trades":[{"code":"2330","side":"buy","shares":10,"stop":900,"reason":"x"}],"stops":{"2454":1100,"x":0}}\n```');
    expect(r.items[0].stop).toBe(900);
    expect(r.stops).toEqual({ "2454": 1100, "2330": 900 });
  });
});

describe("reconcilePhoto 拍照對帳", () => {
  const etf = { ...emptyEtf(100000), trades: [t("2330", "buy", 10, 1000)] };
  const px = (c: string) => ({ "2330": 1050, "2317": 200, "2882": 60 } as Record<string, number>)[c];
  it("新買的用截圖成本、加碼的反推這次成交價、減少的記賣出", () => {
    const rows = reconcilePhoto(etf, [
      { code: "2330", name: "台積電", shares: 20, cost: (1000 * (1 + FEE) * 10 + 1040 * 10) / 20 },
      { code: "2317", name: "鴻海", shares: 100, cost: 198.5 },
      { code: "2882", name: "國泰金", shares: 1000, cost: 0 },
    ], px, new Set(["2317"]));
    expect(rows).toEqual([
      { code: "2330", name: "台積電", side: "buy", shares: 10, price: 1040, suggested: true },
      { code: "2317", name: "鴻海", side: "buy", shares: 100, price: 198.5, suggested: true },
      { code: "2882", name: "國泰金", side: "buy", shares: 1000, price: 60, suggested: false },
    ]);
  });
  it("股數變少記賣出，股數相同不列", () => {
    expect(reconcilePhoto(etf, [{ code: "2330", name: "台積電", shares: 4, cost: 1000 }], px, new Set()))
      .toEqual([{ code: "2330", name: "台積電", side: "sell", shares: 6, price: 1050, suggested: true }]);
    expect(reconcilePhoto(etf, [{ code: "2330", name: "台積電", shares: 10, cost: 1000 }], px, new Set())).toEqual([]);
  });
});

describe("comparePlans 付費版 vs Pro 版", () => {
  it("同方向、股數差 10% 內算一致；只有一邊有的算不同", () => {
    const b = (code: string, shares: number, side: "buy" | "sell" = "buy") => ({ code, side, shares, reason: "" });
    const r = comparePlans([b("2330", 20), b("2317", 100), b("6515", 10)], [b("2330", 21), b("2317", 100, "sell"), b("2882", 300)]);
    expect(r.map((x) => `${x.code}:${x.same}`)).toEqual(["2330:true", "2317:false", "6515:false", "2882:false"]);
    expect(r[2].pro).toBeUndefined();
    expect(r[3].api).toBeUndefined();
  });
});

describe("parsePlan 沒有 ``` 框的 JSON（從 Claude App 複製會掉框）", () => {
  const text = `結論：分批買進。\n\n{"trades":[\n{"code":"2027","side":"buy","shares":440,"stop":46.8,"reason":"9月營收年增41%，限價49.5"},\n{"code":"2609","side":"buy","shares":280,"stop":59.8,"reason":"運價高檔 {不追過64.7}"}\n]}\n\nSources: 公股4金2銀（優分析，2026/10/14）`;
  it("讀出清單與停損，JSON 從說明文字拿掉，後面的來源保留", () => {
    const { items, body, stops } = parsePlan(text);
    expect(items.map((x) => [x.code, x.shares])).toEqual([["2027", 440], ["2609", 280]]);
    expect(stops).toEqual({ "2027": 46.8, "2609": 59.8 });
    expect(items[1].reason).toContain("{不追過64.7}");
    expect(body).toContain("結論：分批買進。");
    expect(body).toContain("Sources: 公股4金2銀");
    expect(body).not.toContain('"trades"');
  });
  it("陣列格式、維持不變只給停損也能讀", () => {
    expect(parsePlan('好\n[{"code":"2330","side":"buy","shares":5,"reason":"x"}]').items).toHaveLength(1);
    expect(parsePlan('維持不變\n{"trades":[],"stops":{"2002":18.4}}').stops).toEqual({ "2002": 18.4 });
  });
  it("文字裡有大括號但不是清單，不會誤判", () => {
    expect(parsePlan("內文 {不是 json} 與 [1, 2, 3]").items).toEqual([]);
    expect(parsePlan('{"trades":[{"code":"2330"').items).toEqual([]);
  });
  it("有 ``` 框時照舊優先用框裡的", () => {
    expect(parsePlan('{"trades":[{"code":"1111","side":"buy","shares":1}]}\n```json\n[{"code":"2222","side":"buy","shares":2,"reason":"y"}]\n```').items[0].code).toBe("2222");
  });
});

describe("looksLikePlanReply 剪貼簿裡是不是 Claude 的回覆", () => {
  it("有買賣清單（有框或沒框）就算", () => {
    const body = "結論：分批買進，原因整理如下，".repeat(5);
    expect(looksLikePlanReply(`${body}\n{"trades":[{"code":"2330","side":"buy","shares":5,"reason":"x"}]}`)).toEqual({ ok: true, items: 1 });
    expect(looksLikePlanReply(`${body}\n\`\`\`json\n[{"code":"2330","side":"buy","shares":5}]\n\`\`\``).ok).toBe(true);
  });
  it("明說維持不變也算；太短、沒內容的不算", () => {
    expect(looksLikePlanReply("目前組合配置合理，這次建議維持不變，理由：".repeat(10)).ok).toBe(true);
    expect(looksLikePlanReply("維持不變").ok).toBe(false);
    expect(looksLikePlanReply("隨便一段很長的文字".repeat(30)).ok).toBe(false);
  });
  it("App 自己送出去的提問不算", () => {
    expect(looksLikePlanReply("今天是 2026/10/21。我要用新台幣 500,000 元做一個「自組 ETF」，會照你的建議真的下單。".padEnd(300, "字") + '{"trades":[{"code":"2330","side":"buy","shares":5}]}').ok).toBe(false);
  });
});

describe("tradePnls 成交紀錄每一列的損益", () => {
  const t = (id: string, date: string, code: string, side: "buy" | "sell", shares: number, price: number) => ({ id, date, code, name: code, side, shares, price, benchPrice: 100 });
  it("賣出＝這筆已實現（扣手續費與證交稅、減當時均價）；賣光後買進那列不顯示", () => {
    const trades = [t("b", "20261021", "2393", "buy", 150, 67.9), t("s", "20261021", "2393", "sell", 150, 85)];
    const r = tradePnls(trades, () => 70);
    const expected = 150 * 85 * (1 - FEE - TAX) - 150 * 67.9 * (1 + FEE);
    expect(r.s).toBeCloseTo(expected, 6);
    expect(r.s!).toBeGreaterThan(2000);
    expect(r.b).toBeUndefined();
  });
  it("部分賣出用當時的平均成本；還有持股的買進那列用現價算", () => {
    const trades = [t("b1", "20261019", "2027", "buy", 100, 50), t("b2", "20261020", "2027", "buy", 100, 60), t("s", "20261021", "2027", "sell", 50, 58)];
    const r = tradePnls(trades, () => 62);
    const avg = (100 * 50 * (1 + FEE) + 100 * 60 * (1 + FEE)) / 200;
    expect(r.s).toBeCloseTo(50 * 58 * (1 - FEE - TAX) - 50 * avg, 6);
    expect(r.b2).toBeCloseTo((62 - 60 * (1 + FEE)) * 100, 6);
    expect(tradePnls(trades, () => undefined).b1).toBeUndefined();
  });
});

