// 數據頁「新聞」分頁（11/12 使用者）：每次打開 App 重抓，整理國內外大事、影響大盤的消息與重大個股。
import { useEffect, useState } from "preact/hooks";
import { agoText, organizeNews, topNews, type NewsCat, type NewsItem, type NewsView } from "../engine/news";
import type { Holding } from "../engine/score";
import { getState, refreshNews, useStore } from "../store";

const CATS: NewsCat[] = ["國際", "台股大盤", "個股"];

function NewsRow({ n, now }: { n: NewsView; now: number }) {
  return (
    <a class="news-item" href={n.url} target="_blank" rel="noreferrer" data-testid="news-item" data-at={n.at}>
      <div class="news-title">{n.mine && <span class="news-tag mine">持股</span>}{n.title}</div>
      {n.summary && n.feed === "mops" && <div class="muted news-sum">{n.summary}</div>}
      <div class="muted news-meta">
        <span data-testid="news-ago">{agoText(n.at, now)}</span>・{n.source}{n.also.length > 0 && <>（另有 {n.also.slice(0, 3).join("、")}{n.also.length > 3 ? " 等" : ""} 報導）</>}
        {n.tags.slice(0, 2).map((t) => <span class="news-tag">{t}</span>)}
        {n.stocks.slice(0, 3).map((s) => <span class="news-tag stock">{s.name}</span>)}
      </div>
    </a>
  );
}

let viewCache: { key: unknown[]; views: NewsView[] } | undefined;
let stockCache: { key: unknown[]; list: { code: string; name: string }[] } | undefined;
function organizedFor(items: NewsItem[], holdings: Holding[], tw: { code: string; name: string }[], prices: Record<string, { name?: string } | undefined>): NewsView[] {
  const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const sk = [holdings, tw, prices];
  if (!stockCache || !same(stockCache.key, sk)) {
    stockCache = { key: sk, list: [...holdings.map((h) => ({ code: h.code, name: h.name })), ...tw.map((s) => ({ code: s.code, name: s.name })), ...Object.entries(prices).map(([code, p]) => ({ code, name: p?.name ?? "" }))] };
  }
  const vk = [items, stockCache.list];
  if (!viewCache || !same(viewCache.key, vk)) {
    viewCache = { key: vk, views: organizeNews(items, { stocks: stockCache.list, mine: holdings.map((h) => h.code) }) };
  }
  return viewCache.views;
}

export function NewsPane() {
  const st = useStore((s) => ({ news: s.news, holdings: s.holdings, tw: s.tw.scored, etf: s.etf.scored, prices: s.prices }));
  const [cat, setCat] = useState<"全部" | NewsCat>("全部");
  const [more, setMore] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [gotNew, setGotNew] = useState<number | undefined>();
  // 「刷新」：馬上重新抓所有來源，抓完說這次多了幾則
  const refresh = async () => {
    const before = new Set(st.news.items.map((x) => x.id));
    setGotNew(undefined);
    await refreshNews();
    setGotNew(getState().news.items.filter((x) => !before.has(x.id)).length);
  };
  // 停在新聞頁時每 3 分鐘重抓一次，「幾分鐘前」每 30 秒更新
  useEffect(() => {
    if (!st.news.at || Date.now() - st.news.at > 60_000) void refreshNews();
    const t = setInterval(() => void refreshNews(), 3 * 60_000);
    const t2 = setInterval(() => setNow(Date.now()), 30_000);
    return () => { clearInterval(t); clearInterval(t2); };
  }, []);
  useEffect(() => setNow(Date.now()), [st.news.at]);
  // 整理結果跟著新聞、持股、股票清單變才重算（11/12 使用者回報切換分頁會停頓：以前每次切回來、每 30 秒都整個重算）
  const views = organizedFor(st.news.items, st.holdings, st.tw, st.prices);
  const top = topNews(views, 6);
  const topIds = new Set(top.map((x) => x.id));
  const list = views.filter((v) => (cat === "全部" ? !topIds.has(v.id) : v.cat === cat) && (v.feed !== "mops" || v.mine || cat === "個股"));
  const shown = more ? list.slice(0, 120) : list.slice(0, 30);
  const failed = (st.news.status ?? []).filter((x) => x.error);
  const mineN = views.filter((v) => v.mine).length;
  return (
    <div data-testid="news-pane">
      <div class="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <div class="muted" style={{ fontSize: "12px" }} data-testid="news-updated">
          {st.news.loading ? "正在抓最新新聞…" : st.news.at ? `${new Date(st.news.at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })} 更新・${views.length} 則（36 小時內）` : "還沒有新聞"}
        </div>
        <button class="btn" style={{ padding: "6px 14px", fontSize: "14px", gap: "6px" }} disabled={st.news.loading} onClick={() => void refresh()} data-testid="news-refresh">
          <svg class={st.news.loading ? "spin" : ""} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5" /></svg>
          {st.news.loading ? "找新聞中…" : "刷新"}
        </button>
      </div>
      {gotNew !== undefined && !st.news.loading && <div class="muted" style={{ fontSize: "12.5px", marginBottom: "6px" }} data-testid="news-gotnew">{gotNew > 0 ? `刷新完成：多了 ${gotNew} 則新消息` : "刷新完成：目前沒有更新的消息"}</div>}
      {top.length > 0 && cat === "全部" && (
        <>
          <div class="section-title"><span>現在最重要</span><span class="muted" style={{ fontSize: "12px", fontWeight: 400 }}>依關鍵字、多家報導、新舊排序</span></div>
          <div class="card news-list" data-testid="news-top">{top.map((n) => <NewsRow n={n} now={now} />)}</div>
        </>
      )}
      <div class="chips" style={{ margin: "12px 0 6px" }} role="group" aria-label="新聞分類">
        {(["全部", ...CATS] as const).map((c) => (
          <button class="chip" aria-pressed={cat === c} onClick={() => { setCat(c); setMore(false); }} data-testid={`news-cat-${c}`}>
            {c}{c !== "全部" ? ` ${views.filter((v) => v.cat === c && (v.feed !== "mops" || v.mine || c === "個股")).length}` : ""}
          </button>
        ))}
      </div>
      {cat === "個股" && <div class="muted" style={{ fontSize: "12px", marginBottom: "6px" }}>含證交所、櫃買中心的上市櫃公司重大訊息；你的持股（{mineN} 則）會排在前面。</div>}
      {shown.length > 0 ? (
        <div class="card news-list" data-testid="news-list">{(cat === "個股" ? [...shown].sort((a, b) => Number(b.mine) - Number(a.mine) || b.at - a.at) : shown).map((n) => <NewsRow n={n} now={now} />)}</div>
      ) : (
        <div class="empty">{st.news.loading ? "正在抓最新新聞…" : "目前沒有新聞（請檢查網路後按「重新整理」）"}</div>
      )}
      {list.length > shown.length && <button class="btn secondary block" style={{ marginTop: "10px" }} onClick={() => setMore(true)}>顯示更多（共 {list.length} 則）</button>}
      <div class="muted" style={{ fontSize: "11.5px", lineHeight: 1.6, marginTop: "10px" }}>
        來源：鉅亨網、Google 新聞（彙整各家媒體）、證交所／櫃買中心重大訊息。依關鍵字自動分類與排序（不用 AI、免費），點標題開啟原文。
        {failed.length > 0 && <><br />這次沒抓到：{failed.map((f) => f.name).join("、")}</>}
      </div>
    </div>
  );
}
