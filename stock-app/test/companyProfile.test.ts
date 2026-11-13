import { describe, expect, it } from "vitest";
import { fmtDate, profileFromRow, yahooProfile } from "../src/engine/companyProfile";

describe("公司分頁資料", () => {
  it("證交所（中文欄位）", () => {
    const p = profileFromRow({ 公司代號: "1234", 公司名稱: "測試科技股份有限公司", 公司簡稱: "測試", 董事長: "王小明", 總經理: "李大華", 成立日期: "0790101", 上市日期: "0900315", 實收資本額: "2,500,000,000", 網址: "www.example.com", 住址: "台北市測試路1號", 英文通訊地址: "No.1 Test Rd" });
    expect(p).toMatchObject({ fullName: "測試科技股份有限公司", chairman: "王小明", ceo: "李大華", founded: "1990/01/01", listed: "2001/03/15", capital: 2.5e9, website: "www.example.com", address: "台北市測試路1號" });
  });
  it("櫃買（英文欄位）", () => {
    const p = profileFromRow({ SecuritiesCompanyCode: "5678", CompanyName: "測試電子股份有限公司", Chairman: "陳一", GeneralManager: "林二", DateOfIncorporation: "19950601", DateOfListing: "20030102", "Paidin.Capital.NTDollars": "800000000" });
    expect(p).toMatchObject({ fullName: "測試電子股份有限公司", chairman: "陳一", founded: "1995/06/01", listed: "2003/01/02", capital: 8e8 });
  });
  it("Yahoo 公司資料頁：標題下一段是內容", () => {
    const html = `<div><span>董事長</span><span>王小明</span></div><div><span class="a">主要經營業務</span></div><div><p>專業積體電路製造服務</p></div><div><span>營收比重</span><span>晶圓 90%、其他 10%</span></div><script>var x="主要經營業務";</script>`;
    expect(yahooProfile(html)).toEqual({ business: "專業積體電路製造服務", revenueMix: "晶圓 90%、其他 10%" });
    expect(yahooProfile(`<x>{"mainBusiness":"鋼鐵製造與銷售"}</x>`).business).toBe("鋼鐵製造與銷售");
    expect(fmtDate("115/01/02")).toBe("2026/01/02");
  });
});
