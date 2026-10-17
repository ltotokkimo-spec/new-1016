// Claude AI：照片辨識持股、個股深度解析、國內外數據解讀。
// 金鑰只存在你的手機裡，直接從手機呼叫 Anthropic API。
import Anthropic from "@anthropic-ai/sdk";
import type { Holding, Scored, SectorStat } from "../engine/score";
import type { MacroQuote } from "../data/us";
import { isEtf } from "../data/tw";

export const MODEL = "claude-opus-5-5";
const BETAS = ["server-side-fallback-2026-07-01"];

export class AiError extends Error {}

export function client(apiKey: string) {
  if (!apiKey) throw new AiError("尚未設定 Claude API 金鑰，請到「設定」貼上金鑰");
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, timeout: 5 * 60_000, maxRetries: 2 });
}

/** 把 SDK 的錯誤轉成看得懂的中文 */
export function explainError(e: unknown): string {
  if (e instanceof AiError) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return "API 金鑰無效，請到「設定」確認金鑰是否貼對";
  if (e instanceof Anthropic.PermissionDeniedError) return "這把 API 金鑰沒有使用權限，請到 Anthropic Console 檢查";
  if (e instanceof Anthropic.RateLimitError) return "請求太頻繁或額度用完，請稍後再試，或到 Anthropic Console 查看用量";
  if (e instanceof Anthropic.BadRequestError) return `請求格式有誤：${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return "連不到 Anthropic，請確認手機網路";
  if (e instanceof Anthropic.APIError && (e.status ?? 0) >= 500) return "Anthropic 服務暫時忙碌，請稍後再試";
  return e instanceof Error ? e.message : String(e);
}

export interface Source { title: string; url: string }
export interface AiReport { text: string; sources: Source[]; model: string; at: number; costUsd?: number; queries?: string[]; fetched?: string[] }

// Claude Opus 5.5 價格：輸入 $4、輸出 $20（每百萬 tokens），快取讀取 $0.20、寫入 $5；網路搜尋每次 $0.01
export function costOf(u: any): number {
  if (!u) return NaN;
  return ((u.input_tokens ?? 0) * 4 + (u.output_tokens ?? 0) * 20 + (u.cache_read_input_tokens ?? 0) * 0.2 + (u.cache_creation_input_tokens ?? 0) * 5) / 1e6
    + (u.server_tool_use?.web_search_requests ?? 0) * 0.01;
}

export function collect(msg: Anthropic.Beta.BetaMessage): AiReport {
  if (msg.stop_reason === "refusal") throw new AiError("Claude 這次沒有回答，請換個方式再試一次");
  let text = "";
  const sources = new Map<string, Source>();
  const queries: string[] = [], fetched: string[] = [];
  for (const b of msg.content as any[]) {
    // 記下 Claude 搜尋過的關鍵字與讀過的網頁，報告最後列出來
    if (b.type === "server_tool_use" && b.name === "web_search" && typeof b.input?.query === "string") queries.push(b.input.query);
    if (b.type === "server_tool_use" && b.name === "web_fetch" && typeof b.input?.url === "string") fetched.push(b.input.url);
    if (b.type === "text") {
      text += b.text;
      for (const c of b.citations ?? []) {
        if (c.type === "web_search_result_location") sources.set(c.url, { title: c.title ?? c.url, url: c.url });
      }
    } else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) if (r.type === "web_search_result" && !sources.has(r.url)) sources.set(r.url, { title: r.title, url: r.url });
    }
  }
  if (!text.trim()) throw new AiError("Claude 沒有產生內容，請再試一次");
  return { text: text.trim(), sources: [...sources.values()].slice(0, 12), model: msg.model, at: Date.now(), costUsd: costOf(msg.usage), queries, fetched };
}

const SYSTEM = `你是台灣投資人的私人研究助理，用繁體中文、台灣慣用語回答。
- 先講結論，再講理由；數字要具體（日期、百分比、張數、金額）。
- 「籌碼與技術數據」是 App 從證交所、櫃買中心、Nasdaq 實際抓到的資料，以它為準；新聞與經濟數據用網路搜尋查證，並註明日期與來源。
- 搜尋時優先找最近 7 天的消息與數據發表（例如美國 CPI、非農、Fed 利率決議、台灣出口與外銷訂單、央行、法說會、月營收）。
- 評等只能是「買入」「觀望」「離場」三選一，寫在第一行，格式：評等：買入（ETF 例外：不給買賣評等，第一行寫「評等：參考」）
- 最後一行加上：以上為研究參考，非投資建議。`;

function fmtPct(x: number) {
  return Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%` : "無資料";
}

export function stockBrief(s: Scored, holding?: Holding): string {
  const lines = [
    `${isEtf(s.code) ? "ETF" : "股票"}：${s.name}（${s.code}，${s.market === "US" ? "美股" : s.market === "TPEX" ? "上櫃" : "上市"}，${s.sector}）`,
    `收盤價：${s.close}`,
    `當日成交金額：${s.market === "US" ? `${(s.value / 1e6).toFixed(0)} 百萬美元` : `${(s.value / 1e8).toFixed(2)} 億元`}`,
    ...(s.foreignRatio5 !== undefined && Number.isFinite(s.foreignRatio5) ? [`外資 5 日買賣超金額約佔 5 日成交金額 ${(s.foreignRatio5 * 100).toFixed(1)}%（以當日成交金額估算）`] : []),
    `報酬：近1週 ${fmtPct(s.ret1w)}、近1月 ${fmtPct(s.ret1m)}、近3月 ${fmtPct(s.ret3m)}`,
    `App 評分：${s.score}/100（動能 ${Math.round(s.momentum * 100)}、${s.market === "US" ? "趨勢" : "籌碼"} ${Math.round(s.flow * 100)}、族群 ${Math.round(s.sectorScore * 100)}），${s.refOnly ? "ETF 不給規則評等（分數只供參考）" : `規則評等：${s.rating}`}`,
    ...s.reasons.map((r) => `- ${r}`),
  ];
  if (holding) lines.push(`我持有 ${holding.shares} 股，平均成本 ${holding.cost}`);
  return lines.join("\n");
}

// ---------- 進度：從串流事件算出「正在做什麼」 ----------
export interface AiProgress {
  phase: "start" | "thinking" | "searching" | "fetching" | "reading" | "writing";
  searches: number; // 已送出的網路搜尋次數
  lastQuery?: string; // 最近一次搜尋的關鍵字
  chars: number; // 已寫出的字數
  section?: string; // 正在寫的段落，例如「3. 近期新聞與公司事件」
}
export type OnProgress = (p: AiProgress) => void;

export interface ProgressScratch { json: Record<number, string>; tail: string }
export const newProgress = (): { p: AiProgress; scratch: ProgressScratch } => ({ p: { phase: "start", searches: 0, chars: 0 }, scratch: { json: {}, tail: "" } });

/** 純函式：吃一個串流事件，回傳新的進度（方便單元測試） */
export function nextProgress(p: AiProgress, ev: any, scratch: ProgressScratch): AiProgress {
  if (ev?.type === "content_block_start") {
    const b = ev.content_block;
    if (b?.type === "thinking" || b?.type === "redacted_thinking") return { ...p, phase: "thinking" };
    if (b?.type === "server_tool_use" && b.name === "web_search") {
      scratch.json[ev.index] = "";
      const q = typeof b.input?.query === "string" && b.input.query ? b.input.query : undefined;
      return { ...p, phase: "searching", searches: p.searches + 1, lastQuery: q ?? p.lastQuery };
    }
    if (b?.type === "server_tool_use" && b.name === "web_fetch") return { ...p, phase: "fetching" };
    if (b?.type === "web_search_tool_result" || b?.type === "web_fetch_tool_result") return { ...p, phase: "reading" };
    if (b?.type === "text") return { ...p, phase: "writing" };
    return p;
  }
  if (ev?.type === "content_block_delta") {
    const d = ev.delta;
    if (d?.type === "input_json_delta" && ev.index in scratch.json) { scratch.json[ev.index] += d.partial_json ?? ""; return p; }
    if (d?.type === "text_delta" && typeof d.text === "string") {
      scratch.tail = (scratch.tail + d.text).slice(-600);
      // 找最後一個段落標題：「3. 近期新聞…」「### 3. …」「**3. …**」
      const heads = [...scratch.tail.matchAll(/(?:^|\n)\s*(?:#{1,4}\s*)?\**\s*(\d{1,2})[.、．]\s*([^\n*]{2,24})/g)];
      const h = heads[heads.length - 1];
      const section = h ? `${h[1]}. ${h[2].trim().replace(/[：:]$/, "")}` : p.section;
      return { ...p, phase: "writing", chars: p.chars + d.text.length, section };
    }
    return p;
  }
  if (ev?.type === "content_block_stop" && ev.index in scratch.json) {
    try {
      const q = JSON.parse(scratch.json[ev.index] || "{}")?.query;
      delete scratch.json[ev.index];
      if (typeof q === "string" && q) return { ...p, lastQuery: q };
    } catch { delete scratch.json[ev.index]; }
    return p;
  }
  return p;
}

async function run(apiKey: string, prompt: string, maxSearches: number, onProgress?: OnProgress, fetchUrls: string[] = []): Promise<AiReport> {
  const c = client(apiKey);
  const stream = c.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: BETAS,
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: SYSTEM,
    tools: [
      { type: "web_search_20260209", name: "web_search", max_uses: maxSearches, user_location: { type: "approximate", country: "TW", timezone: "Asia/Taipei" } },
      // 使用者貼的新聞網址：讓 Claude 直接讀那篇文章（只能讀對話裡出現過的網址）
      ...(fetchUrls.length ? [{ type: "web_fetch_20260209" as const, name: "web_fetch" as const, max_uses: fetchUrls.length + 1 }] : []),
    ],
    messages: [{ role: "user", content: prompt }],
  });
  if (onProgress) {
    let { p, scratch } = newProgress();
    let last = 0;
    onProgress(p);
    for await (const ev of stream) {
      const n = nextProgress(p, ev, scratch);
      // 文字每個 token 都會來，畫面最多每 0.4 秒更新一次；階段、搜尋、段落變了就馬上更新
      const changed = n.phase !== p.phase || n.searches !== p.searches || n.lastQuery !== p.lastQuery || n.section !== p.section;
      p = n;
      if (changed || Date.now() - last > 400) { last = Date.now(); onProgress(p); }
    }
  }
  return collect(await stream.finalMessage());
}

/** 使用者貼的網址：只留 http(s)，最多 3 個 */
export function parseUrls(text: string): string[] {
  // 分享出來的網址都是英數字（中文會被編碼成 %XX），遇到中文或全形標點就是網址結束
  return [...new Set((text.match(/https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'*+,;=%]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")))].slice(0, 3);
}

const urlBlock = (urls: string[]) => urls.length
  ? `\n\n【我想請你一起讀的新聞】\n${urls.map((u) => `- ${u}`).join("\n")}\n請先用 web_fetch 讀完這些文章，把重點（日期、來源、和這檔股票有關的內容）寫進第 3 段，並說明是否影響評等。`
  : "";

export function analyzeStock(apiKey: string, s: Scored, today: string, holding?: Holding, onProgress?: OnProgress, urls: string[] = []) {
  if (s.refOnly) return analyzeEtf(apiKey, s, today, holding, onProgress, urls);
  const prompt = `今天是 ${today}。請分析這檔股票，並給我評等。

【籌碼與技術數據】
${stockBrief(s, holding)}

請用以下段落回答（每段 2~5 點，條列）：
1. 評等與一句話結論
2. 動能與籌碼解讀（用上面的數據，說明外資／族群是否支持）
3. 近期新聞與公司事件（搜尋最近消息：法說會、營收、訂單、產品；也要搜尋提到這檔股票的產業文章、外資或投信報告與目標價。以最近 3 天的台灣財經媒體為優先，例如工商時報、經濟日報、鉅亨網、MoneyDJ，並寫出每則新聞的日期與來源）
4. 國內外數據發表的影響（搜尋最近一週發表的總經數據與央行動態，說明對這檔股票的影響）
5. 風險與觀察重點（什麼情況要改變評等，例如跌破哪個價位或外資轉賣）${holding ? "\n6. 針對我的持股：續抱、加碼、減碼或停損的建議" : ""}${urlBlock(urls)}`;
  return run(apiKey, prompt, 12, onProgress, urls);
}

/** ETF：不給買入／觀望／離場，改說明成分、配息、適合的持有方式 */
function analyzeEtf(apiKey: string, s: Scored, today: string, holding?: Holding, onProgress?: OnProgress, urls: string[] = []) {
  const prompt = `今天是 ${today}。請分析這檔 ETF。這是 ETF，不要給「買入／觀望／離場」評等，第一行固定寫：評等：參考

【籌碼與技術數據】
${stockBrief(s, holding)}

請用以下段落回答（每段 2~5 點，條列）：
1. 一句話說明這檔 ETF 的特性（追蹤什麼、適合長期還是波段）
2. 成分股與產業集中度、費用率、規模（搜尋最新資料）
3. 配息：最近幾次配息金額、殖利率、除息日，以及是否有填息
4. 近期表現與外資動向解讀（用上面的數據），和同類 ETF 比較
5. 國內外數據發表的影響與主要風險（例如利率、匯率、成分股集中）${holding ? "\n6. 針對我的持股：是否適合續抱、要注意什麼（不要給買入／離場評等）" : ""}${urlBlock(urls)}`;
  return run(apiKey, prompt, 12, onProgress, urls);
}

export function marketBrief(apiKey: string, today: string, sectorsTw: SectorStat[], sectorsUs: SectorStat[], macro: MacroQuote[], top: Scored[], onProgress?: OnProgress) {
  const sec = (xs: SectorStat[]) =>
    xs.slice(0, 12).map((s) => `${s.sector}：近1週 ${fmtPct(s.ret1w)}、近1月 ${fmtPct(s.ret1m)}、${s.rotation}${Number.isFinite(s.foreignValue5) ? `、外資5日 ${(s.foreignValue5 / 1e8).toFixed(1)} 億` : ""}`).join("\n");
  const prompt = `今天是 ${today}。請幫我整理今天的國內外市場重點。

【台股族群強弱（App 計算）】
${sec(sectorsTw) || "無資料"}

【美股產業強弱（App 計算）】
${sec(sectorsUs) || "無資料"}

【國際指標報價】
${macro.map((m) => `${m.name}：${m.last}（${m.changePct >= 0 ? "+" : ""}${m.changePct}%）`).join("\n") || "無資料"}

【App 評分前段班】
${top.slice(0, 10).map((s) => `${s.name}(${s.code}) ${s.score}分 ${s.rating}`).join("、")}

請用以下段落回答（條列、具體）：
1. 一句話總結今天的市場氣氛
2. 最近一週國內外重要數據發表與解讀（搜尋：美國 CPI/PCE/非農/零售銷售、Fed 與台灣央行、台灣出口與外銷訂單、PMI；寫出公布日期、實際值與預期值）
3. 接下來一週要注意的數據與事件（日期）
4. 族群輪動解讀：資金從哪裡流到哪裡、外資動向
5. 操作建議：哪些族群偏多、哪些要避開`;
  return run(apiKey, prompt, 12, onProgress);
}

// ---------- 照片辨識持股 ----------
const HOLDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["holdings", "note"],
  properties: {
    holdings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "name", "market", "shares", "cost"],
        properties: {
          code: { type: "string", description: "台股 4 碼代號或美股代號，如 2330、AAPL；看不到代號時填空字串" },
          name: { type: "string" },
          market: { type: "string", enum: ["TW", "US"] },
          shares: { type: "number", description: "持有股數（1 張 = 1000 股；截圖寫張數要換算成股）" },
          cost: { type: "number", description: "每股平均成本；只有總成本時除以股數；看不到時填 0" },
        },
      },
    },
    note: { type: "string", description: "辨識不確定的地方，沒有就填空字串" },
  },
} as const;

export interface ImportedHolding { code: string; name: string; market: "TW" | "US"; shares: number; cost: number }

export async function holdingsFromImage(apiKey: string, base64: string, mediaType: "image/jpeg" | "image/png" | "image/webp"): Promise<{ holdings: ImportedHolding[]; note: string; costUsd: number }> {
  const c = client(apiKey);
  const msg = await c.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: BETAS,
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: HOLDING_SCHEMA as any } },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: "這是我的證券 App 庫存截圖。請列出每一檔持股的代號、名稱、市場、股數與每股平均成本。只列截圖裡看得到的股票，不要猜。" },
      ],
    }],
  });
  if (msg.stop_reason === "refusal") throw new AiError("Claude 無法辨識這張圖片，請換一張清楚的庫存截圖");
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  try {
    const parsed = JSON.parse(text);
    return { holdings: parsed.holdings ?? [], note: parsed.note ?? "", costUsd: costOf(msg.usage) };
  } catch {
    throw new AiError("辨識結果格式不正確，請再試一次");
  }
}

/** 在手機上把照片縮到長邊 1600px、轉成 JPEG，省流量也省費用 */
export async function shrinkImage(file: File, maxSide = 1600): Promise<{ base64: string; mediaType: "image/jpeg" }> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", 0.88);
  return { base64: url.slice(url.indexOf(",") + 1), mediaType: "image/jpeg" };
}

// ---------- 交給 Claude App（用使用者的訂閱，不扣 API 額度） ----------
/** 產生一段完整提問，帶著 App 的數據，請 Claude App 用網路搜尋與已連接的台股工具（MCP）查證 */
export function claudeAppPrompt(s: Scored, today: string, holding?: Holding): string {
  const etf = !!s.refOnly;
  const tools = s.market === "US"
    ? "請用網路搜尋查最近 7 天的新聞、財報與分析師看法。"
    : "如果你有連接台股資料工具（MCP，例如證交所／櫃買資料），請用它查這檔的每月營收、三大法人、融資融券與重大訊息；並用網路搜尋查最近 7 天的新聞與法說會。";
  const d = /^\d{8}$/.test(today) ? `${today.slice(0, 4)}/${today.slice(4, 6)}/${today.slice(6)}` : today;
  return `今天是 ${d}。我用「股市雷達」App 篩選股票，請幫我分析這檔${etf ? " ETF" : "股票"}，用繁體中文、台灣用語回答。

【App 的數據】
${stockBrief(s, holding)}

${tools}

請用以下段落回答（條列、具體、寫出日期與來源）：
1. ${etf ? "一句話說明這檔 ETF 的特性（不要給買入／離場評等）" : "評等（買入／觀望／離場三選一）與一句話結論"}
2. ${etf ? "成分股、費用率、配息與填息" : "動能與籌碼解讀（外資、投信、融資）"}
3. 近期新聞與公司／產業事件
4. 國內外經濟數據與央行動態的影響
5. 風險與觀察重點（什麼價位或情況要改變看法）${holding ? "\n6. 針對我的持股的建議" : ""}

最後加上：以上為研究參考，非投資建議。`;
}

export const claudeAppUrl = (prompt: string) => `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;

// ---------- 自組 ETF：請 Claude 建議要買哪些、買幾股 ----------
export interface EtfHoldingBrief { code: string; name: string; shares: number; avgCost: number; price?: number }

export function aiEtfAdvice(apiKey: string, p: {
  today: string; budget: number; cash: number; nav: number;
  holdings: EtfHoldingBrief[]; candidates: Scored[];
}, onProgress?: OnProgress) {
  const review = p.holdings.some((h) => h.shares > 0);
  const cand = p.candidates.map((s) =>
    `${s.code} ${s.name}｜${s.sector}｜收盤 ${s.close}｜分數 ${s.score}｜${s.rating}｜近1週 ${fmtPct(s.ret1w)}・近1月 ${fmtPct(s.ret1m)}｜外資5日 ${s.foreign5 !== undefined ? Math.round(s.foreign5 / 1000) + " 張" : "無"}`).join("\n");
  const hold = p.holdings.filter((h) => h.shares > 0).map((h) =>
    `${h.code} ${h.name}：${h.shares} 股，平均成本 ${h.avgCost.toFixed(2)}，現價 ${h.price ?? "無資料"}${h.price ? `（${fmtPct(h.price / h.avgCost - 1)}）` : ""}`).join("\n");
  const prompt = `今天是 ${p.today}。我要用新台幣 ${p.budget.toLocaleString()} 元做一個「自組 ETF」，會照你的建議真的下單，之後看效益。
${review ? `目前組合淨值 ${Math.round(p.nav).toLocaleString()} 元，可用現金 ${Math.round(p.cash).toLocaleString()} 元。

【目前持股】
${hold}

請檢視這個組合，建議要賣出、減碼或加碼哪些（不需要每次都調整，沒有必要就說維持不變）。` : `可用現金 ${Math.round(p.cash).toLocaleString()} 元，目前沒有持股。請建議第一次建倉的組合。`}

【App 篩選出的候選股（台股，依分數排序）】
${cand}

規則：
- 以上面的候選股為主，必要時可加入其他台股上市櫃個股，但要說明理由。
- 挑 4～8 檔，分散到至少 3 個產業，單一檔不超過總資金 25%。
- 股數用「股」為單位，可以買零股；買進總金額加手續費（0.1425%）不能超過可用現金${review ? "（賣出的錢可以拿來買）" : ""}，保留約 3～5% 現金。
- 請上網搜尋這些股票最近 7 天的新聞、營收與外資報告再決定，寫出日期與來源。

請用以下段落回答：
1. 組合總結（一句話＋這次${review ? "調整" : "建倉"}的主軸）
2. 每一檔的理由（代號、名稱、${review ? "買進／賣出／不動、" : ""}股數、約略金額、佔比、理由）
3. 風險與停損規則（什麼情況要賣出）

最後一定要附上一個 JSON 區塊（只放要執行的買賣，不動的不要列），格式：
\`\`\`json
{"trades":[{"code":"2330","side":"buy","shares":10,"reason":"一句話理由"}]}
\`\`\``;
  return run(apiKey, prompt, 12, onProgress);
}
