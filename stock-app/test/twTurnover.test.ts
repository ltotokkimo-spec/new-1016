import { describe, expect, it } from "vitest";
import { parseTurnover, parseTurnoverLive, twTurnoverUrl } from "../src/data/twTurnover";

// 證交所「每日市場成交資訊」FMTQIK 的格式（數字取自 2026 年 10 月官方資料）
const OCT = {
  stat: "OK", date: "20261022", title: "115年10月市場成交資訊",
  fields: ["日期", "成交股數", "成交金額", "成交筆數", "發行量加權股價指數", "漲跌點數"],
  data: [
    ["115/10/20", "11,317,471,077", "802,947,441,658", "5,155,199", "46,292.93", "-529.15"],
    ["115/10/21", "10,565,743,301", "874,614,166,736", "4,022,378", "46,887.77", "594.84"],
  ],
};

describe("大盤成交金額（證交所每日市場成交資訊）", () => {
  it("取最新交易日：民國日期轉西元、金額去掉逗號（單位：元）", () => {
    expect(parseTurnover(OCT)).toEqual({ date: "20261021", value: 874_614_166_736 });
  });
  it("資料列順序顛倒也取最新的日期", () => {
    expect(parseTurnover({ ...OCT, data: [...OCT.data].reverse() })?.date).toBe("20261021");
  });
  it("沒有資料、狀態不是 OK、欄位不對都回傳 undefined（月初還沒收盤時要改看上個月）", () => {
    expect(parseTurnover({ ...OCT, data: [] })).toBeUndefined();
    expect(parseTurnover({ stat: "很抱歉，沒有符合條件的資料!" })).toBeUndefined();
    expect(parseTurnover({ ...OCT, fields: ["a", "b"] })).toBeUndefined();
    expect(parseTurnover(null)).toBeUndefined();
  });
  it("請求網址帶日期（同月份任何一天都回整個月）", () => {
    expect(twTurnoverUrl("20261022")).toBe("https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=20261022&response=json");
  });
});

describe("盤中即時成交金額（每 5 秒委託成交統計）", () => {
  it("取最新一筆的累計成交金額（百萬元換成元）", () => {
    const j = { stat: "OK", date: "20261106", fields: ["時間", "累計委託買進筆數", "累計委託買進數量", "累計委託賣出筆數", "累計委託賣出數量", "累計成交筆數", "累計成交數量", "累計成交金額"],
      data: [["09:00:00", "1", "1", "1", "1", "0", "0", "0"], ["13:29:55", "1", "1", "1", "1", "3,612,341", "14,291,180", "883,396"], ["13:30:00", "1", "1", "1", "1", "3,699,032", "14,662,164", "926,024"]] };
    expect(parseTurnoverLive(j)).toEqual({ date: "20261106", time: "13:30:00", value: 926024e6 });
    expect(parseTurnoverLive({ stat: "很抱歉，沒有符合條件的資料!" })).toBeUndefined();
  });
});
