// Claude 每日虛擬操作用的指令工具。用法（在 stock-app 目錄）：
//   node --experimental-strip-types tools/virtual-etf.ts <指令> <state.json> [參數]
//   init  <state> <開始日YYYYMMDD>
//   fill  <state> <日期> <quotes.json>   用當天開高低成交前一天的委託
//   close <state> <日期> <quotes.json>   收盤後記淨值、檢查停損（自動排隔天賣出）
//   order <state> <日期> <orders.json>   加入隔天的委託 [{code,name,side,shares,limit?,stop?,reason}]
//   note  <state> <日期> <文字>          記一則當天的操作說明
//   show  <state>                        印出目前狀態
// quotes.json 格式：{"2027":{"name":"大成鋼","open":50.7,"high":51.1,"low":50.1,"close":50.8}, "0050": {...}}
import { readFileSync, writeFileSync } from "node:fs";
import { addNote, closeDay, fillPending, newVirtual, placeOrders, type VirtualEtf } from "../src/engine/virtualEtf.ts";
import { positions, valuate } from "../src/engine/aiEtf.ts";

const [cmd, file, a, b] = process.argv.slice(2);
const load = (): VirtualEtf => JSON.parse(readFileSync(file, "utf8"));
const save = (v: VirtualEtf) => { writeFileSync(file, JSON.stringify(v, null, 1)); show(v); };
const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const ymd = (d: string) => { if (!/^\d{8}$/.test(d ?? "")) throw new Error(`日期要是 YYYYMMDD：${d}`); return d; };

function show(v: VirtualEtf) {
  const val = valuate(v, (c) => v.last[c]?.close);
  console.log(`資料日 ${v.asOf || "—"}｜淨值 ${Math.round(val.nav)}（${(val.ret * 100).toFixed(2)}%）｜0050 對照 ${Math.round(val.bench)}（${(val.benchRet * 100).toFixed(2)}%）｜現金 ${Math.round(val.cash)}`);
  for (const p of positions(v.trades).filter((x) => x.shares > 0))
    console.log(`  持股 ${p.code} ${p.name} ${p.shares} 股 均價 ${p.avgCost.toFixed(2)} 收盤 ${v.last[p.code]?.close ?? "?"} 停損 ${v.stops?.[p.code] ?? "—"}`);
  for (const o of v.pending) console.log(`  委託 ${o.side === "buy" ? "買" : "賣"} ${o.code} ${o.name} ${o.shares} 股${o.limit ? ` 限價 ${o.limit}` : ""}｜${o.reason}`);
  if (val.missing.length) console.log(`  ⚠ 缺收盤價：${val.missing.join("、")}`);
}

switch (cmd) {
  case "init": writeFileSync(file, JSON.stringify(newVirtual(ymd(a)), null, 1)); console.log("已建立"); break;
  case "fill": save(fillPending(load(), ymd(a), json(b))); break;
  case "close": save(closeDay(load(), ymd(a), json(b))); break;
  case "order": save(placeOrders(load(), ymd(a), json(b))); break;
  case "note": save(addNote(load(), ymd(a), process.argv.slice(5).join(" "))); break;
  case "show": show(load()); break;
  default: console.log("指令：init / fill / close / order / note / show"); process.exit(1);
}
