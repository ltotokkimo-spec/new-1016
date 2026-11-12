// 新聞來源（免費、不用金鑰）：鉅亨網新聞 API、Google 新聞 RSS、證交所／櫃買每日重大訊息。各來源獨立，抓不到的略過。
import { fetchJson, fetchText } from "../lib/net";
import { parseCnyes, parseGoogleRss, parseMops, type NewsItem } from "../engine/news";

const G = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
export const NEWS_SOURCES: { name: string; load: () => Promise<NewsItem[]> }[] = [
  { name: "鉅亨網頭條", load: async () => parseCnyes(await fetchJson("https://api.cnyes.com/media/api/v1/newslist/category/headline?limit=40")) },
  { name: "鉅亨網台股", load: async () => parseCnyes(await fetchJson("https://api.cnyes.com/media/api/v1/newslist/category/tw_stock?limit=40")) },
  { name: "鉅亨網國際", load: async () => parseCnyes(await fetchJson("https://api.cnyes.com/media/api/v1/newslist/category/wd_stock?limit=30")) },
  { name: "Google 新聞財經", load: async () => parseGoogleRss(await fetchText("https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=zh-TW&gl=TW&ceid=TW:zh-Hant")) },
  { name: "Google 新聞台股", load: async () => parseGoogleRss(await fetchText(G("台股 OR 加權指數 OR 外資 when:1d"))) },
  { name: "Google 新聞國際", load: async () => parseGoogleRss(await fetchText(G("美股 OR 聯準會 OR 關稅 OR 輝達 when:1d"))) },
  { name: "上市重大訊息", load: async () => parseMops(await fetchJson("https://openapi.twse.com.tw/v1/opendata/t187ap04_L"), "上市") },
  { name: "上櫃重大訊息", load: async () => parseMops(await fetchJson("https://www.tpex.org.tw/openapi/v1/mopsfe_t187ap04_O"), "上櫃") },
];

/** 同時抓所有來源；回傳合併的新聞與每個來源的結果（給畫面顯示哪些來源抓不到） */
export async function loadNews(): Promise<{ items: NewsItem[]; status: { name: string; n: number; error?: string }[] }> {
  const rs = await Promise.allSettled(NEWS_SOURCES.map((s) => s.load()));
  const items: NewsItem[] = [];
  const seen = new Set<string>();
  const status = rs.map((r, i) => {
    if (r.status === "rejected") return { name: NEWS_SOURCES[i].name, n: 0, error: String(r.reason?.message ?? r.reason).slice(0, 80) };
    for (const x of r.value) if (!seen.has(x.id)) { seen.add(x.id); items.push(x); }
    return { name: NEWS_SOURCES[i].name, n: r.value.length };
  });
  return { items, status };
}

/**
 * 查詢（11/12 使用者：打「友達」就優先找友達最新的事件新聞）：Google 新聞搜尋近 7 天＋鉅亨網關鍵字搜尋，
 * 名稱和代號都會一起搜；抓不到的來源略過。
 */
export async function searchNews(q: string, alias?: string): Promise<{ items: NewsItem[]; status: { name: string; n: number; error?: string }[] }> {
  const terms = [q, alias].filter((x): x is string => !!x && !!x.trim());
  const gq = terms.length > 1 ? `${terms.map((t) => `"${t}"`).join(" OR ")} when:7d` : `"${q}" when:7d`;
  const name = terms.find((t) => !/^\d+[A-Z]?$/.test(t)) ?? q;
  const src: { name: string; load: () => Promise<NewsItem[]> }[] = [
    { name: "Google 新聞", load: async () => parseGoogleRss(await fetchText(G(gq))) },
    { name: "Google 新聞（財經）", load: async () => parseGoogleRss(await fetchText(G(`"${name}" 股 when:7d`))) },
    { name: "鉅亨網", load: async () => parseCnyes(await fetchJson(`https://ess.api.cnyes.com/ess/api/v1/news/keyword?q=${encodeURIComponent(name)}&limit=30&page=1`)) },
  ];
  const rs = await Promise.allSettled(src.map((s) => s.load()));
  const items: NewsItem[] = [];
  const seen = new Set<string>();
  const status = rs.map((r, i) => {
    if (r.status === "rejected") return { name: src[i].name, n: 0, error: String(r.reason?.message ?? r.reason).slice(0, 80) };
    for (const x of r.value) if (!seen.has(x.id)) { seen.add(x.id); items.push(x); }
    return { name: src[i].name, n: r.value.length };
  });
  return { items, status };
}
