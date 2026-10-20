import { describe, expect, it } from "vitest";
import { parseUsLive } from "../src/data/usLive";
import { usNeedsRefresh, usQuoteHours, usSessionDay } from "../src/lib/dates";

// 2026/10/19 GitHub Actions 實測的 CNBC 回應（節錄）
const post = { FormattedQuoteResult: { FormattedQuote: [
  { symbol: "AAPL", code: 0, name: "Apple Inc.", last: "342.94", last_time: "2026-10-19T16:00:00.000-0400", open: "340.78", high: "346.00", low: "340.12", change: "-0.52", change_pct: "-0.15%", previous_day_closing: "343.46", realTime: "true", curmktstatus: "POST_MKT",
    ExtendedMktQuote: { type: "POST_MKT", last: "343.04", last_time: "2026-10-19T19:59:27.949-0400", change: "+0.10", change_pct: "+0.03%" } },
  { symbol: "NOSUCHX", code: 1 },
] } };

describe("美股即時報價（CNBC）", () => {
  it("收盤後：收盤價、昨收、盤後成交，時間換成台北時間", () => {
    const q = parseUsLive(post).AAPL;
    expect(q.price).toBe(342.94);
    expect(q.prevClose).toBe(343.46);
    expect(q.final).toBe(true);
    expect(q.date).toBe("20261019");
    expect(q.time).toBe("04:00"); // 紐約 16:00 EDT = 台北 04:00
    expect(q.ext).toEqual({ label: "盤後", price: 343.04, chg: 0.0003, time: "07:59" });
    expect(parseUsLive(post).NOSUCHX).toBeUndefined();
  });

  it("盤中：不是收盤價、不顯示昨天的盤後價", () => {
    const f = structuredClone(post);
    Object.assign(f.FormattedQuoteResult.FormattedQuote[0], { curmktstatus: "REG_MKT", last: "345.10", last_time: "2026-10-20T10:31:05.000-0400" });
    const q = parseUsLive(f).AAPL;
    expect(q.final).toBe(false);
    expect(q.time).toBe("22:31");
    expect(q.ext).toBeUndefined();
  });

  it("單一筆回應不是陣列也能解析", () => {
    expect(parseUsLive({ FormattedQuoteResult: { FormattedQuote: post.FormattedQuoteResult.FormattedQuote[0] } }).AAPL.price).toBe(342.94);
  });
});

describe("美股資料日與重抓", () => {
  const at = (iso: string) => Date.parse(iso);
  it("紐約 17:00 以後才算當天", () => {
    expect(usSessionDay(at("2026-10-19T20:59:00Z"))).toBe("20261018"); // 紐約 16:59
    expect(usSessionDay(at("2026-10-19T21:01:00Z"))).toBe("20261019"); // 紐約 17:01
  });
  it("台北凌晨抓過，清晨收盤後再打開要重抓（使用者回報美股收盤沒更新）", () => {
    const fetched = at("2026-10-19T16:30:00Z"); // 台北 10/20 00:30，美股盤中
    expect(usNeedsRefresh(fetched, at("2026-10-19T18:00:00Z"))).toBe(false); // 台北 02:00 還沒收盤
    expect(usNeedsRefresh(fetched, at("2026-10-19T23:00:00Z"))).toBe(true); // 台北 07:00 收盤後
  });
  it("冬令時間也正確（紐約 UTC−5）", () => {
    expect(usSessionDay(at("2026-12-01T21:59:00Z"))).toBe("20261130"); // 紐約 16:59 EST
    expect(usSessionDay(at("2026-12-01T22:01:00Z"))).toBe("20261201");
  });
  it("盤前盤後時段", () => {
    expect(usQuoteHours(at("2026-10-19T14:00:00Z"))).toBe(true); // 紐約週一 10:00
    expect(usQuoteHours(at("2026-10-18T14:00:00Z"))).toBe(false); // 週日
    expect(usQuoteHours(at("2026-10-20T01:00:00Z"))).toBe(false); // 紐約 21:00
  });
});
