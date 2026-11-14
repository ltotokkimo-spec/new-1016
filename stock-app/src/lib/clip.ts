// 剪貼簿讀取：手機 App 用原生外掛（網頁的 readText 在內嵌網頁裡沒按按鈕會被拒絕），瀏覽器用網頁 API。
import { Capacitor, registerPlugin } from "@capacitor/core";

interface ClipNative {
  has(): Promise<{ has: boolean }>;
  read(): Promise<{ text: string }>;
  write(o: { text: string }): Promise<void>;
}
const Clip = registerPlugin<ClipNative>("Clip");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 讀剪貼簿的文字；讀不到會丟出錯誤。
 * waitFocus：剛從別的 App 切回來時，Android 要等畫面拿到焦點才讀得到，所以先等（最多約 3 秒）；
 * 等的時候只問「有沒有東西」，不讀內容，系統不會一直跳「已從剪貼簿貼上」。
 */
export async function readClipboard(waitFocus = false): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    for (let i = 0; i < (waitFocus ? 12 : 1); i++) {
      if ((await Clip.has()).has) return (await Clip.read()).text;
      if (waitFocus) await sleep(250);
    }
    return (await Clip.read()).text; // 沒等到焦點也試一次（舊版 Android 不需要焦點）
  }
  return await navigator.clipboard.readText();
}

// 自動測試用：把文字放進手機的系統剪貼簿，模擬「在 Claude App 按了複製」
if (Capacitor.isNativePlatform()) (window as any).__srClipWrite = (text: string) => Clip.write({ text });
