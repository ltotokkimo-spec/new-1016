// 主動式 ETF 主動加減碼標記（11/27 使用者：主動式 ETF 買超當參考）：只是標示，不影響評等與買賣規則
import { latestTilt, type ActiveEtfData, type TiltCount } from "../lib/activeEtf";
import { getState } from "../store";

export const ACTIVE_TAG_MIN = 2; // 幾檔以上主動式 ETF 同時主動加碼／減碼才標
const cache = new WeakMap<ActiveEtfData, TiltCount | undefined>();
export function tiltNow(data?: ActiveEtfData): TiltCount | undefined {
  if (!data) return undefined;
  if (!cache.has(data)) cache.set(data, latestTilt(data));
  return cache.get(data);
}

// 不在每一列訂閱狀態（11/27：選股清單 150 列各自訂閱太耗資源），跟著上層畫面重畫時讀目前資料
export function ActiveTag({ code }: { code: string }) {
  const data = getState().activeEtf?.data;
  const t = tiltNow(data);
  if (!t) return null;
  const b = t.buy[code]?.length ?? 0, s = t.sell[code]?.length ?? 0;
  const d = `${Number(t.date.slice(4, 6))}/${Number(t.date.slice(6))}`;
  if (b >= ACTIVE_TAG_MIN && b > s) return <span class="pill buy" style={{ fontSize: "11px", marginLeft: "4px" }} title={`${d} 有 ${b} 檔主動式 ETF 主動加碼（已扣掉申購造成的同比例買進）`} data-testid="active-tag">主動ETF {b} 家加碼</span>;
  if (s >= ACTIVE_TAG_MIN && s > b) return <span class="pill exit" style={{ fontSize: "11px", marginLeft: "4px" }} title={`${d} 有 ${s} 檔主動式 ETF 主動減碼`} data-testid="active-tag">主動ETF {s} 家減碼</span>;
  return null;
}
