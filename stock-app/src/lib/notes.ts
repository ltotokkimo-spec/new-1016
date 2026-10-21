// 更新說明：RELEASE_NOTES.txt 每個版本把新內容加在最後面，App 要先顯示最新的幾項。
export const NOTES_SHOWN = 5;

/** 取最新的 n 項（新的排最前面），回傳顯示的項目與被收起來的項目數 */
export function latestNotes(notes: string, n = NOTES_SHOWN): { shown: string[]; hidden: string[] } {
  const all = notes.split("\n").map((x) => x.trim()).filter(Boolean).reverse();
  return { shown: all.slice(0, n), hidden: all.slice(n) };
}
