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
export interface AiReport { text: string; sources: Source[]; model: string; at: number; costUsd?: number }

// Claude Opus 5.5 價格：輸入 $4、輸出 $20（每百萬 tokens），快取讀取 $0.20、寫入 $5；網路搜尋每次 $0.01
export function costOf(u: any): number {
  if (!u) return NaN;
  return ((u.input_tokens ?? 0) * 4 + (u.output_tokens ?? 0) * 20 + (u.cache_read_input_tokens ?? 0) * 0.2 + (u.cache_creation_input_tokens ?? 0) * 5) / 1e6
    + (u.server_tool_use?.web_search_requests ?? 0) * 0.01;
}

function collect(msg: Anthropic.Beta.BetaMessage): AiReport {
  if (msg.stop_reason === "refusal") throw new AiError("Claude 這次沒有回答，請換個方式再試一次");
  let text = "";
  const sources = new Map<string, Source>();
  for (const b of msg.content) {
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
  return { text: text.trim(), sources: [...sources.values()].slice(0, 12), model: msg.model, at: Date.now(), costUsd: costOf(msg.usage) };
}

const SYSTEM = `你是台灣投資人的私人研究助理，用繁體中文、台灣慣用語回答。
- 先講結論，再講理由；數字要具體（日期、百分比、張數、金額）。
- 「籌碼與技術數據」是 App 從證交所、櫃買中心、Nasdaq 實際抓到的資料，以它為準；新聞與經濟數據用網路搜尋查證，並註明日期與來源。
- 搜尋時優先找最近 7 天的消息與數據發表（例如美國 CPI、非農、Fed 利率決議、台灣出口與外銷訂單、央行、法說會、月營收）。
- 評等只能是「買入」「觀望」「離場」三選一，寫在第一行，格式：評等：買入
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
    `App 評分：${s.score}/100（動能 ${Math.round(s.momentum * 100)}、${s.market === "US" ? "趨勢" : "籌碼"} ${Math.round(s.flow * 100)}、族群 ${Math.round(s.sectorScore * 100)}），規則評等：${s.rating}`,
    ...s.reasons.map((r) => `- ${r}`),
  ];
  if (holding) lines.push(`我持有 ${holding.shares} 股，平均成本 ${holding.cost}`);
  return lines.join("\n");
}

async function run(apiKey: string, prompt: string, maxSearches: number): Promise<AiReport> {
  const c = client(apiKey);
  const stream = c.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: BETAS,
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: SYSTEM,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxSearches, user_location: { type: "approximate", country: "TW", timezone: "Asia/Taipei" } }],
    messages: [{ role: "user", content: prompt }],
  });
  return collect(await stream.finalMessage());
}

export function analyzeStock(apiKey: string, s: Scored, today: string, holding?: Holding) {
  const prompt = `今天是 ${today}。請分析這檔股票，並給我評等。

【籌碼與技術數據】
${stockBrief(s, holding)}

請用以下段落回答（每段 2~5 點，條列）：
1. 評等與一句話結論
2. 動能與籌碼解讀（用上面的數據，說明外資／族群是否支持）
3. 近期新聞與公司事件（搜尋最近消息：法說會、營收、訂單、產品）
4. 國內外數據發表的影響（搜尋最近一週發表的總經數據與央行動態，說明對這檔股票的影響）
5. 風險與觀察重點（什麼情況要改變評等，例如跌破哪個價位或外資轉賣）${holding ? "\n6. 針對我的持股：續抱、加碼、減碼或停損的建議" : ""}`;
  return run(apiKey, prompt, 12);
}

export function marketBrief(apiKey: string, today: string, sectorsTw: SectorStat[], sectorsUs: SectorStat[], macro: MacroQuote[], top: Scored[]) {
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
  return run(apiKey, prompt, 12);
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
