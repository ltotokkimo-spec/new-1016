// 推薦績效追蹤：App 每天評為「買入」的股票，實際之後 5／10／20 個交易日表現如何（雲端每天收盤後記錄、只新增不覆蓋）。
// 和「回測參考」不同：回測是用現在的規則重算過去；這裡是當天就記下來、之後不再改的實際推薦。
import { useEffect, useMemo, useState } from "preact/hooks";
import { BOOK_INFO, firstPickIds, PICK_HORIZONS, sortPerfRows, perfStats, toCsv, type PickBook, type PickH, type PickPerf, type PickPerfFile } from "../engine/pickLog";
import { pretty, prettyW } from "../lib/dates";
import { getState, picksCsvUrl, refreshPicksPerf, useStore } from "../store";
import { fmtPct, fmtPrice, Sheet } from "./common";

const cls = (x?: number) => (x === undefined || !Number.isFinite(x) ? "" : x > 0 ? "up" : x < 0 ? "down" : "");
const pc = (x?: number) => (x === undefined || !Number.isFinite(x) ? "—" : fmtPct(x, 2));
const MIN_N = 30; // 少於這麼多筆就標「樣本不足」
const benchOf = (d?: PickPerfFile) => d?.bench ?? (["加權指數", "0050"] as [string, string]);
const shortBench = (x: string) => x.replace(/指數$/, "").replace(/（.*）$/, "");
/** 「買入」名單 或 ETF「分數前 10 名」 */
const listWord = (b: PickBook) => (BOOK_INFO[b].source === "買入" ? "「買入」名單" : "分數前 10 名");

function copy(text: string, done: (ok: boolean) => void) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* 改用 clipboard API */ }
  ta.remove();
  if (ok) { done(true); return; }
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
  else done(false);
}

/** 選股頁的入口卡片（台股） */
export function PicksPerfCard({ book = "TW" }: { book?: PickBook }) {
  const pp = useStore((s) => s.picksPerf[book]);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); if (!pp || Date.now() - pp.fetchedAt > 3 * 3600_000) refreshPicksPerf(book).catch(() => setFailed(true)); }, [book]);
  const s20 = pp ? perfStats(pp.data.rows, 20) : undefined, s5 = pp ? perfStats(pp.data.rows, 5) : undefined;
  const s = s20 && s20.n ? { h: 20, x: s20 } : s5 && s5.n ? { h: 5, x: s5 } : undefined;
  return (
    <>
      <button class="card" style={{ width: "100%", textAlign: "left", marginTop: "10px", cursor: "pointer", display: "block" }} onClick={() => setOpen(true)} data-testid="picks-perf-card">
        <div class="row" style={{ justifyContent: "space-between" }}>
          <b style={{ fontSize: "14px" }}>推薦績效（實際追蹤{book === "TW" ? "" : `・${BOOK_INFO[book].label}`}）</b>
          <span class="muted" style={{ fontSize: "12px" }}>詳情 ›</span>
        </div>
        <div class="num" style={{ marginTop: "6px", fontSize: "14px", lineHeight: 1.7 }}>
          {!pp ? (failed ? "還沒有資料（雲端第一次記錄後就會出現）" : "下載中…（每個交易日收盤後更新）")
            : !pp.data.rows.length ? `從 ${pretty(pp.data.start || pp.data.dataTo)} 開始記錄，還沒有推薦`
            : s ? <>{s.h} 日勝率 {Math.round(s.x.win * 100)}%・平均淨報酬 <span class={cls(s.x.avg)}>{pc(s.x.avg)}</span>・超額（{shortBench(benchOf(pp.data)[0])}）<span class={cls(s.x.avgExTaiex)}>{pc(s.x.avgExTaiex)}</span></>
            : <>已記錄 {pp.data.rows.length} 筆推薦，滿 5 個交易日後開始統計</>}
        </div>
        <div class="muted" style={{ fontSize: "12px" }}>{pp?.data.start ? `${pretty(pp.data.start)} 起每天記下${listWord(book)}、之後不改${s && s.x.n < MIN_N ? `・樣本 ${s.x.n} 筆，還不夠下結論` : ""}` : `每天收盤後記下${listWord(book)}，之後不改`}</div>
      </button>
      {open && <PicksPerfSheet book={book} onClose={() => setOpen(false)} />}
    </>
  );
}

function Stat({ k, v, c = "", d, id }: { k: string; v: string; c?: string; d?: string; id?: string }) {
  return <div class="metric" data-testid={id}><div class="k">{k}</div><div class={`v num ${c}`}>{v}</div>{d && <div class="d muted">{d}</div>}</div>;
}

export function PicksPerfSheet({ book = "TW", onClose }: { book?: PickBook; onClose: () => void }) {
  const pp = useStore((s) => s.picksPerf[book]);
  // 預設顯示「已經有樣本」裡最長的持有天數（剛開始只有 5 日有資料）
  const [h, setH] = useState<PickH>(() => { const r = getState().picksPerf[book]?.data.rows ?? []; return ([20, 10, 5] as PickH[]).find((x) => r.some((y) => y.h[x])) ?? 5; });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [day, setDay] = useState("");
  const [all, setAll] = useState(false);
  const [firstOnly, setFirstOnlyS] = useState(() => { try { return localStorage.getItem("perfFirstOnly") === "1"; } catch { return false; } });
  const setFirstOnly = (v: boolean) => { setFirstOnlyS(v); try { localStorage.setItem("perfFirstOnly", v ? "1" : "0"); } catch { /* 不記也沒關係 */ } };
  const reload = async () => { setBusy(true); setMsg(""); try { await refreshPicksPerf(book); } catch { setMsg(pp ? "下載失敗，顯示上次的資料" : "還沒有資料：雲端第一次記錄後就會出現"); } setBusy(false); };
  useEffect(() => { if (!pp || Date.now() - pp.fetchedAt > 10 * 60_000) reload(); }, []);
  // 排序：新的日期在前；同一天依分數高到低（和選股頁「買入」名單同一個順序；1.0.284 以前雲端檔案同一天是反過來的，這裡重排）
  const allRows = useMemo(() => sortPerfRows(pp?.data.rows ?? []), [pp]);
  const first = useMemo(() => firstPickIds(allRows), [allRows]);
  const rows = useMemo(() => (firstOnly ? allRows.filter((r) => first.has(r.id)) : allRows), [allRows, first, firstOnly]);
  const st = useMemo(() => perfStats(rows, h), [rows, h]);
  const dates = useMemo(() => [...new Set(rows.map((r) => r.date))], [rows]); // 新到舊
  // 11/13 使用者：看不出收集 5 天後的成果 → 清單預設先列「已有結果」的，最新幾天還在追蹤的放後面
  const [show, setShowS] = useState<"done" | "wait" | "all">("done");
  const doneN = rows.filter((r) => r.h[h]).length;
  const view = show === "all" || !doneN ? rows : rows.filter((r) => (show === "done" ? !!r.h[h] : !r.h[h]));
  const shown = (day ? view.filter((r) => r.date === day) : view).slice(0, all ? undefined : 60);
  // 每天那一批推薦 h 日後的成績（只列已經滿 h 日的日期）
  const byDate = useMemo(() => dates.map((dt) => ({ dt, n: rows.filter((r) => r.date === dt).length, s: perfStats(rows.filter((r) => r.date === dt), h) })).filter((x) => x.s.n > 0), [rows, dates, h]);
  const d = pp?.data;
  return (
    <Sheet title={`推薦績效（實際追蹤${book === "TW" ? "" : `・${BOOK_INFO[book].label}`}）`} onClose={onClose}>
      <div class="stack" data-testid="picks-perf">
        <div class="seg" role="group" aria-label="持有天數">
          {PICK_HORIZONS.map((x) => <button aria-pressed={h === x} onClick={() => setH(x)} data-testid={`perf-h-${x}`}>持有 {x} 日</button>)}
        </div>
        <div class="seg" role="group" aria-label="計算範圍">
          <button aria-pressed={!firstOnly} onClick={() => setFirstOnly(false)} data-testid="perf-all">每天都算</button>
          <button aria-pressed={firstOnly} onClick={() => setFirstOnly(true)} data-testid="perf-first">只看首次推薦</button>
        </div>
        <div class="muted" style={{ fontSize: "12px", marginTop: "-4px" }} data-testid="perf-scope">
          {firstOnly ? `連續在${listWord(book)}的只算進入名單那天；掉出後再回來算新的一次（${rows.length}／${allRows.length} 筆）` : `每天的${listWord(book)}每檔各算一筆，連續上榜的會被算好幾次（${allRows.length} 筆）`}
        </div>
        {!d ? <div class="empty">{busy ? "下載中…" : "還沒有資料"}</div> : <>
          <div class="card" style={{ fontSize: "14.5px", lineHeight: 1.7 }} data-testid="perf-headline">
            {st.n ? <><b>成果：</b>已滿 {h} 個交易日的 <b>{st.n}</b> 筆推薦，買進後持有 {h} 天平均每筆 <b class={cls(st.avg)}>{pc(st.avg)}</b>（已扣成本），<b>{Math.round(st.win * 100)}%</b> 賺錢；
              比同期{benchOf(d)[0]} <b class={cls(st.avgExTaiex)}>{st.avgExTaiex !== undefined && st.avgExTaiex >= 0 ? "多賺" : "少賺"} {pc(Math.abs(st.avgExTaiex ?? NaN)).replace(/^\+/, "")}</b>。
              {rows.length - doneN > 0 && <span class="muted">另有 {rows.length - doneN} 筆還在追蹤（推薦後未滿 {h} 天）。</span>}</>
              : <>還沒有推薦滿 {h} 個交易日，第一批結果要等推薦後 {h} 個交易日才算得出來。</>}
          </div>
          <div class="grid2" data-testid="perf-stats">
            <Stat k="總筆數" v={`${st.n} 筆`} d={`已滿 ${h} 個交易日／${firstOnly ? "首次推薦" : "全部"} ${rows.length} 筆`} id="perf-n" />
            <Stat k="勝率" v={st.n ? `${Math.round(st.win * 100)}%` : "—"} d="扣成本後淨報酬 > 0 的比例" id="perf-win" />
            <Stat k="平均淨報酬" v={pc(st.avg)} c={cls(st.avg)} d={book === "US" ? "已扣複委託手續費" : "已扣手續費、證交稅"} id="perf-avg" />
            <Stat k="平均超額報酬" v={pc(st.avgExTaiex)} c={cls(st.avgExTaiex)} d={`對${benchOf(d)[0]}（同期平均 ${pc(st.benchTaiex)}）；對 ${benchOf(d)[1]} ${pc(st.avgEx0050)}`} id="perf-ex" />
            <Stat k="最大單筆虧損" v={st.worst ? pc(st.worst.net) : "—"} c={st.worst ? "down" : ""} d={st.worst ? `${st.worst.name} ${st.worst.code}（${pretty(st.worst.date)} 推薦）` : st.n ? "沒有虧損的推薦" : "還沒有樣本"} id="perf-worst" />
            <Stat k="觸及停損比例" v={st.n ? `${Math.round(st.stopRate * 100)}%` : "—"} d={`期間收盤跌破推薦價 −8%；照停損出場平均 ${pc(st.avgStopNet)}`} id="perf-stop" />
          </div>
          {st.n < MIN_N && <div class="notice" data-testid="perf-few">樣本只有 {st.n} 筆（滿 {h} 個交易日的推薦），少於 {MIN_N} 筆，數字波動很大，還不能下結論。{h === 20 ? "20 日要推薦後一個月才算得出來。" : ""}</div>}

          <div class="card stack" style={{ fontSize: "12.5px", lineHeight: 1.65 }} data-testid="perf-source">
            <div><b>記錄方式</b>：{d.rule}</div>
            <div><b>資料來源</b>：{d.source}</div>
            <div><b>日期</b>：{d.start ? `${prettyW(d.start)} 開始記錄` : "還沒開始"}・最新資料日 {prettyW(d.dataTo)}・下載於 {new Date(pp!.fetchedAt).toLocaleString("zh-TW", { hour12: false })}</div>
            <div><b>成本</b>：{d.currency === "USD"
              ? `每筆以 ${d.cost.notional.toLocaleString()} 美元試算（可買小數股）；複委託手續費買賣各 ${(d.cost.feeRate * 100).toFixed(1)}%、沒有最低；美股沒有證交稅；不含匯差與股利。`
              : `每筆以 ${d.cost.notional.toLocaleString()} 元試算（大多是零股）；手續費 ${(d.cost.feeRate * 100).toFixed(4)}%，整股最低 ${d.cost.feeMinLot} 元、零股最低 ${d.cost.feeMinOdd} 元；賣出證交稅股票 ${(d.cost.taxStock * 100).toFixed(1)}%、ETF ${(d.cost.taxEtf * 100).toFixed(1)}%。`}</div>
            <div><b>停損</b>：推薦價 −{Math.round(d.cost.stop * 100)}%。只有每日收盤資料，所以用收盤價判斷有沒有跌破，並用那天收盤出場試算。{benchOf(d).join("與 ")} 的報酬不含成本。</div>
            <div class="muted">{book === "TW" ? "和上面的「回測參考」不同：回測是用現在的規則重算過去；這裡是" : "這裡是"}每天當下就記下來、之後不再改動的實際{book === "ETF" ? "名單（ETF 分數只當參考）" : "推薦"}。過去表現不代表未來。</div>
            {pp?.error && <div class="muted">{pp.error}</div>}
          </div>

          <div class="row" style={{ gap: "8px", flexWrap: "wrap" }}>
            <a class="btn secondary" href={picksCsvUrl(book)} target="_blank" rel="noreferrer" data-testid="perf-csv-dl">下載 CSV</a>
            <button class="btn secondary" onClick={() => copy(toCsv({ ...d, rows }), (ok) => setMsg(ok ? `已複製 ${rows.length} 筆${firstOnly ? "首次推薦" : ""}（CSV），可以貼到 Excel 或 Google 試算表` : "複製失敗，請改用「下載 CSV」"))} data-testid="perf-csv-copy">複製 CSV</button>
            <button class="btn secondary" onClick={reload} disabled={busy} data-testid="perf-reload">{busy ? "更新中…" : "重新下載"}</button>
          </div>
          {msg && <div class="muted" style={{ fontSize: "12.5px" }} data-testid="perf-msg">{msg}</div>}

          {byDate.length > 0 && <>
            <div class="section-title"><span>每天的推薦 {h} 日後成績</span><span class="muted" style={{ fontSize: "12px", fontWeight: 400 }}>點日期看那天每一筆</span></div>
            <table class="sectors" data-testid="perf-bydate">
              <thead><tr><th style={{ textAlign: "left" }}>推薦日</th><th>筆數</th><th>平均</th><th>賺錢</th><th>比{benchOf(d)[0].replace(/指數$/, "")}</th></tr></thead>
              <tbody>{byDate.slice(0, 20).map((x) => (
                <tr style={{ cursor: "pointer" }} onClick={() => { setDay(x.dt); setShowS("all"); setTimeout(() => document.querySelector('[data-testid="perf-rows"]')?.scrollIntoView({ behavior: "smooth" }), 50); }}>
                  <td style={{ textAlign: "left" }}>{prettyW(x.dt)}</td><td class="num">{x.s.n}</td><td class={`num ${cls(x.s.avg)}`}>{pc(x.s.avg)}</td><td class="num">{Math.round(x.s.win * 100)}%</td><td class={`num ${cls(x.s.avgExTaiex)}`}>{pc(x.s.avgExTaiex)}</td>
                </tr>))}</tbody>
            </table>
          </>}

          <div class="section-title"><span>每筆推薦<span class="muted" style={{ fontWeight: 400, fontSize: "12px" }}>（新→舊，同日分數高→低）</span></span>
            <select value={day} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setDay(v); if (v) setShowS("all"); }} data-testid="perf-day" style={{ fontSize: "13px" }}>
              <option value="">全部日期（{rows.length} 筆）</option>
              {dates.map((x) => <option value={x}>{prettyW(x)}（{rows.filter((r) => r.date === x).length} 筆）</option>)}
            </select>
          </div>
          <div class="chips" role="group" aria-label="清單範圍">
            <button class="chip" aria-pressed={show === "done"} onClick={() => setShowS("done")} data-testid="perf-show-done">已有 {h} 日結果 {doneN}</button>
            <button class="chip" aria-pressed={show === "wait"} onClick={() => setShowS("wait")} data-testid="perf-show-wait">追蹤中 {rows.length - doneN}</button>
            <button class="chip" aria-pressed={show === "all"} onClick={() => setShowS("all")}>全部</button>
          </div>
          <div class="list" data-testid="perf-rows">
            {shown.map((r) => <PerfRow r={r} h={h} first={!firstOnly && first.has(r.id)} usd={d.currency === "USD"} />)}
          </div>
          {!all && (day ? view.filter((r) => r.date === day).length : view.length) > 60 && <button class="chip" onClick={() => setAll(true)}>顯示全部</button>}
        </>}
      </div>
    </Sheet>
  );
}

function PerfRow({ r, h, first, usd }: { r: PickPerf; h: PickH; first?: boolean; usd?: boolean }) {
  const px = (x: number) => (usd ? "$" : "") + fmtPrice(x);
  const x = r.h[h];
  return (
    <div class="item" style={{ cursor: "default" }} data-testid="perf-row">
      <div style={{ minWidth: 0 }}>
        <div class="name">{r.name} <span class="muted num" style={{ fontWeight: 400, fontSize: "13px" }}>{r.code}</span>{first && <span class="tag" style={{ marginLeft: "6px", fontSize: "11px", fontWeight: 400 }}>首次</span>}</div>
        <div class="sub num" style={{ whiteSpace: "normal" }}>{pretty(r.date)} 推薦 {px(r.price)}・停損 {px(r.stop)}・分數 {r.score}{x?.stopHit ? <span class="down">・{pretty(x.stopDate!)} 跌破停損</span> : ""}</div>
        <div class="sub" style={{ whiteSpace: "normal", fontSize: "11.5px" }}>{r.reasons.join("；")}</div>
      </div>
      <div class="px">
        {x ? <>
          <div class={`p num ${cls(x.net)}`}><span class="lbl">{h} 日</span>{pc(x.net)}</div>
          <div class={`c num ${cls(x.exTaiex)}`}><span class="lbl">超額</span>{pc(x.exTaiex)}</div>
        </> : <>
          <div class={`p num ${cls(r.curNet)}`}><span class="lbl">至今</span>{pc(r.curNet)}</div>
          <div class="c num muted">{r.elapsed}/{h} 天</div>
        </>}
      </div>
      <div />
    </div>
  );
}
