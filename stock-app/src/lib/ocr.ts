// 手機內建文字辨識（Android 原生 ML Kit，見 android/.../TextOcrPlugin.java）：離線、免費
import { Capacitor, registerPlugin } from "@capacitor/core";
import type { OcrLine } from "../engine/ocrHoldings";

interface TextOcr { recognize(o: { base64: string }): Promise<{ lines: OcrLine[]; width: number; height: number }> }
const Ocr = registerPlugin<TextOcr>("TextOcr");

export const ocrAvailable = () => Capacitor.isNativePlatform();

export async function recognizeText(base64: string): Promise<OcrLine[]> {
  if (!ocrAvailable()) throw new Error("手機辨識只能在 App 裡使用");
  const r = await Ocr.recognize({ base64 });
  return (r.lines ?? []).filter((l) => l && typeof l.text === "string").map((l) => ({ text: l.text, x: l.x ?? 0, y: l.y ?? 0, w: l.w ?? 0, h: l.h ?? 0 }));
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
