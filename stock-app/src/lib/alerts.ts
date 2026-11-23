// 持股警示推播（11/23 使用者：「我的實單」「雙引擎實單」達標離場或跌破停損時推播到手機）。
// 手機 App 才有：把要盯的持股（代號、均價、停損價、前 4 天收盤平均）交給原生外掛，
// 原生端用 Android WorkManager 每 15 分鐘（盤中 9:00～13:35）抓證交所即時價比對，條件成立就跳手機通知，同一檔同一種一天只通知一次。
// App 沒開也會檢查；Android 省電模式可能延後幾分鐘。
import { Capacitor, registerPlugin, type Plugin } from "@capacitor/core";

export interface AlertWatchItem {
  code: string; name: string;
  acct: "real" | "dual"; // 我的實單／雙引擎實單
  ex: "tse" | "otc"; // 上市／上櫃（證交所即時價 API 要分）
  avg: number; // 平均成本（含買進手續費）
  stop: number; // 停損價（現價 ≤ 停損價且停損價不高於均價 → 跌破停損；停損價高於均價時是「停利價」，跌破算達標離場）
  ma4?: number; // 前 4 個交易日收盤平均：現價 < 這個 ⇔ 現價跌破 5 日線（5 日線＝前 4 天收盤＋現價）
}
interface AlertsNative extends Plugin {
  setWatch(o: { items: string }): Promise<{ count: number }>;
  requestPermission(): Promise<{ granted: boolean }>;
  status(): Promise<{ count: number; granted: boolean; scheduled: boolean }>;
}
const Alerts = registerPlugin<AlertsNative>("Alerts");

let asked = false;
let lastSent = "";
/** 把要盯的持股交給原生端（內容沒變就不重送）；第一次會問通知權限（Android 13 起要問） */
export async function setAlertWatch(items: AlertWatchItem[]): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const json = JSON.stringify(items);
  if (json === lastSent) return;
  try {
    if (items.length && !asked) { asked = true; await Alerts.requestPermission().catch(() => undefined); }
    await Alerts.setWatch({ items: json });
    lastSent = json;
  } catch { /* 舊版沒有這個外掛：不影響其他功能 */ }
}
export async function alertStatus() {
  if (!Capacitor.isNativePlatform()) return undefined;
  try { return await Alerts.status(); } catch { return undefined; }
}
if (Capacitor.isNativePlatform()) (window as any).__srAlertStatus = alertStatus; // 自動測試用
