// 在 Android 模擬器上實際安裝 APK、連真實網路，操作 App 並檢查畫面上的真實數據。
// 截圖以 base64 印在紀錄裡（=====BEGIN name=====），方便不下載也能檢查。
const { _android: android } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");

const PKG = "tw.ltotokkimo.stockradar";
const apk = process.argv[2];
const shots = [];
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...a);

// 任何一步卡住都不能讓整個測試無限等待
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} 超過 ${ms / 1000} 秒沒有回應`)), ms))]);
let dumpAndExit = null;
setTimeout(() => { log("整體測試超過 20 分鐘，停止並輸出目前結果"); process.exitCode = 1; dumpAndExit?.(); }, 20 * 60_000).unref();

function check(ok, name, detail = "") {
  results.push({ ok, name, detail });
  log(ok ? "通過" : "失敗", name, detail);
  if (!ok) throw new Error(`${name}：${detail}`);
}

(async () => {
  execSync(`adb install -r ${apk}`, { stdio: "inherit", timeout: 180_000 });
  log("APK 已安裝");
  const [device] = await withTimeout(android.devices(), 60_000, "連接模擬器");
  check(!!device, "找到模擬器");
  const shot = async (name) => {
    const buf = await device.screenshot();
    shots.push([name, buf]);
    log("截圖", name, buf.length);
  };
  await device.shell(`am start -n ${PKG}/.MainActivity`);
  const webview = await withTimeout(device.webView({ pkg: PKG }), 90_000, "等待 App 的 WebView");
  const page = await withTimeout(webview.page(), 60_000, "連接 WebView 頁面");
  log("已連上 App 畫面");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${m.text()} @ ${m.location()?.url || "?"}`); });
  page.on("response", (r) => { if (r.status() >= 400) log("HTTP", r.status(), r.url()); });
  await sleep(3000);
  await shot("01-啟動下載中");

  // ---------- 台股：真實證交所／櫃買資料 ----------
  await page.waitForSelector(".item", { timeout: 8 * 60_000 });
  log("台股資料載入完成", JSON.stringify(await page.evaluate(() => window.__srTimings)));
  await sleep(800);
  const tw = await page.evaluate(() => ({
    asof: document.querySelector(".asof")?.textContent,
    chips: [...document.querySelectorAll(".chips .chip")].map((c) => c.textContent),
    rows: [...document.querySelectorAll(".item")].slice(0, 8).map((r) => r.innerText.replace(/\s+/g, " ")),
  }));
  log("台股", JSON.stringify(tw));
  check(/台股資料 \d+\/\d+/.test(tw.asof || ""), "顯示台股資料日期", tw.asof);
  const total = Number(/全部 (\d+)/.exec(tw.chips.join(" "))?.[1] || 0);
  check(total > 300, "全市場評分股票數量合理", `全部 ${total} 檔`);
  check(tw.rows.length > 0 && tw.rows.every((r) => /(買入|觀望|離場)/.test(r) && /\d+ 分/.test(r)), "每列都有評等與分數", tw.rows[0]);
  await shot("02-選股-台股");

  // 個股詳細：真實日K走勢
  await page.click(".item");
  await page.waitForSelector(".sheet", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector("canvas.chart") || /走勢圖下載失敗|沒有走勢資料/.test(document.body.innerText), null, { timeout: 120000 });
  const detail = await page.evaluate(() => ({ title: document.querySelector(".sheet h2")?.textContent, text: document.querySelector(".sheet .body").innerText.slice(0, 400), chart: !!document.querySelector("canvas.chart") }));
  log("個股", JSON.stringify(detail));
  check(detail.chart, "個股走勢圖有畫出來", detail.title);
  check(/外資近 5 日/.test(detail.text) && /評等理由/.test(detail.text), "個股顯示外資籌碼與評等理由");
  await sleep(600);
  await shot("03-個股詳細");
  await page.click('button[aria-label="返回"]');

  // 族群
  await page.click("nav.tabs button:nth-child(2)");
  await page.waitForSelector("table.sectors tbody tr", { timeout: 10000 });
  const sectors = await page.$$eval("table.sectors tbody tr", (rows) => rows.map((r) => r.innerText.replace(/\s+/g, " ")));
  log("族群", JSON.stringify(sectors.slice(0, 6)));
  check(sectors.length >= 10, "族群表至少 10 個產業", `${sectors.length} 個`);
  check(sectors.some((r) => r.includes("半導體")), "族群表包含半導體");
  await shot("04-族群輪動");

  // 數據：CNBC 國際指標＋證交所指數
  await page.click("nav.tabs button:nth-child(4)");
  await page.waitForFunction(() => document.querySelectorAll(".metric").length >= 8, null, { timeout: 60000 });
  const macro = await page.$$eval(".metric", (ms) => ms.map((m) => m.innerText.replace(/\s+/g, " ")));
  log("數據", JSON.stringify(macro.slice(0, 12)));
  check(macro.some((m) => m.includes("加權指數")), "顯示台股加權指數");
  check(macro.some((m) => m.includes("S&P 500")) && macro.some((m) => m.includes("美債 10 年")), "顯示美股與美債殖利率");
  await shot("05-國內外數據");

  // 持股：手動新增台積電，檢查損益
  await page.click("nav.tabs button:nth-child(3)");
  await page.click("text=手動新增");
  await page.fill("#h-code", "2330");
  await page.fill("#h-shares", "1000");
  await page.fill("#h-cost", "2000");
  await page.click("text=儲存");
  await page.waitForSelector(".list .item", { timeout: 10000 });
  const hold = await page.$eval(".list .item", (e) => e.innerText.replace(/\s+/g, " "));
  log("持股", hold);
  check(/台積電/.test(hold) && /(買入|觀望|離場)/.test(hold) && /%/.test(hold), "持股顯示現價、損益與評等", hold);
  await shot("06-持股健檢");

  // 重開 App：持股仍在（存在手機裡）
  const oldPid = webview.pid();
  await device.shell(`am force-stop ${PKG}`);
  await sleep(3000);
  await device.shell(`am start -n ${PKG}/.MainActivity`);
  let wv2 = null;
  for (let i = 0; i < 30 && !wv2; i++) {
    const w = await withTimeout(device.webView({ pkg: PKG }), 90_000, "等待重開後的 WebView");
    if (w.pid() !== oldPid) wv2 = w; else await sleep(1000);
  }
  check(!!wv2, "重開 App");
  const page2 = await withTimeout(wv2.page(), 60_000, "連接重開後的頁面");
  page2.on("pageerror", (e) => errors.push(e.message));
  await page2.waitForSelector("nav.tabs", { timeout: 60000 });
  await page2.click("nav.tabs button:nth-child(3)");
  await page2.waitForSelector(".list .item", { timeout: 30000 });
  check(/台積電/.test(await page2.$eval(".list .item", (e) => e.innerText)), "重開 App 後持股還在");

  // 美股：真實 Nasdaq 資料
  await page2.click("nav.tabs button:nth-child(1)");
  await page2.click(".seg button:nth-child(2)");
  await page2.waitForFunction(() => /全部 [1-9]\d/.test(document.body.innerText), null, { timeout: 6 * 60_000 });
  await page2.click(".chips button:nth-child(4)");
  await page2.waitForSelector(".item", { timeout: 10000 });
  const us = await page2.$$eval(".item", (rs) => rs.slice(0, 6).map((r) => r.innerText.replace(/\s+/g, " ")));
  log("美股", JSON.stringify(us));
  check(us.length >= 6, "美股清單有資料", us[0]);
  const prices = new Set(us.map((r) => /(\d[\d,]*\.\d\d)/.exec(r)?.[1]));
  check(prices.size >= 4, "美股各檔價格不同（是真實資料）", [...prices].join(" "));
  await shot("07-選股-美股");

  // ---------- Claude AI（有提供金鑰才測） ----------
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    await page2.click("nav.tabs button:nth-child(5)");
    await page2.fill("#api-key", key);
    await page2.click("text=測試金鑰");
    await page2.waitForFunction(() => /金鑰可以使用|金鑰無效|權限|額度|連不到/.test(document.body.innerText), null, { timeout: 60000 });
    const keyMsg = await page2.$eval(".notice", (e) => e.innerText);
    check(/金鑰可以使用/.test(keyMsg), "Claude API 金鑰測試", keyMsg);

    // 照片匯入：在 App 裡畫一張券商庫存截圖，送進同一套辨識流程
    await page2.click("nav.tabs button:nth-child(3)");
    const b64 = await page2.evaluate(() => {
      const c = document.createElement("canvas"); c.width = 1080; c.height = 900;
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, 1080, 900);
      g.fillStyle = "#b00"; g.fillRect(0, 0, 1080, 120);
      g.fillStyle = "#fff"; g.font = "bold 52px sans-serif"; g.fillText("庫存明細", 40, 82);
      g.fillStyle = "#333"; g.font = "36px sans-serif";
      const head = ["股票", "庫存股數", "成本均價", "現價"];
      head.forEach((h, i) => g.fillText(h, 40 + i * 260, 200));
      const rows = [["2317 鴻海", "3,000", "198.50", "239.50"], ["2603 長榮", "2,000", "210.00", "265.50"], ["2882 國泰金", "5,000", "61.20", "68.30"]];
      rows.forEach((r, j) => r.forEach((t, i) => { g.fillStyle = "#111"; g.font = "40px sans-serif"; g.fillText(t, 40 + i * 260, 300 + j * 150); }));
      return c.toDataURL("image/png").split(",")[1];
    });
    await page2.evaluate((b) => window.__srImportBase64(b), b64);
    await page2.waitForFunction(() => /確認辨識結果|辨識|錯誤|失敗/.test(document.body.innerText), null, { timeout: 120000 });
    await page2.waitForSelector(".import-row", { timeout: 120000 });
    const rows = await page2.$$eval(".import-row", (rs) => rs.map((r) => [...r.querySelectorAll("input:not([type=checkbox])")].map((i) => i.value).join("|")));
    log("照片辨識", JSON.stringify(rows));
    check(rows.some((r) => r.startsWith("2317|3000")) && rows.some((r) => r.startsWith("2603|2000")) && rows.some((r) => r.startsWith("2882|5000")), "Claude 從截圖辨識出 3 檔持股與股數", rows.join(" ; "));
    check(rows.some((r) => r === "2317|3000|198.5"), "Claude 辨識出成本均價", rows.join(" ; "));
    await shot("08-照片辨識結果");
    await page2.click("text=/加入 \\d 檔持股/");
    await page2.waitForTimeout(1000);
    const nHold = await page2.$$eval(".list .item", (x) => x.length);
    check(nHold === 4, "匯入後共有 4 檔持股", `${nHold} 檔`);
    await shot("09-匯入後持股");

    // 個股 AI 深度解析（含網路搜尋）
    await page2.click("nav.tabs button:nth-child(1)");
    await page2.click(".seg button:nth-child(1)");
    await page2.waitForSelector(".item", { timeout: 30000 });
    await page2.click(".item");
    await page2.click('button:has-text("AI 深度解析")');
    await page2.waitForFunction(() => document.querySelector(".report") || document.querySelector(".sheet .error"), null, { timeout: 5 * 60_000 });
    const rep = await page2.evaluate(() => ({ err: document.querySelector(".sheet .error")?.textContent, text: document.querySelector(".report")?.innerText, rating: document.querySelector(".ai-rating")?.innerText, sources: document.querySelectorAll(".sources li").length }));
    log("AI 解析", JSON.stringify({ ...rep, text: rep.text?.slice(0, 1500) }));
    check(!rep.err && !!rep.text, "AI 深度解析完成", rep.err || "");
    check(/(買入|觀望|離場)/.test(rep.rating || ""), "AI 給出評等", rep.rating);
    check(rep.sources > 0, "AI 解析附上網路資料來源", `${rep.sources} 個來源`);
    await page2.evaluate(() => document.querySelector(".sheet .body").scrollTo(0, document.querySelector(".report").offsetTop - 60));
    await shot("10-AI深度解析");
    await page2.click('button[aria-label="返回"]');

    // 國內外數據 AI 解讀
    await page2.click("nav.tabs button:nth-child(4)");
    await page2.click('button:has-text("產生今日解讀")');
    await page2.waitForFunction(() => document.querySelector(".report") || document.querySelector("main .error"), null, { timeout: 5 * 60_000 });
    const brief = await page2.evaluate(() => ({ err: document.querySelector("main .error")?.textContent, text: document.querySelector(".report")?.innerText, sources: document.querySelectorAll(".sources li").length }));
    log("AI 數據解讀", JSON.stringify({ ...brief, text: brief.text?.slice(0, 1500) }));
    check(!brief.err && !!brief.text && brief.sources > 0, "AI 國內外數據解讀完成且有來源", brief.err || `${brief.sources} 個來源`);
    await page2.evaluate(() => document.querySelector("main").scrollTo(0, document.querySelector(".report").offsetTop - 60));
    await shot("11-AI數據解讀");
  } else {
    log("沒有設定 ANTHROPIC_API_KEY，跳過 Claude AI 實測");
  }

  log("美股提示", await page2.evaluate(() => document.querySelector("main .notice")?.textContent || "無"));
  log("console 錯誤", JSON.stringify(errors));
  // 網路請求失敗（例如某檔美股一時下載不到）App 會顯示提示並允許重試，這裡只檢查程式本身的錯誤
  // 原生 HTTP 層（CapacitorHttp）在連線中斷時會記一筆 {code: ...Exception}，App 會自動重試，不算程式錯誤
  const jsErrors = errors.filter((e) => !/Failed to load resource|favicon|code: \w*Exception/.test(e));
  check(jsErrors.length === 0, "沒有 JavaScript 程式錯誤", jsErrors.join(" | "));
})()
  .catch((e) => { console.error("E2E 失敗：", e.message); process.exitCode = 1; })
  .finally(() => dumpAndExit());

dumpAndExit = () => {
    for (const [name, buf] of shots) {
      const b64 = buf.toString("base64");
      console.log(`=====BEGIN ${name}=====`);
      for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
      console.log(`=====END ${name}=====`);
    }
    console.log("RESULTS " + JSON.stringify(results));
    fs.writeFileSync("e2e-results.json", JSON.stringify(results, null, 2));
    process.exit(process.exitCode || 0);
};
