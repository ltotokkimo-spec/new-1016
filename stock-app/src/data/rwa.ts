// RWA（現實世界資產上鏈）與代幣化美股：CoinGecko 免費 API。
// - /coins/categories：每個類別的總市值與 24 小時變化（RWA 總規模、代幣化公債、黃金、股票等子分類）
// - /coins/markets?category=<id>：某類別裡的個別代幣（規模最大的 RWA 項目、代幣化美股報價）
// 類別代號會改名，所以不寫死：先抓類別清單，再用 id 或名稱比對。

export const CG = "https://api.coingecko.com/api/v3";
export const cgCategoriesUrl = () => `${CG}/coins/categories?order=market_cap_desc`;
export const cgMarketsUrl = (category: string, n: number) =>
  `${CG}/coins/markets?vs_currency=usd&category=${encodeURIComponent(category)}&order=market_cap_desc&per_page=${n}&page=1&price_change_percentage=7d`;

export interface CgCategory { id: string; name: string; cap: number; chg24h?: number }
export interface CgToken { id: string; symbol: string; name: string; price: number; cap?: number; chg24h?: number; chg7d?: number }

// null／空字串要當成沒有資料（Number(null) 是 0，會把沒有價格的代幣變成 $0）
const fin = (x: unknown) => { if (x === null || x === undefined || x === "") return undefined; const n = Number(x); return Number.isFinite(n) ? n : undefined; };

export function parseCgCategories(json: any): CgCategory[] {
  if (!Array.isArray(json)) return [];
  return json
    .map((c: any) => ({ id: String(c?.id ?? ""), name: String(c?.name ?? ""), cap: fin(c?.market_cap) ?? NaN, chg24h: fin(c?.market_cap_change_24h) }))
    .filter((c: CgCategory) => c.id && Number.isFinite(c.cap) && c.cap > 0);
}

export function parseCgMarkets(json: any): CgToken[] {
  if (!Array.isArray(json)) return [];
  return json
    .map((t: any) => ({
      id: String(t?.id ?? ""), symbol: String(t?.symbol ?? "").toUpperCase(), name: String(t?.name ?? ""),
      price: fin(t?.current_price) ?? NaN, cap: fin(t?.market_cap),
      chg24h: fin(t?.price_change_percentage_24h), chg7d: fin(t?.price_change_percentage_7d_in_currency),
    }))
    .filter((t: CgToken) => t.id && Number.isFinite(t.price));
}

/** RWA 總類別：id 是 real-world-assets-rwa，或名稱含 Real World Assets */
export function findRwaTotal(cats: CgCategory[]): CgCategory | undefined {
  return cats.find((c) => c.id === "real-world-assets-rwa") ?? cats.find((c) => /real[- ]world[- ]assets?/i.test(c.name));
}

/** 代幣化美股類別：id 是 tokenized-stock，或名稱含 Tokenized Stock(s)；都沒有就用 xStocks */
export function findStockCategory(cats: CgCategory[]): CgCategory | undefined {
  return cats.find((c) => c.id === "tokenized-stock")
    ?? cats.find((c) => /tokeni[sz]ed (stock|equit)/i.test(c.name))
    ?? cats.find((c) => /xstocks/i.test(c.id + " " + c.name));
}

const ZH: [RegExp, string][] = [
  [/treasur|t-?bill|government (bond|securit)/i, "代幣化公債"],
  [/gold/i, "代幣化黃金"],
  [/silver/i, "代幣化白銀"],
  [/commodit/i, "代幣化商品"],
  [/(stock|equit)/i, "代幣化股票"],
  [/real estate|property/i, "代幣化不動產"],
  [/credit|loan|lending/i, "私募信貸"],
  [/bond/i, "代幣化債券"],
  [/fund/i, "代幣化基金"],
];
/** 類別名稱翻成中文（翻不到就用原名） */
export const zhCategory = (name: string) => ZH.find(([re]) => re.test(name))?.[1] ?? name;

/** RWA 子分類：名稱含 Tokenized 的類別（排除生態系、交易所這類），依市值排序，同名中文只留最大的 */
export function rwaSubcategories(cats: CgCategory[], total?: CgCategory): CgCategory[] {
  const seen = new Set<string>();
  return cats
    .filter((c) => c.id !== total?.id && /tokeni[sz]ed|real[- ]world/i.test(c.name) && !/ecosystem|portfolio|launchpad|exchange/i.test(c.name))
    .sort((a, b) => b.cap - a.cap)
    .filter((c) => { const k = zhCategory(c.name); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 6);
}

/**
 * 某檔美股的代幣化版本：在「代幣化股票」類別裡找代號對得上的代幣。
 * 常見命名：xStocks 用「代號＋x」（NVDAx）、Ondo 用「代號＋on」（NVDAon）、Backed 用「b＋代號」（bNVDA），
 * 也有直接用原代號的。BRK.B 這類去掉點再比。依市值排序。
 */
export function tokensForStock(usSymbol: string, tokens: CgToken[]): CgToken[] {
  const s = usSymbol.toUpperCase().replace(/[.\-\/]/g, "");
  if (!s) return [];
  const want = new Set([s, `${s}X`, `${s}ON`, `B${s}`]);
  return tokens
    .filter((t) => want.has(t.symbol.toUpperCase().replace(/[.\-\/]/g, "")))
    .sort((a, b) => (b.cap ?? 0) - (a.cap ?? 0));
}

/** 金額：美元 → 億美元（1 億 = 1e8） */
export function fmtUsdYi(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const yi = v / 1e8;
  return yi >= 100 ? `${Math.round(yi).toLocaleString("en-US")} 億美元` : yi >= 1 ? `${yi.toFixed(1)} 億美元` : `${Math.round(v / 1e4).toLocaleString("en-US")} 萬美元`;
}
