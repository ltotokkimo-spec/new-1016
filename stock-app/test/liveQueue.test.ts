import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _inject, _setState, getState, refreshLive } from "../src/store";
import { memoryKV } from "../src/lib/kv";

const mis = (codes: string[], price = 100) => ({ msgArray: codes.map((c) => ({ c, n: c, d: "20261102", t: "10:01:59", z: String(price), y: "99.0000", o: "99.5", h: "101", l: "99", v: "10" })) });
const codesOf = (url: string) => [...new Set([...url.matchAll(/(?:tse|otc)_(\w+)\.tw/g)].map((m) => m[1]))];
const tick = () => new Promise((r) => setTimeout(r, 20));

// 預設：台股資料已下載完（第一次下載中的情況另外測）
beforeEach(() => { _setState({ tw: { ...getState().tw, status: "ready", scored: [{ code: "2330" } as any] } }); });
afterEach(() => { vi.useRealTimers(); });

describe("第一次下載台股資料時", () => {
  it("先不抓即時價（避免證交所封鎖卡在三大法人），下載完再一次補抓", async () => {
    const urls: string[] = [];
    _inject(memoryKV(), async (url: string) => { urls.push(url); return mis(codesOf(url)); });
    _setState({ tw: { ...getState().tw, status: "loading", scored: [] } });
    await refreshLive(["1101", "1102"]);
    await refreshLive(["2409"], [], true);
    await new Promise((r) => setTimeout(r, 2200));
    expect(urls).toHaveLength(0);
    _setState({ tw: { ...getState().tw, status: "ready", scored: [{ code: "1101" } as any] } });
    await new Promise((r) => setTimeout(r, 2200)); await tick();
    expect(urls).toHaveLength(1);
    expect(codesOf(urls[0])[0]).toBe("2409"); // 持股排前面
    expect(codesOf(urls[0]).sort()).toEqual(["1101", "1102", "2409"]);
    expect(getState().live["1102"]?.price).toBe(100);
  });
});

describe("即時價更新排隊", () => {
  it("上一次還沒抓完時，新的要求排隊、前一個一結束就補抓（以前會被直接丟掉）", async () => {
    const urls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    _inject(memoryKV(), async (url: string) => { urls.push(url); if (urls.length === 1) await gate; return mis(codesOf(url)); });
    const first = refreshLive(["1101", "1102"]);
    await refreshLive(["2409", "6182"]); // 第一個還在抓：排隊
    await refreshLive(["2409", "00406A"]); // 又一個：合併進同一次補抓
    expect(urls).toHaveLength(1);
    release();
    await first; await tick();
    expect(urls).toHaveLength(2); // 補抓只多一次請求，不是兩次
    expect(codesOf(urls[1]).sort()).toEqual(["00406A", "2409", "6182"]);
    for (const c of ["1101", "1102", "2409", "6182", "00406A"]) expect(getState().live[c]?.price, c).toBe(100);
  });

  it("持股（priority）優先：前一個還有幾批沒抓時，先停下來抓持股，剩下的稍後再抓", async () => {
    const urls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    _inject(memoryKV(), async (url: string) => { urls.push(url); if (urls.length === 1) await gate; return mis(codesOf(url)); });
    const list = Array.from({ length: 45 }, (_, i) => String(3000 + i)); // 選股頁 45 檔 → 3 批（20、20、5）
    const first = refreshLive(list);
    await refreshLive(["2409", "6182"], [], true); // 開 App 切到持股頁
    release();
    await first; await tick(); await tick();
    const order = urls.map((u) => codesOf(u));
    expect(order[0]).toHaveLength(20); // 第一批照常
    expect(order[1]).toEqual(expect.arrayContaining(["2409", "6182"])); // 第二個請求的第一批就有持股（排在選股剩下的前面），不是等選股抓完
    expect(order[1][0]).toBe("2409");
    expect(new Set(order.slice(1).flat()).size).toBe(27); // 持股 2 檔＋選股剩下的 25 檔，之後都補抓，一檔都沒漏
    expect(getState().live["2409"]?.price).toBe(100);
    expect(getState().live["3044"]?.price).toBe(100);
  });

  it("沒有排隊時照常一次抓完", async () => {
    const urls: string[] = [];
    _inject(memoryKV(), async (url: string) => { urls.push(url); return mis(codesOf(url)); });
    await refreshLive(["3008"]);
    expect(urls).toHaveLength(1);
    expect(getState().live["3008"]?.price).toBe(100);
  });
});

describe("即時價抓不到時", () => {
  it("請求卡住（證交所沒回應）15 秒就放棄並記下原因，不會卡住後面的更新；幾秒後自動重試", async () => {
    vi.useFakeTimers();
    let calls = 0;
    _inject(memoryKV(), (url: string) => { calls++; return calls === 1 ? new Promise(() => {}) : Promise.resolve(mis(codesOf(url), 88)); });
    const p = refreshLive(["2330"]);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(getState().liveError).toBeUndefined(); // 還沒到 15 秒
    await vi.advanceTimersByTimeAsync(1_500);
    await p;
    expect(getState().liveError).toBe("連線逾時");
    expect(getState().live["2330"]?.price).not.toBe(88);
    await vi.advanceTimersByTimeAsync(4_500); // 自動重試
    expect(calls).toBe(2);
    expect(getState().live["2330"]?.price).toBe(88);
    expect(getState().liveError).toBeUndefined(); // 成功就清掉錯誤
  });

  it("重試最多 2 次，之後交給下一個 30 秒的輪詢（不會無限重試）", async () => {
    vi.useFakeTimers();
    let calls = 0;
    _inject(memoryKV(), () => { calls++; return Promise.reject(new Error("斷線")); });
    await refreshLive(["2330"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toBe(3); // 第一次＋重試 2 次
    expect(getState().liveError).toBe("斷線");
  });

  it("多批裡有一批失敗：前面已抓到的照樣存起來", async () => {
    vi.useFakeTimers();
    let calls = 0;
    _inject(memoryKV(), (url: string) => { calls++; return calls === 2 ? Promise.reject(new Error("斷線")) : Promise.resolve(mis(codesOf(url), 77)); });
    const list = Array.from({ length: 30 }, (_, i) => String(4000 + i)); // 兩批
    await refreshLive(list);
    expect(getState().live["4000"]?.price).toBe(77); // 第一批
    expect(getState().live["4025"]?.price).not.toBe(77); // 第二批失敗
    expect(getState().liveError).toBe("斷線");
  });
});
