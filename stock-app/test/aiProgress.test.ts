import { describe, expect, it } from "vitest";
import { newProgress, nextProgress } from "../src/ai/claude";

// 模擬 Claude 串流：思考 → 兩次網路搜尋（查詢字串分段送）→ 讀結果 → 分段寫報告
const events: any[] = [
  { type: "message_start", message: {} },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "s1", name: "web_search", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query": "友達 9月' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '營收"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "web_search_tool_result", tool_use_id: "s1", content: [] } },
  { type: "content_block_stop", index: 2 },
  { type: "content_block_start", index: 3, content_block: { type: "server_tool_use", id: "s2", name: "web_search", input: { query: "Fed 利率決議 10月" } } },
  { type: "content_block_stop", index: 3 },
  { type: "content_block_start", index: 4, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 4, delta: { type: "text_delta", text: "評等：觀望\n\n### 1. 評等與一句話結論\n- 先觀望\n\n" } },
  { type: "content_block_delta", index: 4, delta: { type: "text_delta", text: "**3. 近期新聞與公司事件**\n- 9月營收月增" } },
];

describe("Claude 解析進度", () => {
  it("依事件更新階段、搜尋次數、關鍵字、段落與字數", () => {
    let { p, scratch } = newProgress();
    const seen: any[] = [];
    for (const ev of events) { p = nextProgress(p, ev, scratch); seen.push({ ...p }); }
    expect(seen[1].phase).toBe("thinking");
    expect(seen[3]).toMatchObject({ phase: "searching", searches: 1 });
    expect(seen[6].lastQuery).toBe("友達 9月營收"); // 分段的查詢字串在區塊結束時組回來
    expect(seen[7].phase).toBe("reading");
    expect(seen[9]).toMatchObject({ phase: "searching", searches: 2, lastQuery: "Fed 利率決議 10月" });
    expect(seen[12]).toMatchObject({ phase: "writing", section: "1. 評等與一句話結論" });
    expect(p.section).toBe("3. 近期新聞與公司事件");
    expect(p.chars).toBe(events[12].delta.text.length + events[13].delta.text.length);
  });

  it("壞掉的查詢 JSON 不會出錯", () => {
    let { p, scratch } = newProgress();
    p = nextProgress(p, { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", name: "web_search", input: {} } }, scratch);
    p = nextProgress(p, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query": "abc' } }, scratch);
    p = nextProgress(p, { type: "content_block_stop", index: 0 }, scratch);
    expect(p).toMatchObject({ searches: 1, phase: "searching" });
    expect(p.lastQuery).toBeUndefined();
  });
});

describe("使用者貼的新聞與搜尋紀錄", () => {
  it("從貼上的文字取出網址（最多 3 個、去重、去掉結尾標點）", async () => {
    const { parseUrls } = await import("../src/ai/claude");
    const t = "看這篇 https://www.ctee.com.tw/news/20261017700123-430201。還有 https://a.com/x) 和 https://a.com/x 以及 https://b.com https://c.com";
    expect(parseUrls(t)).toEqual(["https://www.ctee.com.tw/news/20261017700123-430201", "https://a.com/x", "https://b.com"]);
    expect(parseUrls("沒有網址")).toEqual([]);
  });

  it("報告記下搜尋關鍵字與讀過的文章", async () => {
    const { collect } = await import("../src/ai/claude");
    const r = collect({
      model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        { type: "server_tool_use", id: "f", name: "web_fetch", input: { url: "https://www.ctee.com.tw/news/1" } },
        { type: "web_fetch_tool_result", tool_use_id: "f", content: { type: "web_fetch_result", url: "https://www.ctee.com.tw/news/1" } },
        { type: "server_tool_use", id: "s", name: "web_search", input: { query: "穎崴 高盛 目標價" } },
        { type: "text", text: "評等：觀望\n內容", citations: null },
      ],
    } as any);
    expect(r.queries).toEqual(["穎崴 高盛 目標價"]);
    expect(r.fetched).toEqual(["https://www.ctee.com.tw/news/1"]);
  });

  it("讀文章時顯示讀取中", () => {
    let { p, scratch } = newProgress();
    p = nextProgress(p, { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", name: "web_fetch", input: {} } }, scratch);
    expect(p.phase).toBe("fetching");
    p = nextProgress(p, { type: "content_block_start", index: 1, content_block: { type: "web_fetch_tool_result" } }, scratch);
    expect(p.phase).toBe("reading");
  });
});
