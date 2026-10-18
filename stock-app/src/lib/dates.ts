// 日期一律用台北時間的 YYYYMMDD 字串，避免手機或模擬器時區不同造成錯日。
const DAY = 86_400_000;

export function taipeiToday(now = Date.now()): string {
  const d = new Date(now + 8 * 3600_000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 台北時間的小時（0~23） */
export function taipeiHour(now = Date.now()): number {
  return new Date(now + 8 * 3600_000).getUTCHours();
}

export function toUtcDate(ymd: string): Date {
  return new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
}

export function fromUtcDate(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function addDays(ymd: string, n: number): string {
  return fromUtcDate(new Date(toUtcDate(ymd).getTime() + n * DAY));
}

export function isWeekday(ymd: string): boolean {
  const w = toUtcDate(ymd).getUTCDay();
  return w !== 0 && w !== 6;
}

/** 從 ymd（含）往前的平日，最多 n 個 */
export function weekdaysBack(ymd: string, n: number): string[] {
  const out: string[] = [];
  let d = ymd;
  while (out.length < n) {
    if (isWeekday(d)) out.push(d);
    d = addDays(d, -1);
  }
  return out;
}

export const dash = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
export const pretty = (ymd: string) => `${+ymd.slice(4, 6)}/${+ymd.slice(6, 8)}`;

const WEEK = "日一二三四五六";
/** 10/16（五） */
export function prettyW(ymd: string): string {
  return `${+ymd.slice(4, 6)}/${+ymd.slice(6, 8)}（${WEEK[toUtcDate(ymd).getUTCDay()]}）`;
}

/**
 * 依收盤資料日期，建議的下單日：資料日之後的第一個平日；
 * 如果那天已經過了（或今天已收盤 13:30 後），就往後找。國定假日沒有列入，遇到要順延。
 */
export function orderDay(asOf: string, now = Date.now()): string {
  const today = taipeiToday(now);
  const d8 = new Date(now + 8 * 3600_000);
  const closed = d8.getUTCHours() * 60 + d8.getUTCMinutes() >= 13 * 60 + 30;
  let d = addDays(asOf, 1);
  while (!isWeekday(d) || d < today || (d === today && closed)) d = addDays(d, 1);
  return d;
}
