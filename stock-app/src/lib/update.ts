// App 內更新：比對 GitHub Releases 上最新版的版本號，有新版就在 App 裡下載並交給 Android 安裝。
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { fetchJson } from "./net";

interface ApkUpdater {
  getVersion(): Promise<{ versionCode: number; versionName: string }>;
  canInstall(): Promise<{ allowed: boolean }>;
  openInstallSettings(): Promise<void>;
  downloadAndInstall(o: { url: string }): Promise<{ bytes: number }>;
  addListener(e: "progress", f: (p: { done: number; total: number }) => void): Promise<PluginListenerHandle>;
}
const Updater = registerPlugin<ApkUpdater>("ApkUpdater");

// 11/11 使用者要求停用舊載點（stock-radar-latest 已刪除），App 改從這個新位置更新
const BASE = "https://github.com/ltotokkimo-spec/new-1016/releases/download/radar-app-d43m21s655";
export const APK_URL = `${BASE}/stock-radar.apk`;
export const VERSION_URL = `${BASE}/version.json`;

export interface RemoteVersion { versionCode: number; versionName: string; notes?: string; minVersionCode?: number }
export interface UpdateInfo { current?: { versionCode: number; versionName: string }; latest?: RemoteVersion; available: boolean; blocked?: boolean }

/** 遠端停用（11/11 使用者要求）：版本號低於 version.json 的 minVersionCode 就停用；記在手機上，離線重開也維持停用 */
const KILL_KEY = "minVersionCode";
export function storedMinVersion(): number { try { return Number(localStorage.getItem(KILL_KEY)) || 0; } catch { return 0; } }
export function isBlocked(versionCode: number | undefined, min = storedMinVersion()): boolean { return !!versionCode && min > 0 && versionCode < min; }

export const isNative = () => Capacitor.isNativePlatform();

export async function currentVersion() {
  return isNative() ? Updater.getVersion() : undefined;
}

export async function checkUpdate(): Promise<UpdateInfo> {
  const current = await currentVersion();
  // 加時間參數避開快取
  const latest = (await fetchJson(`${VERSION_URL}?t=${Date.now()}`)) as RemoteVersion;
  if (!latest || !Number.isFinite(latest.versionCode)) throw new Error("讀不到最新版資訊");
  const min = Number(latest.minVersionCode) || 0;
  try { localStorage.setItem(KILL_KEY, String(min)); } catch { /* 存不起來就只看這次 */ }
  return { current, latest, available: !!current && latest.versionCode > current.versionCode, blocked: isBlocked(current?.versionCode, min) };
}

export async function canInstall() { return isNative() ? (await Updater.canInstall()).allowed : false; }
export async function openInstallSettings() { await Updater.openInstallSettings(); }

export async function downloadAndInstall(onProgress: (done: number, total: number) => void) {
  const h = await Updater.addListener("progress", (p) => onProgress(p.done, p.total));
  try { return await Updater.downloadAndInstall({ url: APK_URL }); }
  finally { await h.remove(); }
}
