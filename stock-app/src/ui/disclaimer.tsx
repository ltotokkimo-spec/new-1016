// 免責聲明（11/10 使用者要求，因為要分享給別人使用）：第一次打開 App 要按「我了解」才能使用；設定頁也看得到全文。
// 改了內容就把 DISCLAIMER_VERSION 換成新日期，所有人會再看一次。
import { useEffect, useState } from "preact/hooks";
import { useStore } from "../store";
import * as upd from "../lib/update";

export const DISCLAIMER_VERSION = "2026-11-10";
const KEY = "disclaimerAck";

export const DISCLAIMER_POINTS: { title: string; text: string }[] = [
  { title: "不是投資建議", text: "這是作者個人自用的研究工具，不是證券投資顧問。所有評分、評等（買入、觀望、離場）、停損換股與攤平建議，都只是依固定規則整理的資料，不保證獲利，也不構成買賣的邀約或建議。" },
  { title: "過去不代表未來", text: "回測與歷史績效不代表未來。評分的預測力有限（回測顯示總分與之後報酬幾乎沒有關係），觀察組合的清單與規則有事後挑選的成分，會偏樂觀。" },
  { title: "資料可能延遲或有誤", text: "行情與籌碼來自證交所、櫃買中心、MoneyDJ、Yahoo、Nasdaq、CNBC 等第三方，可能延遲、缺漏或錯誤；AI 解析也可能出錯。下單前請以券商與官方公告為準。" },
  { title: "盈虧自負", text: "投資有風險。買賣決定與損益由使用者自行負責，作者不對任何損失負責。" },
  { title: "你的資料在你的手機", text: "持股、成本與 Claude API 金鑰只存在這支手機，App 沒有自己的伺服器，不會上傳給作者。使用 AI 功能時，相關內容會送到 Anthropic，費用算在你自己的金鑰上。請不要把金鑰給任何人。" },
  { title: "授權", text: "僅供個人、非商業使用。不得販售、收費或以此為基礎對外提供服務，轉傳或改作前需取得作者同意；原始碼公開不等於授權（詳見專案根目錄的 LICENSE 檔）。" },
];

function acked(): boolean {
  try { return localStorage.getItem(KEY) === DISCLAIMER_VERSION; } catch { return false; }
}

/** 免責聲明全文（第一次打開與設定頁共用） */
export function DisclaimerText() {
  return (
    <ol style={{ margin: 0, paddingLeft: "20px", display: "grid", gap: "10px", fontSize: "14px", lineHeight: 1.7 }} data-testid="disclaimer-text">
      {DISCLAIMER_POINTS.map((p) => <li><b>{p.title}</b>：{p.text}</li>)}
    </ol>
  );
}

/** 第一次打開（或聲明更新後）蓋在畫面最上面；資料照常在背後下載，按「我了解」才能操作 */
export function DisclaimerGate() {
  const [ok, setOk] = useState(acked());
  if (ok) return null;
  const accept = () => { try { localStorage.setItem(KEY, DISCLAIMER_VERSION); } catch { /* 存不起來就每次都問，不影響使用 */ } setOk(true); };
  return (
    <div class="gate" role="dialog" aria-modal="true" aria-label="使用前請先閱讀" data-testid="disclaimer">
      <div class="gate-card">
        <div class="gate-body">
          <h2 style={{ margin: "0 0 4px" }}>使用前請先閱讀</h2>
          <div class="muted" style={{ fontSize: "13px", marginBottom: "10px" }}>金雷達是個人研究工具，請了解以下內容再使用。</div>
          <DisclaimerText />
        </div>
        <button class="btn block" style={{ marginTop: "12px", flex: "none" }} onClick={accept} data-testid="disclaimer-ok">我了解，開始使用</button>
      </div>
    </div>
  );
}

/** 遠端停用（11/11）：版本號低於雲端 version.json 的 minVersionCode 時，整個 App 只顯示這個畫面（離線重開也一樣） */
export function BlockedGate() {
  const info = useStore((s) => s.update.info);
  const [cur, setCur] = useState<number | undefined>(undefined);
  useEffect(() => { upd.currentVersion().then((v) => setCur(v?.versionCode)).catch(() => {}); }, []);
  if (!(info?.blocked || upd.isBlocked(info?.current?.versionCode ?? cur))) return null;
  return (
    <div class="gate" role="dialog" aria-modal="true" aria-label="此版本已停用" data-testid="blocked" style={{ zIndex: 101 }}>
      <div class="gate-card" style={{ justifyContent: "center" }}>
        <h2 style={{ margin: "0 0 8px" }}>此版本已停用</h2>
        <div class="muted" style={{ fontSize: "14px", lineHeight: 1.7 }}>這個版本的金雷達已由作者停止提供，無法再使用。如需使用，請向作者索取新版。</div>
      </div>
    </div>
  );
}
