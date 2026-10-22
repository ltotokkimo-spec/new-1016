// 證交所「每日市場成交資訊」（FMTQIK）：每個交易日的大盤成交股數、成交金額、成交筆數，是官方公布的全市場合計
// （含股票、ETF、權證、受益憑證等，和電視與看盤軟體的「成交金額」同一個口徑）。收盤後約 14:00 起有當天的資料。
export interface Turnover { date: string; value: number } // date：YYYYMMDD；value：成交金額（元）

export const twTurnoverUrl = (ymd: string) => `https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${ymd}&response=json`;

const num = (x: unknown) => Number(String(x ?? "").replace(/,/g, ""));

/** 民國日期 115/10/21 → 20261021 */
function rocToYmd(s: string): string | undefined {
  const m = /^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/.exec(String(s).trim());
  return m ? `${+m[1] + 1911}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}` : undefined;
}

/** 回傳該月份最新一個交易日的成交金額；沒有資料（例如月初還沒收盤）回傳 undefined */
export function parseTurnover(json: any): Turnover | undefined {
  if (!json || json.stat !== "OK" || !Array.isArray(json.data) || !Array.isArray(json.fields)) return undefined;
  const iDate = json.fields.indexOf("日期"), iVal = json.fields.indexOf("成交金額");
  if (iDate < 0 || iVal < 0) return undefined;
  let best: Turnover | undefined;
  for (const r of json.data) {
    const date = rocToYmd(r[iDate]), value = num(r[iVal]);
    if (date && value > 0 && (!best || date > best.date)) best = { date, value };
  }
  return best;
}
