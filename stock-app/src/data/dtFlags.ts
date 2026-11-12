// 處置股與可當沖標的：一天抓一次（開著當沖分頁時），抓不到的來源略過、不顯示對應標示。
import { fetchJson } from "../lib/net";
import { taipeiToday } from "../lib/dates";
import { parseDisposal, parseEligible, rowsOf, type DtLists } from "../engine/dtFlags";

export const DT_SOURCES = {
  disposalTwse: "https://openapi.twse.com.tw/v1/announcement/punish",
  disposalTpex: "https://www.tpex.org.tw/openapi/v1/tpex_disposal_information",
  // 證交所 OpenAPI「上市股票每日當日沖銷交易標的及統計」（11/12 run 358：rwd 網址回的是網頁，改用 OpenAPI）
  eligibleTwse: "https://openapi.twse.com.tw/v1/exchangeReport/TWTB4U",
};

let cache: { day: string; lists: DtLists; status: Record<string, string> } | undefined;
let pending: Promise<typeof cache> | undefined;

export async function loadDtFlags(): Promise<{ lists: DtLists; status: Record<string, string> }> {
  const day = taipeiToday();
  if (cache?.day === day) return cache;
  pending ??= (async () => {
    const keys = Object.keys(DT_SOURCES) as (keyof typeof DT_SOURCES)[];
    const rs = await Promise.allSettled(keys.map((k) => fetchJson(DT_SOURCES[k])));
    const get = (k: keyof typeof DT_SOURCES) => { const r = rs[keys.indexOf(k)]; return r.status === "fulfilled" ? r.value : undefined; };
    const status: Record<string, string> = {};
    const disposal = new Map([...parseDisposal(get("disposalTwse"), day), ...parseDisposal(get("disposalTpex"), day)]);
    const TWSE = parseEligible(get("eligibleTwse")), TPEX: Map<string, boolean> | undefined = undefined; // 櫃買的可當沖標的沒有確定可用的資料來源，上櫃只標處置
    keys.forEach((k, i) => { const r = rs[i]; status[k] = r.status === "rejected" ? `失敗 ${String(r.reason?.message ?? r.reason).slice(0, 40)}` : "ok"; });
    status.twtb = JSON.stringify(rowsOf(get("eligibleTwse"))[1] ?? {}).slice(0, 160); // 欄位樣本（除錯用）
    status.counts = `處置 ${disposal.size}・上市可當沖 ${TWSE?.size ?? "無"}`;
    const c = { day, lists: { disposal, eligible: { TWSE, TPEX } }, status };
    if (TWSE || disposal.size) cache = c; // 全部失敗就不快取，下次再試
    return c;
  })().finally(() => { pending = undefined; });
  return (await pending)!;
}
