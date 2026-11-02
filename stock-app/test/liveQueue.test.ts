import { describe, expect, it } from "vitest";
import { _inject, getState, refreshLive } from "../src/store";
import { memoryKV } from "../src/lib/kv";

const mis = (codes: string[]) => ({ msgArray: codes.map((c) => ({ c, n: c, d: "20261102", t: "10:01:59", z: "100.0000", y: "99.0000", o: "99.5", h: "101", l: "99", v: "10" })) });
const codesOf = (url: string) => [...new Set([...url.matchAll(/(?:tse|otc)_(\w+)\.tw/g)].map((m) => m[1]))];

describe("即時價更新排隊", () => {
  it("上一次還沒抓完時，新的要求排隊、前一個一結束就補抓（以前會被直接丟掉）", async () => {
    const urls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    _inject(memoryKV(), async (url: string) => {
      urls.push(url);
      if (urls.length === 1) await gate; // 第一個請求卡住（像開 App 時選股頁正在抓 60 檔）
      return mis(codesOf(url));
    });
    const first = refreshLive(["1101", "1102"]);
    await refreshLive(["2409", "6182"]); // 第一個還在抓：排隊
    await refreshLive(["2409", "00406A"]); // 又一個：合併進同一次補抓
    expect(urls).toHaveLength(1);
    release();
    await first;
    await new Promise((r) => setTimeout(r, 20));
    expect(urls).toHaveLength(2); // 補抓只多一次請求，不是兩次
    expect(codesOf(urls[1]).sort()).toEqual(["00406A", "2409", "6182"]);
    const live = getState().live;
    for (const c of ["1101", "1102", "2409", "6182", "00406A"]) expect(live[c]?.price, c).toBe(100);
  });

  it("沒有排隊時照常一次抓完", async () => {
    const urls: string[] = [];
    _inject(memoryKV(), async (url: string) => { urls.push(url); return mis(codesOf(url)); });
    await refreshLive(["3008"]);
    expect(urls).toHaveLength(1);
    expect(getState().live["3008"]?.price).toBe(100);
  });
});
