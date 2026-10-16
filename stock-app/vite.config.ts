import { defineConfig, type Plugin } from "vite";
import preact from "@preact/preset-vite";
import fs from "node:fs";
import path from "node:path";

// 開發用：/proxy/<host>/<path> 轉發到真實網站；設定 FIXTURE_DIR 時改用存下來的真實回應（本機連不到交易所時用）
function devProxy(): Plugin {
  return {
    name: "dev-proxy",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/proxy/")) return next();
        const rest = req.url.slice("/proxy/".length);
        const target = "https://" + rest;
        const dir = process.env.FIXTURE_DIR;
        try {
          if (dir) {
            const file = fixtureFor(dir, target);
            if (!file) { res.statusCode = 404; return res.end("no fixture for " + target); }
            res.setHeader("content-type", "application/json");
            return res.end(fs.readFileSync(file));
          }
          const r = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
          res.statusCode = r.status;
          res.setHeader("content-type", r.headers.get("content-type") ?? "application/json");
          res.end(Buffer.from(await r.arrayBuffer()));
        } catch (e: any) { res.statusCode = 502; res.end(String(e?.message ?? e)); }
      });
    },
  };
}

function fixtureFor(dir: string, url: string): string | null {
  const u = new URL(url);
  const q = u.searchParams;
  const d8 = (q.get("date") ?? "").replace(/\//g, "");
  const pick = (name: string) => {
    const f = path.join(dir, name);
    return fs.existsSync(f) ? f : null;
  };
  if (u.pathname.includes("/fund/T86")) return pick(`t86_${d8}.json`) ?? pick("nodata_twse.json");
  if (u.pathname.includes("MI_INDEX")) return pick(`twseq_${d8}.json`) ?? pick("nodata_twse.json");
  if (u.pathname.includes("dailyQuotes")) return pick(`tpexq_${d8}.json`) ?? pick("nodata_tpex.json");
  if (u.pathname.includes("insti/dailyTrade")) return pick(`tpexf_${d8}.json`) ?? pick("nodata_tpex.json");
  if (u.pathname.includes("t187ap03_L")) return pick("companies_twse.json");
  if (u.pathname.includes("t187ap03_O")) return pick("companies_tpex.json");
  if (u.host === "api.nasdaq.com") return pick(`nasdaq_${u.pathname.split("/")[3].replace(".", "")}.json`) ?? pick("nasdaq_AAPL.json");
  if (u.host === "quote.cnbc.com") return pick("cnbc_macro.json");
  if (u.pathname.includes("STOCK_DAY")) return pick("twse_stock_day.json");
  if (u.pathname.includes("tradingStock")) return pick("tpex_stock_hist.json");
  return null;
}

export default defineConfig({
  plugins: [preact(), devProxy()],
  base: "./",
  build: { outDir: "dist", target: "es2020" },
});
