// 手機內建文字辨識（Android 原生 ML Kit，見 android/.../TextOcrPlugin.java）：離線、免費
import { Capacitor, registerPlugin } from "@capacitor/core";
import type { OcrLine } from "../engine/ocrHoldings";

type RawLine = OcrLine & { els?: OcrLine[] };
interface TextOcr { recognize(o: { base64: string }): Promise<{ lines: RawLine[]; width: number; height: number }> }

/** 一行裡的字詞依左右間距分段：間距超過字高 0.6 倍就是另一欄（用 ML Kit 給的真實位置，比按字數估計準） */
export function splitByElements(l: RawLine): OcrLine[] {
  const els = (l.els ?? []).filter((e) => e && typeof e.text === "string" && e.text.trim()).sort((a, b) => a.x - b.x);
  if (els.length < 2) return [l];
  const out: OcrLine[] = [];
  let cur: OcrLine | undefined;
  for (const e of els) {
    if (cur && e.x - (cur.x + cur.w) <= Math.max(cur.h, e.h) * 0.6) {
      const right = Math.max(cur.x + cur.w, e.x + e.w), top = Math.min(cur.y, e.y), bottom = Math.max(cur.y + cur.h, e.y + e.h);
      cur = { text: cur.text + (/[\u2E80-\uFFFF]$/.test(cur.text) && /^[\u2E80-\uFFFF]/.test(e.text) ? "" : " ") + e.text, x: cur.x, y: top, w: right - cur.x, h: bottom - top };
    } else {
      if (cur) out.push(cur);
      cur = { text: e.text, x: e.x, y: e.y, w: e.w, h: e.h };
    }
  }
  if (cur) out.push(cur);
  return out;
}
const Ocr = registerPlugin<TextOcr>("TextOcr");

export const ocrAvailable = () => Capacitor.isNativePlatform();

export async function recognizeText(base64: string): Promise<OcrLine[]> {
  if (!ocrAvailable()) throw new Error("手機辨識只能在 App 裡使用");
  const r = await Ocr.recognize({ base64 });
  const lines = (r.lines ?? []).filter((l) => l && typeof l.text === "string").flatMap((l) => splitByElements({ ...l, x: l.x ?? 0, y: l.y ?? 0, w: l.w ?? 0, h: l.h ?? 0 }));
  (window as any).__srOcrLast = lines.map((l) => `${l.text}@${Math.round(l.x)},${Math.round(l.y)},${Math.round(l.w)}`); // 自動測試記錄辨識到的原始文字
  return lines;
}

/** 選到的圖片轉 base64（不縮圖：文字辨識需要原解析度） */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => { const s = String(fr.result); resolve(s.slice(s.indexOf(",") + 1)); };
    fr.onerror = () => reject(fr.error ?? new Error("讀不到圖片"));
    fr.readAsDataURL(file);
  });
}
