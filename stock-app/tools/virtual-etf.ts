// Claude 每日虛擬操作用的指令工具。用法（在 stock-app 目錄）：
//   node --experimental-strip-types tools/virtual-etf.ts <指令> <state.json> [參數]
//   init  <state> <開始日YYYYMMDD>
//   fill  <state> <日期> <quotes.json>   用當天開高低成交前一天的委託
//   close <state> <日期> <quotes.json>   收盤後記淨值、檢查停損（自動排隔天賣出）
//   order <state> <日期> <orders.json>   加入隔天的委託 [{code,name,side,shares,limit?,stop?,reason}]
//   note  <state> <日期> <文字>          記一則當天的操作說明
//   topup <state> <日期> <加碼後資金>     資金加碼（例如 500000）
//   cash  <state> <日期> <大盤距20日高點> <說明>  資金水位（例如 -0.059；跌 5% 起 8 成、10% 起 9 成）
//   dividend <state> <除息日> <代號> <每股配息>  配息入帳（除息日前一天收盤持有的股數 × 每股配息；0050 也會記進對照組）
//   show  <state>                        印出目前狀態
// quotes.json 格式：{"2027":{"name":"大成鋼","open":50.7,"high":51.1,"low":50.1,"close":50.8}, "0050": {...}}
import { readFileSync, writeFileSync } from "node:fs";
import { addNote, cashLevel, closeDay, fillPending, newVirtual, placeOrders, recordDividend, setCashPlan, topUp, type VirtualEtf } from "../src/engine/virtualEtf.ts";
import { positions, valuate } from "../src/engine/aiEtf.ts";

const [cmd, file, a, b] = process.argv.slice(2);
const load = (): VirtualEtf => JSON.parse(readFileSync(file, "utf8"));
const save = (v: VirtualEtf) => { writeFileSync(file, JSON.stringify(v, null, 1)); show(v); };
const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const ymd = (d: string) => { if (!/^\d{8}$/.test(d ?? "")) throw new Error(`日期要是 YYYYMMDD：${d}`); return d; };

function show(v: VirtualEtf) {
  const val = valuate(v, (c) => v.last[c]?.close);
  console.log(`資料日 ${v.asOf || "—"}｜淨值 ${Math.round(val.nav)}（${(val.ret * 100).toFixed(2)}%）｜0050 對照 ${Math.round(val.bench)}（${(val.benchRet * 100).toFixed(2)}%）｜現金 ${Math.round(val.cash)}`);
  const lv = cashLevel(v.cashPlan, val.nav, val.marketValue);
  console.log(`資金水位：股票 ${(lv.stock * 100).toFixed(0)}%／現金 ${(lv.cash * 100).toFixed(0)}%｜目標股票 ${(lv.target * 100).toFixed(0)}%（${lv.label}${v.cashPlan ? `，大盤距 20 日高點 ${(v.cashPlan.drawdown * 100).toFixed(1)}%，${v.cashPlan.date}` : ""}）｜${lv.room >= 0 ? `還可買 ${Math.round(lv.room)}` : `超出 ${Math.round(-lv.room)}`}`);
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
  case "topup": save(topUp(load(), ymd(a), Number(b))); break;
  case "dividend": save(recordDividend(load(), ymd(a), b, Number(process.argv[6]))); break;
  case "cash": save(setCashPlan(load(), ymd(a), Number(b), process.argv.slice(6).join(" "))); break;
  case "show": show(load()); break;
  default: console.log("指令：init / fill / close / order / note / topup / dividend / cash / show"); process.exit(1);
}
