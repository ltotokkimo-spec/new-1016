import { describe, expect, it } from "vitest";
import { parseIndexLive, indexLiveUrl } from "../src/data/twIndexLive";

// 2026/10/20 11:46 GitHub Actions 實測的 MIS 盤中回應（節錄）
const mk = (ex: string, ch: string, n: string, z: string, y: string, t = "11:46:00", extra: any = {}) => ({ ex, ch: ch + ".tw", n, z, y, t, d: "20261020", ...extra });
const intraday = { msgArray: [
  mk("tse", "t00", "發行量加權股價指數", "46664.95", "46822.08", "11:46:00", { m: "8555158", r: "2152364", h: "46967.91", l: "46379.17", o: "46712.57" }),
  mk("tse", "TW50", "臺灣50指數", "43034.73", "43199.80"),
  mk("tse", "t24", "半導體類指數", "1545.98", "1552.16"),
  mk("tse", "t17", "金融保險類指數", "3634.57", "3715.11"),
  mk("tse", "t99", "不要的指數", "100", "100"),
] };

describe("台股指數盤中即時（MIS）", () => {
  it("盤中：現值、漲跌、%、時間；只收我們要的指數", () => {
    const r = parseIndexLive(intraday);
    expect(Object.keys(r).sort()).toEqual(["加權指數", "半導體類指數", "臺灣50指數", "金融保險類指數"].sort());
    const w = r["加權指數"];
    expect(w.value).toBeCloseTo(46664.95);
    expect(w.change).toBeCloseTo(-157.13, 1);
    expect(w.changePct).toBeCloseTo(-0.34, 2);
    expect(w.final).toBe(false);
    expect(w.time).toBe("11:46:00");
    // 大盤量能（官方對準：m=張→股、r=筆數）
    expect(w.volShares).toBe(8555158 * 1000);
    expect(w.trades).toBe(2152364);
    expect(w.high).toBe(46967.91);
    expect(w.low).toBe(46379.17);
    // 其他指數不帶量能
    expect(r["半導體類指數"].volShares).toBeUndefined();
  });
  it("收盤後 final=true", () => {
    const r = parseIndexLive({ msgArray: [mk("tse", "t00", "發行量加權股價指數", "46700", "46822.08", "13:33:00")] });
    expect(r["加權指數"].final).toBe(true);
  });
  it("開盤前沒有現值（z=-）用昨收", () => {
    const r = parseIndexLive({ msgArray: [mk("tse", "t00", "發行量加權股價指數", "-", "46822.08", "09:00:00")] });
    expect(r["加權指數"].value).toBeCloseTo(46822.08);
    expect(r["加權指數"].change).toBe(0);
  });
  it("url 含四大指數代號", () => {
    const u = indexLiveUrl();
    for (const c of ["tse_t00.tw", "tse_TW50.tw", "tse_t24.tw", "tse_t17.tw"]) expect(u).toContain(c);
  });
});
