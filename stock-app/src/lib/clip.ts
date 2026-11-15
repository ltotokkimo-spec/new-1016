// 剪貼簿讀取：手機 App 用原生外掛（網頁的 readText 在內嵌網頁裡沒按按鈕會被拒絕），瀏覽器用網頁 API。
import { Capacitor, registerPlugin, type Plugin } from "@capacitor/core";

interface ClipNative extends Plugin {
  has(): Promise<{ has: boolean; focus?: boolean }>;
  read(): Promise<{ text: string }>;
  write(o: { text: string }): Promise<void>;
}
const Clip = registerPlugin<ClipNative>("Clip");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 原生呼叫偶爾一直不回應（11/15 模擬器卡在「正在讀剪貼簿…」超過 15 秒）：每次最多等 ms，逾時就丟錯，讓下一次切回前景再試 */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error("讀剪貼簿逾時")), ms); })]).finally(() => clearTimeout(t));
}

/**
 * 讀剪貼簿的文字；讀不到會丟出錯誤。
 * waitFocus：剛從別的 App 切回來時，Android 要等畫面拿到焦點才讀得到，所以先等（最多約 8 秒）；
 * 等的時候只問「有沒有東西」，不讀內容，系統不會一直跳「已從剪貼簿貼上」。
 */
export async function readClipboard(waitFocus = false): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    const until = Date.now() + (waitFocus ? 8000 : 0);
    do {
      const h = await within(Clip.has(), 2000).catch(() => ({ has: false }));
      if (h.has) return (await within(Clip.read(), 3000)).text;
      if (waitFocus) await sleep(250);
    } while (Date.now() < until);
    return (await within(Clip.read(), 3000)).text; // 沒等到也試一次（舊版 Android 不需要焦點）
  }
  return await navigator.clipboard.readText();
}

/** App 從背景回到前景時呼叫 cb（手機 App 才有；回傳取消的函式） */
export function onAppResume(cb: () => void): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};
  let off = false, handle: { remove: () => Promise<void> } | undefined;
  Clip.addListener("resume", cb).then((h) => { if (off) void h.remove(); else handle = h; }, () => {});
  return () => { off = true; void handle?.remove(); };
}

// 自動測試用：把文字放進手機的系統剪貼簿，模擬「在 Claude App 按了複製」
if (Capacitor.isNativePlatform()) (window as any).__srClipWrite = (text: string) => Clip.write({ text });
