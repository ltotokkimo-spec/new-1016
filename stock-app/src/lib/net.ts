// 網路請求：手機上走原生 HTTP（證交所等網站沒有開放跨網域），並依網站限制請求速度。
import { Capacitor, CapacitorHttp } from "@capacitor/core";

export type Fetcher = (url: string) => Promise<any>;

export class HttpError extends Error {
  constructor(public status: number, public url: string, message: string) { super(message); }
}

// 證交所規定 5 秒內超過 3 次會暫時封鎖 IP，所以每次間隔 2 秒
const GAP_MS: Record<string, number> = {
  "www.twse.com.tw": 2000,
  "openapi.twse.com.tw": 800,
  "www.tpex.org.tw": 1000,
  "api.nasdaq.com": 250,
  "quote.cnbc.com": 0,
};
const lastAt = new Map<string, Promise<void>>();

function throttle(host: string): Promise<void> {
  const gap = GAP_MS[host] ?? 300;
  const prev = lastAt.get(host) ?? Promise.resolve();
  const next = prev.then(() => new Promise<void>((r) => setTimeout(r, gap)));
  lastAt.set(host, next);
  return prev;
}

const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";

/** 開發時（瀏覽器）走 Vite 的代理，網址改成 /proxy/<host>/... */
function devUrl(url: string) {
  const u = new URL(url);
  return `/proxy/${u.host}${u.pathname}${u.search}`;
}

export const fetchJson: Fetcher = async (url) => {
  const host = new URL(url).host;
  await throttle(host);
  const headers = { Accept: "application/json, text/plain, */*", "User-Agent": UA };
  for (let attempt = 0; ; attempt++) {
    try {
      if (Capacitor.isNativePlatform()) {
        const r = await CapacitorHttp.get({ url, headers, responseType: "json", connectTimeout: 20000, readTimeout: 60000 });
        if (r.status >= 400) throw new HttpError(r.status, url, `HTTP ${r.status}`);
        return typeof r.data === "string" ? JSON.parse(r.data) : r.data;
      }
      const r = await fetch(devUrl(url), { headers: { Accept: headers.Accept } });
      if (!r.ok) throw new HttpError(r.status, url, `HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      const retryable = !(e instanceof HttpError) || e.status === 429 || e.status >= 500;
      if (attempt >= 2 || !retryable) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
};
