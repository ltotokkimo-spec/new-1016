// 即時重要新聞整理（11/12 使用者：數據頁加「新聞」分頁，每次打開 App 整理國內外大事、影響大盤的消息與重大個股）。
// 免費來源：鉅亨網新聞 API、Google 新聞 RSS、證交所／櫃買「上市櫃公司每日重大訊息」。
// 不用 AI：依關鍵字分成「國際／台股大盤／個股」，依重要關鍵字、幾家媒體同時報導、新舊與是否為持股排出重要性。

export type NewsCat = "國際" | "台股大盤" | "個股";
export interface NewsItem {
  id: string;
  title: string;
  summary?: string;
  source: string; // 媒體名
  url: string;
  at: number; // 發布時間（ms）
  feed: "cnyes" | "google" | "mops";
}
export interface NewsView extends NewsItem {
  cat: NewsCat;
  score: number;
  stocks: { code: string; name: string }[]; // 標題提到的股票
  mine: boolean; // 提到我的持股
  also: string[]; // 其他也報導同一件事的媒體
  tags: string[]; // 命中的重要關鍵字（顯示用）
}

const stripTags = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();

/** 鉅亨網：{ items: { data: [{ newsId, title, summary, publishAt(秒), categoryName }] } } */
export function parseCnyes(j: any): NewsItem[] {
  const arr = j?.items?.data ?? j?.data?.items ?? j?.data ?? [];
  if (!Array.isArray(arr)) return [];
  return arr.filter((x: any) => x?.title && x?.newsId).map((x: any) => ({
    id: `cnyes:${x.newsId}`,
    title: stripTags(String(x.title)),
    summary: x.summary ? stripTags(String(x.summary)).slice(0, 160) : undefined,
    source: "鉅亨網",
    url: `https://news.cnyes.com/news/id/${x.newsId}`,
    at: Number(x.publishAt) * 1000,
    feed: "cnyes" as const,
  })).filter((x: NewsItem) => Number.isFinite(x.at) && x.at > 0);
}

/** Google 新聞 RSS：<item><title>標題 - 媒體</title><link>…</link><pubDate>…</pubDate><source>媒體</source></item> */
export function parseGoogleRss(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const get = (tag: string) => stripTags(it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "");
    let title = get("title");
    const source = get("source") || title.match(/ - ([^-]+)$/)?.[1]?.trim() || "Google 新聞";
    title = title.replace(new RegExp(` - ${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "").trim();
    const at = Date.parse(get("pubDate"));
    const url = get("link");
    if (!title || !Number.isFinite(at)) continue;
    out.push({ id: `g:${url || title}`, title, source, url, at, feed: "google" });
  }
  return out;
}

/** 民國日期＋時間（1151112、133005）→ 台北時間 ms */
function rocTime(d: string, t?: string): number {
  const s = String(d ?? "").replace(/\D/g, "");
  if (s.length < 7) return NaN;
  const y = Number(s.slice(0, s.length - 4)) + 1911, mo = s.slice(-4, -2), da = s.slice(-2);
  const tt = String(t ?? "").replace(/\D/g, "").padStart(6, "0").slice(0, 6);
  return Date.parse(`${y}-${mo}-${da}T${tt.slice(0, 2)}:${tt.slice(2, 4)}:${tt.slice(4, 6)}+08:00`);
}

/** 證交所／櫃買 openapi 的上市櫃公司每日重大訊息（欄位名稱依資料集略有不同，用關鍵字找） */
export function parseMops(arr: any, board: "上市" | "上櫃"): NewsItem[] {
  if (!Array.isArray(arr)) return [];
  const pick = (o: any, re: RegExp) => { const k = Object.keys(o).find((x) => re.test(x)); return k ? String(o[k] ?? "").trim() : ""; };
  return arr.map((o: any) => {
    const code = pick(o, /公司代號|SecuritiesCompanyCode/i);
    const name = pick(o, /公司名稱|CompanyName/i);
    const subject = pick(o, /主旨|Subject/i);
    const at = rocTime(pick(o, /發言日期|SpeakDate/i), pick(o, /發言時間|SpeakTime/i));
    return {
      id: `mops:${code}:${at}:${subject.slice(0, 20)}`,
      title: `${name}（${code}）${subject}`,
      summary: pick(o, /說明|Description/i).replace(/\s+/g, " ").slice(0, 160) || undefined,
      source: `重大訊息・${board}`,
      url: `https://mops.twse.com.tw/mops/#/web/t05st01?companyId=${code}`,
      at,
      feed: "mops" as const,
    };
  }).filter((x) => x.title && Number.isFinite(x.at));
}

// ---------- 分類與重要性 ----------
const INTL = /(美國|美股|聯準會|Fed|鮑爾|華爾街|那斯達克|道瓊|標普|S&P|費半|川普|白宮|拜登|美債|殖利率|美元|日圓|日本|日經|中國|陸股|大陸|北京|習近平|歐洲|歐盟|歐洲央行|英國|德國|俄羅斯|烏克蘭|以色列|伊朗|中東|戰爭|油價|原油|OPEC|黃金|比特幣|非農|CPI|PCE|通膨|GDP|關稅|貿易戰|輝達|NVIDIA|蘋果|特斯拉|微軟|Google|Meta|亞馬遜|超微|AMD|英特爾|美光|博通|韓國|三星|印度)/i;
const TW_MARKET = /(台股|加權指數|大盤|集中市場|櫃買|上櫃指數|外資|投信|自營商|三大法人|央行|新台幣|台幣|匯率|台指期|期指|成交量|成交值|成交金額|融資|證交所|金管會|主計總處|出口|外銷訂單|景氣燈號|國發會|台灣經濟)/;
// 重要關鍵字：每個加分（數字越大越可能影響大盤）
const KEY: [RegExp, number, string][] = [
  [/(聯準會|Fed|鮑爾|FOMC|降息|升息|利率決策)/i, 5, "Fed／利率"],
  [/(關稅|貿易戰|制裁|出口管制|禁令)/, 5, "關稅／制裁"],
  [/(CPI|PCE|非農|就業|通膨|GDP|失業率)/i, 4, "經濟數據"],
  [/(戰爭|開戰|攻擊|飛彈|衝突|地緣)/, 4, "地緣政治"],
  [/(崩跌|暴跌|重挫|大跌|狂瀉|跌停|熔斷|血洗|股災)/, 4, "大跌"],
  [/(大漲|狂飆|噴出|創新高|歷史新高|漲停|飆漲|強彈)/, 3, "大漲"],
  [/(輝達|NVIDIA|台積電|TSMC|AI 伺服器|AI伺服器|半導體)/i, 3, "AI／半導體"],
  [/(外資|三大法人).{0,6}(賣超|買超|提款|調節|加碼|狂買|狂賣)/, 3, "外資動向"],
  [/(央行|匯率|新台幣|升值|貶值)/, 2, "匯率"],
  [/(財報|營收|法說|EPS|獲利|財測|展望)/, 2, "財報／營收"],
  [/(油價|原油|OPEC|黃金)/, 2, "原物料"],
  [/(併購|收購|合併|增資|減資|下市|停止交易|處置|注意股|違約|裁員|董事長|總經理)/, 2, "公司大事"],
];

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s「」『』【】（）()《》〈〉:：,，.。!！?？、'"‘’“”…\-–—|｜/]/g, "");
/** 兩則標題是否同一件事：字元 2-gram 重疊比例 */
export function similar(a: string, b: string): number {
  const g = (s: string) => { const n = norm(s); const set = new Set<string>(); for (let i = 0; i < n.length - 1; i++) set.add(n.slice(i, i + 2)); return set; };
  const A = g(a), B = g(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.min(A.size, B.size);
}

export function organizeNews(items: NewsItem[], opts: { now?: number; stocks?: { code: string; name: string }[]; mine?: string[]; maxAgeH?: number } = {}): NewsView[] {
  const now = opts.now ?? Date.now();
  const maxAge = (opts.maxAgeH ?? 36) * 3600_000;
  const mine = new Set(opts.mine ?? []);
  // 名稱至少 2 個字才比對，避免誤判；長的名稱先比（「台積電」優先於「台積」）
  const stocks = (opts.stocks ?? []).filter((s) => s.name && s.name.length >= 2 && !/^(台灣|美國|中國|大盤|指數)$/.test(s.name)).sort((a, b) => b.name.length - a.name.length);
  const fresh = items.filter((x) => x.at <= now + 10 * 60_000 && now - x.at <= maxAge).sort((a, b) => b.at - a.at);
  // 同一件事（不同媒體）併成一則，保留最早看到的最新那則，其他媒體列在 also
  const groups: NewsItem[][] = [];
  for (const it of fresh) {
    const g = groups.find((gr) => gr[0].feed !== "mops" && it.feed !== "mops" && similar(gr[0].title, it.title) >= 0.6);
    if (g) g.push(it); else groups.push([it]);
  }
  return groups.map((g) => {
    const it = g[0];
    const text = `${it.title} ${it.summary ?? ""}`;
    const found: { code: string; name: string }[] = [];
    for (const s of stocks) {
      if (found.length >= 4) break;
      if ((it.title.includes(s.name) || new RegExp(`(?<![\\d])${s.code}(?![\\d])`).test(it.title)) && !found.some((f) => f.code === s.code || f.name.includes(s.name))) found.push(s);
    }
    const mopsCode = it.feed === "mops" ? it.title.match(/（(\w+)）/)?.[1] : undefined;
    if (mopsCode && !found.some((f) => f.code === mopsCode)) found.unshift({ code: mopsCode, name: it.title.split("（")[0] });
    const isMine = found.some((f) => mine.has(f.code));
    const tags: string[] = [];
    let score = 0;
    for (const [re, w, label] of KEY) if (re.test(text)) { score += w; tags.push(label); }
    const intl = INTL.test(it.title), twm = TW_MARKET.test(it.title);
    const cat: NewsCat = it.feed === "mops" ? "個股" : twm && !/(美股|那斯達克|道瓊|標普|日經|陸股)/.test(it.title) ? "台股大盤" : intl ? "國際" : found.length ? "個股" : twm ? "台股大盤" : "國際";
    if (cat === "台股大盤") score += 2;
    if (cat === "國際" && intl) score += 1;
    score += Math.min(3, g.length - 1) * 2; // 多家媒體同時報導
    if (isMine) score += 4;
    if (it.feed === "mops") score += isMine ? 2 : -3; // 重大訊息很多是例行公告：持股的才往前排
    const ageH = (now - it.at) / 3600_000;
    score += ageH < 1 ? 3 : ageH < 3 ? 2 : ageH < 8 ? 1 : ageH > 24 ? -2 : 0;
    const also = [...new Set(g.slice(1).map((x) => x.source).filter((s) => s !== it.source))];
    return { ...it, cat, score, stocks: found, mine: isMine, also, tags };
  });
}

/** 「現在最重要」：分數最高的幾則（同一類最多 3 則，避免全是同一種消息） */
export function topNews(v: NewsView[], n = 6): NewsView[] {
  const sorted = [...v].filter((x) => x.feed !== "mops" || x.mine).sort((a, b) => b.score - a.score || b.at - a.at);
  const out: NewsView[] = [];
  const perCat: Record<string, number> = {};
  for (const x of sorted) {
    if (out.length >= n) break;
    if ((perCat[x.cat] ?? 0) >= 3) continue;
    perCat[x.cat] = (perCat[x.cat] ?? 0) + 1;
    out.push(x);
  }
  return out;
}

export function agoText(at: number, now = Date.now()): string {
  const m = Math.max(0, Math.floor((now - at) / 60_000));
  if (m < 1) return "剛剛";
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  return `${Math.floor(h / 24)} 天前`;
}
