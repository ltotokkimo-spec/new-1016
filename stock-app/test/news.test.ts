import { describe, expect, it } from "vitest";
import { agoText, organizeNews, parseCnyes, parseGoogleRss, parseMops, similar, topNews, type NewsItem } from "../src/engine/news";

const NOW = Date.parse("2026-11-12T14:00:00+08:00");
const it0 = (title: string, minsAgo: number, source = "鉅亨網", feed: NewsItem["feed"] = "cnyes"): NewsItem => ({ id: `${feed}:${title}`, title, source, url: "https://example.com", at: NOW - minsAgo * 60_000, feed });

describe("新聞來源解析", () => {
  it("鉅亨網 JSON：標題、摘要、時間（秒→毫秒）、連結", () => {
    const r = parseCnyes({ items: { data: [{ newsId: 123, title: "台股<b>大漲</b>", summary: "摘要&amp;說明", publishAt: 1794463200 }] } });
    expect(r).toEqual([{ id: "cnyes:123", title: "台股大漲", summary: "摘要&說明", source: "鉅亨網", url: "https://news.cnyes.com/news/id/123", at: 1794463200000, feed: "cnyes" }]);
  });
  it("Google 新聞 RSS：拿掉標題後面的「 - 媒體」", () => {
    const xml = `<rss><channel><item><title>聯準會宣布降息一碼 - 經濟日報</title><link>https://news.google.com/x</link><pubDate>Thu, 12 Nov 2026 05:30:00 GMT</pubDate><source url="https://money.udn.com">經濟日報</source></item></channel></rss>`;
    expect(parseGoogleRss(xml)).toEqual([{ id: "g:https://news.google.com/x", title: "聯準會宣布降息一碼", source: "經濟日報", url: "https://news.google.com/x", at: Date.parse("2026-11-12T05:30:00Z"), feed: "google" }]);
  });
  it("重大訊息：民國日期時間換成台北時間", () => {
    const r = parseMops([{ 出表日期: "1151112", 發言日期: "1151112", 發言時間: "133005", 公司代號: "1234", 公司名稱: "測試公司", 主旨: "公告本公司董事會決議配息", 說明: "1.董事會日期：115/11/12" }], "上市");
    expect(r[0].title).toBe("測試公司（1234）公告本公司董事會決議配息");
    expect(r[0].at).toBe(Date.parse("2026-11-12T13:30:05+08:00"));
  });
});

describe("新聞整理", () => {
  it("同一件事（不同媒體）併成一則，列出其他媒體", () => {
    expect(similar("聯準會宣布降息一碼 鮑爾暗示還會再降", "聯準會降息一碼！鮑爾暗示還會再降")).toBeGreaterThan(0.6);
    const v = organizeNews([it0("聯準會宣布降息一碼 鮑爾暗示還會再降", 10), it0("聯準會降息一碼！鮑爾暗示還會再降", 20, "經濟日報", "google")], { now: NOW });
    expect(v).toHaveLength(1);
    expect(v[0].also).toEqual(["經濟日報"]);
  });
  it("分類：國際／台股大盤／個股；提到持股會標出來並加分", () => {
    const v = organizeNews([it0("美股四大指數齊跌 那斯達克重挫2%", 30), it0("外資賣超台股300億 加權指數大跌", 40), it0("測試電子接獲大單 營收創新高", 50), it0("今天天氣晴", 50)],
      { now: NOW, stocks: [{ code: "9999", name: "測試電子" }], mine: ["9999"] });
    const by = Object.fromEntries(v.map((x) => [x.title, x]));
    expect(by["美股四大指數齊跌 那斯達克重挫2%"].cat).toBe("國際");
    expect(by["外資賣超台股300億 加權指數大跌"].cat).toBe("台股大盤");
    expect(by["測試電子接獲大單 營收創新高"].cat).toBe("個股");
    expect(by["測試電子接獲大單 營收創新高"].mine).toBe(true);
    expect(by["外資賣超台股300億 加權指數大跌"].score).toBeGreaterThan(by["今天天氣晴"].score);
  });
  it("超過 36 小時的不要；最重要的同一類最多 3 則", () => {
    const v = organizeNews([it0("舊聞 台股大跌", 37 * 60), ...[1, 2, 3, 4].map((i) => it0(`外資賣超台股第${i}波 加權指數重挫${i}00點`, i)), it0("聯準會意外升息", 5)], { now: NOW });
    expect(v.some((x) => x.title.startsWith("舊聞"))).toBe(false);
    const t = topNews(v, 6);
    expect(t.filter((x) => x.cat === "台股大盤").length).toBeLessThanOrEqual(3);
    expect(t.some((x) => x.title === "聯準會意外升息")).toBe(true);
  });
  it("幾分鐘前", () => {
    expect(agoText(NOW - 30_000, NOW)).toBe("剛剛");
    expect(agoText(NOW - 25 * 60_000, NOW)).toBe("25 分鐘前");
    expect(agoText(NOW - 3 * 3600_000, NOW)).toBe("3 小時前");
  });
});
