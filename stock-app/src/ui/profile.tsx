// 個股頁「公司」分頁（11/13 使用者）：做什麼、規模、經營者等基本資料
import { useEffect, useState } from "preact/hooks";
import { loadProfile, yahooProfileUrl } from "../data/companyProfile";
import type { CompanyProfile } from "../engine/companyProfile";

const yi = (v: number) => (v >= 1e12 ? `${(v / 1e12).toFixed(2)} 兆` : `${(v / 1e8).toLocaleString("zh-TW", { maximumFractionDigits: v >= 1e10 ? 0 : 1 })} 億`);

export function ProfilePanel({ code, market, price }: { code: string; market: "TWSE" | "TPEX"; price?: number }) {
  const [r, setR] = useState<{ p: CompanyProfile; errors: string[] } | null>(null);
  useEffect(() => { let alive = true; setR(null); loadProfile(code, market).then((x) => alive && setR(x)).catch((e) => alive && setR({ p: {}, errors: [String(e?.message ?? e)] })); return () => { alive = false; }; }, [code]);
  if (!r) return <div class="empty">公司資料載入中…</div>;
  const p = r.p;
  const shares = p.capital ? p.capital / 10 : undefined; // 面額 10 元
  const mcap = shares && price ? shares * price : undefined;
  const rows: [string, string | undefined, string?][] = [
    ["公司全名", p.fullName],
    ["市值（估）", mcap ? `${yi(mcap)}元` : undefined, "現價 × 實收資本額 ÷ 面額 10 元"],
    ["實收資本額", p.capital ? `${yi(p.capital)}元` : undefined],
    ["員工人數", p.employees],
    ["董事長", p.chairman],
    ["總經理", p.ceo],
    ["成立日期", p.founded],
    [market === "TPEX" ? "上櫃日期" : "上市日期", p.listed],
    ["電話", p.phone],
    ["地址", p.address],
  ];
  const has = rows.some(([, v]) => v) || p.business;
  return (
    <div data-testid="profile">
      {p.business ? (
        <div style={{ marginBottom: "10px" }}>
          <div class="muted" style={{ fontSize: "12.5px" }}>主要經營業務（做什麼）</div>
          <div style={{ fontSize: "15px", lineHeight: 1.6, marginTop: "2px" }} data-testid="profile-business">{p.business}</div>
          {p.revenueMix && <div style={{ fontSize: "13.5px", lineHeight: 1.6, marginTop: "6px" }} data-testid="profile-mix"><span class="muted">營收比重：</span>{p.revenueMix}</div>}
        </div>
      ) : <div class="muted" style={{ fontSize: "13px", marginBottom: "8px" }}>這次沒抓到主要經營業務，可以<a href={yahooProfileUrl(code, market)} target="_blank" rel="noreferrer">到 Yahoo 股市看</a>。</div>}
      {has && (
        <table class="sectors" data-testid="profile-table" style={{ width: "100%" }}>
          <tbody>
            {rows.filter(([, v]) => v).map(([k, v, note]) => <tr><td class="muted" style={{ whiteSpace: "nowrap", paddingRight: "10px", verticalAlign: "top" }}>{k}</td><td style={{ textAlign: "left" }}>{v}{note && <div class="muted" style={{ fontSize: "11px" }}>{note}</div>}</td></tr>)}
            {p.website && <tr><td class="muted">網站</td><td style={{ textAlign: "left", wordBreak: "break-all" }}><a href={/^https?:/.test(p.website) ? p.website : `https://${p.website}`} target="_blank" rel="noreferrer">{p.website}</a></td></tr>}
          </tbody>
        </table>
      )}
      <div class="muted" style={{ fontSize: "11.5px", marginTop: "8px", lineHeight: 1.6 }}>
        資料來源：{market === "TPEX" ? "櫃買中心" : "證交所"}公司基本資料、Yahoo 股市公司資料。{r.errors.length > 0 && <>這次沒抓到：{r.errors.join("、")}</>}
      </div>
    </div>
  );
}
