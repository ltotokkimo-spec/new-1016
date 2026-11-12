// 處置股與可當沖標的：一天抓一次（開著當沖分頁時），抓不到的來源略過、不顯示對應標示。
import { fetchJson } from "../lib/net";
import { taipeiToday } from "../lib/dates";
import { parseDisposal, parseEligible, type DtLists } from "../engine/dtFlags";

export const DT_SOURCES = {
  disposalTwse: "https://openapi.twse.com.tw/v1/announcement/punish",
  disposalTpex: "https://www.tpex.org.tw/openapi/v1/tpex_disposal_information",
  eligibleTwse: "https://www.twse.com.tw/rwd/zh/afterTrading/TWTB4U?response=json",
  eligibleTpex: "https://www.tpex.org.tw/www/zh-tw/intraday/dayTrading?response=json",
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
    const TWSE = parseEligible(get("eligibleTwse")), TPEX = parseEligible(get("eligibleTpex"));
    keys.forEach((k, i) => { const r = rs[i]; status[k] = r.status === "rejected" ? `失敗 ${String(r.reason?.message ?? r.reason).slice(0, 40)}` : "ok"; });
    status.counts = `處置 ${disposal.size}・上市可當沖 ${TWSE?.size ?? "無"}・上櫃可當沖 ${TPEX?.size ?? "無"}`;
    const c = { day, lists: { disposal, eligible: { TWSE, TPEX } }, status };
    if (TWSE || disposal.size) cache = c; // 全部失敗就不快取，下次再試
    return c;
  })().finally(() => { pending = undefined; });
  return (await pending)!;
}
