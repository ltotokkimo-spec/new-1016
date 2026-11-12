// 手機內建文字辨識（Google ML Kit，離線、免費）讀出的庫存截圖文字 → 持股（代號、股數、每股成本）。
// 11/12 使用者要求：不用 Claude App，截圖直接在手機上辨識。依使用者提供的兩家券商畫面設計：
// - 元大：表頭兩層「市價／均價」「股數／可下單數」，每檔兩列，只有名稱沒有代號 → 用名稱對代號
// - 口袋：表頭兩層「成交均價／持有股數」，代號在名稱上面
// 作法：找到表頭的欄位（左右位置＋上下層），再把表頭下面每一檔（左邊的名稱或代號開始一個區塊）裡、對到該欄的數字依上下順序取出。
// 結果一定先進確認畫面讓使用者核對。

export interface OcrLine { text: string; x: number; y: number; w: number; h: number }
export interface OcrHolding { code: string; name: string; market: "TW" | "US"; shares: number; cost: number }

const COST_KEY = /(成交均價|成本均價|平均成本|持有均價|買進均價|均價|成本價)/;
// 辨識常把「股」認錯（e2e 實測：庫存股數 → 庫存服數），所以「庫存／持有」後面接任一字＋「數」也算股數欄
const SHARES_KEY = /(持有股數|庫存股數|庫存數量|股數|庫存.數|持有.數)/;
const LOTS_KEY = /(庫存張數|持有張數|張數)/;
const NOT_SHARES = /(可下單|可賣|可用|委託)/;
const CODE_RE = /(?<![\d.,])(00\d{3,4}[A-Z]?|\d{4,5}[A-Z]?)(?![\d.,%])/;
const NUM_RE = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;
const HEAD_WORD = /(名稱|股票|庫存|持有|代號|商品|市價|股價|現價|均價|成本|股數|張數|數量|可下單|損益|報酬|市值|漲跌|淨值|參考|成交|幣別)/;
const LABEL_ONLY = /^(現股|現|股|融資|融券|零股|下單|資|券|[>＞›〉v])$/;

const num = (s: string) => Number(s.replace(/,/g, ""));
const cx = (l: OcrLine) => l.x + l.w / 2;
const cy = (l: OcrLine) => l.y + l.h / 2;
const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");

interface Col { x: number; level: 0 | 1; key: "cost" | "shares" | "lots" | "other"; g: number }

/** 表頭：含「均價」的那一行附近（上下兩層）的文字都是表頭；每個表頭字的左右位置就是一欄，上下分成第 0、1 層 */
function findHeader(lines: OcrLine[]): { cols: Col[]; bottom: number } | undefined {
  const costLine = lines.find((l) => COST_KEY.test(l.text));
  if (!costLine) return undefined;
  const h = costLine.h || 20;
  // 表頭只收欄位名稱這類短字（避免把緊接在表頭下面的第一檔股票名稱當成表頭）
  const head = lines.filter((l) => Math.abs(cy(l) - cy(costLine)) <= h * 2.2 && HEAD_WORD.test(norm(l.text)) && norm(l.text).length <= 8);
  const cols: Col[] = head.map((l) => {
    const sameX = head.filter((o) => o !== l && Math.abs(cx(o) - cx(l)) < Math.max(l.w, o.w) * 0.8);
    const level: 0 | 1 = sameX.some((o) => cy(o) < cy(l) - h * 0.5) ? 1 : 0;
    const t = l.text;
    const key = COST_KEY.test(t) ? "cost" : LOTS_KEY.test(t) ? "lots" : SHARES_KEY.test(t) && !NOT_SHARES.test(t) ? "shares" : "other";
    return { x: cx(l), level, key, g: -1 };
  });
  // 同一欄（上下兩層表頭）的併成一組，數字對到最近的那一組，再依上下順序取第幾層
  let g = 0;
  cols.forEach((c, i) => { if (c.g >= 0) return; c.g = g; cols.forEach((o, j) => { if (j !== i && o.g < 0 && Math.abs(o.x - c.x) < Math.max(head[i].w, head[j].w) * 0.8) o.g = g; }); g++; });
  if (!cols.some((c) => c.key === "shares" || c.key === "lots")) return undefined;
  return { cols, bottom: Math.max(...head.map((l) => l.y + l.h)) };
}

/** 一行文字裡的數字（含估計的左右位置），百分比與時間不算 */
function numbersIn(l: OcrLine): { v: number; x: number; y: number }[] {
  if (/\d+:\d+/.test(l.text)) return [];
  const parts = [...l.text.matchAll(NUM_RE)].filter((m) => l.text[(m.index ?? 0) + m[0].length] !== "%");
  return parts.map((m) => ({
    v: num(m[0]),
    x: parts.length > 1 ? l.x + (l.w * ((m.index ?? 0) + m[0].length / 2)) / Math.max(1, l.text.length) : cx(l),
    y: cy(l),
  }));
}

/** ML Kit 常把同一列相隔較遠的字讀成一行（例如「股票 庫存股數 成本均價 現價」）：依空白拆開，按字寬（中文 1、英數約 0.55）估計每段的左右位置 */
export function splitLines(lines: OcrLine[]): OcrLine[] {
  const wOf = (t: string) => [...t].reduce((a, ch) => a + (/[\u2E80-\uFFFF]/.test(ch) ? 1 : 0.55), 0);
  return lines.flatMap((l) => {
    const parts = l.text.trim().split(/\s+/);
    if (parts.length < 2) return [l];
    const total = wOf(l.text.trim()) || 1;
    let pos = 0;
    const out: OcrLine[] = [];
    for (const m of l.text.trim().matchAll(/\S+|\s+/g)) {
      const w = wOf(m[0]);
      if (m[0].trim()) out.push({ text: m[0], x: l.x + (l.w * pos) / total, y: l.y, w: (l.w * w) / total, h: l.h });
      pos += w;
    }
    return out;
  });
}

export function parseOcrHoldings(lines: OcrLine[], codeOfName: (name: string) => string | undefined = () => undefined): OcrHolding[] {
  const ls = splitLines(lines.filter((l) => l.text.trim()));
  const hd = findHeader(ls);
  if (!hd) return [];
  const firstNumX = Math.min(...hd.cols.filter((c) => c.key !== "other").map((c) => c.x));
  const body = ls.filter((l) => l.y >= hd.bottom - 2);
  const hs = body.map((l) => l.h).sort((a, b) => a - b), mh = hs[hs.length >> 1] || 20;
  // 區塊的開頭：左邊（數字欄左側）的名稱或代號；相鄰（名稱換行、代號在名稱上面）的併成同一檔
  const leftSide = (l: OcrLine) => cx(l) < firstNumX - mh && l.x < firstNumX * 0.75 && !LABEL_ONLY.test(norm(l.text));
  const isAnchor = (l: OcrLine) => /[\u4e00-\u9fffA-Za-z]|^\d{4,5}[A-Z]?$|^00\d{3,4}[A-Z]?$/.test(norm(l.text));
  const isTail = (l: OcrLine) => /^\d{1,2}$/.test(norm(l.text)); // 名稱換行剩下的數字（元大台灣50正「2」、元大台灣「５０」）
  const anchors = body.filter((l) => leftSide(l) && (isAnchor(l) || isTail(l))).sort((a, b) => a.y - b.y);
  const blocks: OcrLine[][] = [];
  for (const a of anchors) {
    const last = blocks[blocks.length - 1];
    if (last && a.y - (last[last.length - 1].y + last[last.length - 1].h) < mh * 0.9) last.push(a);
    else if (isAnchor(a)) blocks.push([a]);
  }
  const allNums = body.flatMap(numbersIn).filter((n) => n.x > firstNumX - mh * 3);
  const groups = [...new Set(hd.cols.map((c) => c.g))].map((gi) => { const cs = hd.cols.filter((c) => c.g === gi); return { g: gi, x: cs.reduce((a, c) => a + c.x, 0) / cs.length }; });
  const nearestGroup = (x: number) => groups.reduce((b, c) => (Math.abs(c.x - x) < Math.abs(b.x - x) ? c : b)).g;
  const out: OcrHolding[] = [];
  blocks.forEach((blk, i) => {
    const top = blk[0].y - mh * 0.6;
    const bottom = i + 1 < blocks.length ? blocks[i + 1][0].y - mh * 0.6 : Infinity;
    const nums = allNums.filter((n) => n.y >= top && n.y < bottom);
    const pick = (key: Col["key"]) => {
      const col = hd.cols.find((c) => c.key === key);
      if (!col) return undefined;
      const mine = nums.filter((n) => nearestGroup(n.x) === col.g).sort((a, b) => a.y - b.y);
      return mine[col.level]?.v ?? (col.level === 1 ? undefined : mine[0]?.v);
    };
    const lots = pick("lots");
    const shares = lots !== undefined ? lots * 1000 : pick("shares");
    const cost = pick("cost");
    const text = blk.map((l) => l.text).join(" ");
    const codeM = norm(text).match(CODE_RE);
    const name = norm(blk.filter((l) => !CODE_RE.test(norm(l.text)) || /[一-鿿]/.test(l.text)).map((l) => l.text).join("")).replace(CODE_RE, "").replace(/^(現股|現)/, "");
    const code = codeM?.[1] ?? codeOfName(name) ?? "";
    if (!(shares! > 0) || !(cost! > 0)) return;
    out.push({ code, name: name || code, market: "TW", shares: Math.round(shares!), cost: cost! });
  });
  const seen = new Set<string>();
  return out.filter((h) => { const k = h.code || h.name; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** 名稱對代號：去空白、全形轉半形後完全相同優先，其次前綴相同（截圖名稱被截斷） */
export function nameLookup(list: { code: string; name: string }[]): (name: string) => string | undefined {
  const m = new Map<string, string>();
  for (const x of list) if (x.name && !m.has(norm(x.name))) m.set(norm(x.name), x.code);
  return (name: string) => {
    const n = norm(name);
    if (!n) return undefined;
    if (m.has(n)) return m.get(n);
    const hits = [...m.entries()].filter(([k]) => n.length >= 3 && (k.startsWith(n) || n.startsWith(k)));
    return hits.length === 1 ? hits[0][1] : undefined;
  };
}

/** 原本有、截圖上沒有的持股（同一家券商）→ 視為已賣出；price 用最新價估算已實現損益 */
export function soldByOmission<T extends { code: string; shares: number; cost: number; name?: string }>(existing: T[], imported: { code: string; name?: string }[], price: (code: string) => number | undefined): (T & { price?: number; pnl?: number })[] {
  // 代號相同、或名稱相同（截圖只辨識到名稱、還沒補代號）都算還在
  const have = new Set(imported.map((r) => r.code.trim().toUpperCase()).filter(Boolean));
  const names = new Set(imported.map((r) => norm(r.name ?? "")).filter(Boolean));
  return existing.filter((h) => !have.has(h.code.toUpperCase()) && !names.has(norm(h.name ?? ""))).map((h) => {
    const p = price(h.code);
    return { ...h, price: p, pnl: p !== undefined && Number.isFinite(p) ? (p - h.cost) * h.shares : undefined };
  });
}
