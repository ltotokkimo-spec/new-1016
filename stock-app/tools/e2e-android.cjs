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
  // --splashscreen-show-icon：用指令開 App 時也顯示啟動圖示（從桌面點開的效果）
  await device.shell(`am start --splashscreen-show-icon -n ${PKG}/.MainActivity`);
  // Android 12 以上的啟動畫面：雷達掃描動畫（開 App 後馬上截圖）
  await new Promise((r) => setTimeout(r, 350));
  await shot("00-啟動動畫");
  // 模擬器剛開機時，App 第一次啟動偶爾會被系統重建一次畫面，舊的連線就會斷掉；斷掉就重新連
  let webview, page;
  for (let attempt = 1; ; attempt++) {
    try {
      webview = await withTimeout(device.webView({ pkg: PKG }), 90_000, "等待 App 的 WebView");
      page = await withTimeout(webview.page(), 60_000, "連接 WebView 頁面");
    } catch (e) {
      // 模擬器的除錯連線偶爾卡住：重開 App 再連一次（App 本身已經在跑）
      log(`連接 App 畫面失敗（第 ${attempt} 次）：${e.message}，重開 App 再試`);
      if (attempt >= 4) throw e;
      await device.shell(`am force-stop ${PKG}`);
      await sleep(3000);
      await device.shell(`am start -n ${PKG}/.MainActivity`);
      await sleep(5000);
      continue;
    }
    await sleep(10000);
    if (!page.isClosed()) break;
    log(`App 畫面連線中斷（第 ${attempt} 次），重新連接`,
      "\n程序：", String(await device.shell(`pidof ${PKG}`)).trim() || "（App 已結束）",
      "\n當機紀錄：", String(await device.shell("logcat -d -b crash -t 30")).slice(-1500),
      "\nWebView 紀錄：", String(await device.shell("logcat -d -t 400 | grep -iE 'chromium|webview|renderer|fatal|died|crash|lowmemory|kill' | tail -40")).slice(-3000));
    if (attempt >= 4) throw new Error("App 畫面一直中斷");
    await device.shell(`am start -n ${PKG}/.MainActivity`);
    await sleep(2000);
  }
  log("已連上 App 畫面");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${m.text()} @ ${m.location()?.url || "?"}`); });
  page.on("response", (r) => { if (r.status() >= 400) log("HTTP", r.status(), r.url()); });
  await sleep(3000);
  await shot("01-啟動下載中");

  // ---------- 台股：真實證交所／櫃買資料 ----------
  // 每 30 秒記錄下載進度；卡住時印出原生網路紀錄方便查原因
  const watch = setInterval(async () => {
    const t = await page.evaluate(() => document.querySelector(".progress")?.innerText.replace(/\s+/g, " ") || "（沒有進度列）").catch(() => "?");
    log("下載進度", t);
  }, 30_000);
  try {
    await page.waitForSelector(".item", { timeout: 8 * 60_000 });
  } catch (e) {
    log("原生紀錄", String(await device.shell("logcat -d -t 400 | grep -iE 'capacitor|http|socket|ssl|timeout|exception' | tail -80")));
    log("連線測試", String(await device.shell("ping -c 2 -W 3 www.twse.com.tw; ping -c 2 -W 3 www.tpex.org.tw")));
    throw e;
  } finally { clearInterval(watch); }
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
  check(tw.rows.length > 0 && tw.rows.every((r) => /(買入|觀望|離場)/.test(r) && /分數 \d+/.test(r)), "每列都有評等與分數", tw.rows[0]);
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

  // 免費解析：不花錢，用 App 的資料寫成報告（含證交所每月營收）
  await page.waitForSelector('[data-testid="free-btn"]:not([disabled])', { timeout: 120000 });
  await page.click('[data-testid="free-btn"]');
  await page.waitForSelector('[data-testid="free-report"]', { timeout: 120000 });
  const free = await page.$eval('[data-testid="free-report"]', (e) => e.innerText);
  log("免費解析", free.slice(0, 1500));
  check(/結論/.test(free) && /趨勢與技術面/.test(free) && /法人籌碼/.test(free) && /支撐/.test(free) && /\d+\/100/.test(free), "免費解析產生結論、技術面、籌碼與支撐壓力", free.slice(0, 120));
  // 營收是另外下載的，等它補上（最多 30 秒）
  const hasRev = await page.waitForFunction(() => /每月營收（/.test(document.querySelector('[data-testid="free-report"]')?.innerText || ""), null, { timeout: 30000 }).then(() => true).catch(() => false);
  await page.waitForFunction(() => !/正在下載每月營收/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
  log("免費解析含每月營收", hasRev, JSON.stringify(await page.evaluate(() => window.__srRevenue)));
  if (hasRev) log("營收段落", (await page.$eval('[data-testid="free-report"]', (e) => e.innerText)).split("每月營收（")[1]?.slice(0, 200));
  check(hasRev, "免費解析含證交所每月營收", JSON.stringify(await page.evaluate(() => window.__srRevenue)));
  await page.evaluate(() => document.querySelector(".sheet .body").scrollTo(0, document.querySelector('[data-testid="free-report"]').offsetTop - 60));
  await sleep(400);
  await shot("03b-免費解析");

  // 用 Claude App 解析：連結帶入提問、按下去會離開 App（打開 Claude App 或瀏覽器）並複製提問
  const href = await page.$eval('[data-testid="claude-app"]', (a) => a.getAttribute("href"));
  const q = decodeURIComponent(href.split("?q=")[1] || "");
  check(href.startsWith("https://claude.ai/new?q=") && q.includes(detail.title.split(" ").pop()) && /MCP|網路搜尋/.test(q), "Claude App 連結帶入這檔股票的數據與提問", q.slice(0, 80));
  // 連結會離開 App（打開 Claude），用程式點擊，不等頁面跳轉
  await page.$eval('[data-testid="claude-app"]', (a) => a.click());
  await sleep(3000);
  log("按下 Claude App 後的畫面", String(await device.shell("dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity'")));
  await shot("03c-開啟Claude");
  await device.shell(`am start -n ${PKG}/.MainActivity`);
  await sleep(2000);
  check(await page.$('[data-testid="claude-app-copied"]').then((x) => !!x).catch(() => false), "按下 Claude App 解析時已複製提問");
  await page.click('button[aria-label="返回"]');

  // ETF 分頁：證交所資料裡的 ETF 單獨評分（只有「全部」，不分評等）
  await page.click(".seg button:nth-child(2)");
  await page.waitForSelector(".item", { timeout: 10000 });
  const etf = await page.evaluate(() => ({
    chips: [...document.querySelectorAll(".chips .chip")].map((c) => c.textContent).join(" "),
    rows: [...document.querySelectorAll(".item")].slice(0, 8).map((r) => r.innerText.replace(/\s+/g, " ")),
  }));
  log("ETF", JSON.stringify(etf));
  const nEtf = Number(/全部 (\d+)/.exec(etf.chips)?.[1] || 0);
  check(nEtf >= 30, "ETF 分頁有評分的 ETF", `全部 ${nEtf} 檔`);
  check(etf.rows.every((r) => /\b00\d{2,4}[A-Z]?\b/.test(r) && /參考/.test(r) && /分數 \d+/.test(r) && !/(買入|觀望|離場)/.test(r)), "ETF 每列都是 00 開頭代號，只給分數參考、不給買賣評等", etf.rows[0]);
  await shot("02b-選股-ETF");
  await page.click(".seg button:nth-child(1)");

  // 族群
  await page.click("nav.tabs button:nth-child(2)");
  await page.waitForSelector("table.sectors tbody tr", { timeout: 10000 });
  const sectors = await page.$$eval("table.sectors tbody tr", (rows) => rows.map((r) => r.innerText.replace(/\s+/g, " ")));
  log("族群", JSON.stringify(sectors.slice(0, 6)));
  check(sectors.length >= 10, "族群表至少 10 個產業", `${sectors.length} 個`);
  check(sectors.some((r) => r.includes("半導體")), "族群表包含半導體");
  await shot("04-族群輪動");

  // 數據：CNBC 國際指標＋證交所指數
  await page.click("nav.tabs button:nth-child(5)");
  await page.waitForFunction(() => document.querySelectorAll(".metric").length >= 8, null, { timeout: 60000 });
  const macro = await page.$$eval(".metric", (ms) => ms.map((m) => m.innerText.replace(/\s+/g, " ")));
  log("數據", JSON.stringify(macro.slice(0, 12)));
  check(macro.some((m) => m.includes("加權指數")), "顯示台股加權指數");
  check(macro.some((m) => m.includes("S&P 500")) && macro.some((m) => m.includes("美債 10 年")), "顯示美股與美債殖利率");
  await shot("05-國內外數據");

  // 自組 ETF：手動記一筆台積電成交，檢查淨值與 0050 對照
  await page.click("nav.tabs button:nth-child(4)");
  // 預設是 Claude 虛擬操作：從 GitHub 下載 Claude 每天更新的虛擬組合
  await page.waitForSelector('[data-testid="virtual-summary"]', { timeout: 30000 });
  const virt = await page.$eval('[data-testid="virtual-summary"]', (e) => e.innerText.replace(/\s+/g, " "));
  log("Claude 虛擬操作", virt.slice(0, 160));
  check(/虛擬資金 10\.0 萬/.test(virt) && /0050/.test(virt), "自組ETF 顯示 Claude 虛擬操作（虛擬 10 萬、0050 對照）");
  check((await page.$$('[data-testid="virtual-view"] .list .item')).length >= 4, "Claude 虛擬操作列出持股");
  // 即時報價（證交所 mis）：每檔持股要顯示「現價 HH:MM」或「收盤」＋今日漲跌
  const livePx = await page.waitForFunction(() => {
    const els = [...document.querySelectorAll('[data-testid="virtual-price"]')];
    return els.length && document.querySelector('[data-testid="virtual-view"]').innerText.includes("今日") ? els.map((e) => e.innerText.replace(/\s+/g, " ")) : null;
  }, null, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null);
  log("即時價", JSON.stringify(livePx));
  check(!!livePx && livePx.every((t) => /(現價|收盤).*\d/.test(t)), "Claude 虛擬操作持股顯示即時價（證交所 mis）");
  await shot("05a-Claude虛擬操作");
  await page.click('[data-testid="mode-real"]');
  await page.waitForSelector('[data-testid="etf-summary"]', { timeout: 10000 });
  check(/起始資金 10\.0 萬/.test(await page.$eval('[data-testid="etf-summary"]', (e) => e.innerText)), "自組ETF 起始資金 10 萬");
  await page.click("text=手動新增一筆成交");
  await page.fill("#etf-code", "2330");
  await page.fill("#etf-shares", "10");
  await page.waitForFunction(() => Number(document.querySelector("#etf-price").value) > 0, null, { timeout: 5000 }).catch(() => page.fill("#etf-price", "1000"));
  await page.click('[data-testid="etf-trade-save"]');
  await page.waitForFunction(() => /贏過 0050|落後 0050/.test(document.querySelector('[data-testid="etf-summary"]').innerText), null, { timeout: 10000 });
  const etfSum = await page.$eval('[data-testid="etf-summary"]', (e) => e.innerText.replace(/\s+/g, " "));
  log("自組ETF", etfSum);
  check(/現金/.test(etfSum) && /股票市值/.test(etfSum), "自組ETF 成交後顯示現金與市值");
  check(!!(await page.$("text=台積電")), "自組ETF 持股列出台積電");
  check(!!(await page.$('[data-testid="etf-ask"]')), "自組ETF 有請 Claude 建議按鈕");
  await shot("05b-自組ETF");
  // 免費停損提醒：把停損價設在現價之上，應該馬上出現提醒與分頁紅點
  // 剛買進不會跌破預設停損（成本 −10%）；但台積電當天若被評為離場，會有離場提醒，這是正確的
  const before = await page.$eval('[data-testid="etf-alerts"]', (e) => e.innerText).catch(() => "");
  check(!/跌破停損價/.test(before), "自組ETF 剛買進時沒有停損提醒", before.replace(/\s+/g, " ").slice(0, 120));
  const px2330 = await page.$eval('[data-testid="stop-edit"]', (e) => e.closest(".item").querySelector(".p").innerText.replace(/[^0-9.]/g, ""));
  await page.click('[data-testid="stop-edit"]');
  await page.fill('[data-testid="stop-input"]', String(Math.ceil(Number(px2330) * 1.05)));
  await page.click('[data-testid="stop-save"]');
  await page.waitForSelector('[data-testid="etf-alerts"]', { timeout: 10000 });
  const alertText = await page.$eval('[data-testid="etf-alerts"]', (e) => e.innerText.replace(/\s+/g, " "));
  log("停損提醒", alertText);
  check(/台積電/.test(alertText) && /跌破停損價/.test(alertText), "自組ETF 跌破停損價會提醒");
  check(!!(await page.$('[data-testid="etf-dot"]')), "自組ETF 分頁出現紅點");
  await page.evaluate(() => document.querySelector("main").scrollTo(0, 0));
  await shot("05c-停損提醒");

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

  // ETF 與興櫃持股（使用者回報 0050、00406A、7861 顯示無資料）
  for (const [code, cost] of [["0050", "100"], ["00406A", "10"], ["7861", "900"]]) {
    await page.click("text=手動新增");
    await page.fill("#h-code", code);
    await page.fill("#h-shares", "1000");
    await page.fill("#h-cost", cost);
    await page.click("text=儲存");
    await sleep(500);
  }
  await page.waitForFunction(() => document.querySelectorAll(".list .item").length >= 4, null, { timeout: 10000 });
  // 興櫃報價是另外下載的，等它出現
  await page.waitForFunction(() => /貝爾威勒/.test(document.querySelector(".list")?.innerText || ""), null, { timeout: 120000 }).catch(() => {});
  const holds = await page.$$eval(".list .item", (xs) => xs.map((e) => e.innerText.replace(/\s+/g, " ")));
  log("持股（含 ETF／興櫃）", JSON.stringify(holds));
  const row = (c) => holds.find((h) => h.includes(c)) || "";
  const hasPrice = (r) => /現價\s*\d[\d,]*(\.\d+)?\s+損益\s*[+-]?\d+(\.\d)?%/.test(r) && !/—/.test(r);
  check(/元大台灣50/.test(row("0050")) && /參考/.test(row("0050")) && !/(買入|觀望|離場)/.test(row("0050")) && hasPrice(row("0050")), "0050 顯示現價、損益，只當參考不給買賣評等", row("0050"));
  check(hasPrice(row("00406A")) && !/無資料/.test(row("00406A")), "00406A 顯示現價與損益", row("00406A"));
  check(/貝爾威勒/.test(row("7861")) && /無評等/.test(row("7861")) && /興櫃/.test(row("7861")) && hasPrice(row("7861")), "興櫃 7861 顯示現價與損益、不評等", row("7861"));
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
  let page2 = await withTimeout(wv2.page(), 60_000, "連接重開後的頁面");
  page2.on("pageerror", (e) => errors.push(e.message));
  // 重開後模擬器偶爾也會重建一次畫面，舊連線會斷；斷了就重新接上（App 本身不受影響）
  const ensurePage2 = async () => {
    for (let i = 1; page2.isClosed(); i++) {
      log(`重開後畫面連線中斷（第 ${i} 次），重新連接`);
      if (i > 3) throw new Error("重開後 App 畫面一直中斷");
      const w = await withTimeout(device.webView({ pkg: PKG }), 90_000, "重新等待 WebView");
      page2 = await withTimeout(w.page(), 60_000, "重新連接頁面");
      page2.on("pageerror", (e) => errors.push(e.message));
      await sleep(3000);
    }
    await page2.waitForSelector("nav.tabs", { timeout: 60000 });
  };
  await sleep(8000);
  await ensurePage2();
  await page2.click("nav.tabs button:nth-child(3)");
  await page2.waitForSelector(".list .item", { timeout: 30000 });
  check(/台積電/.test(await page2.$eval(".list .item", (e) => e.innerText)), "重開 App 後持股還在");
  await ensurePage2();

  // 美股：真實 Nasdaq 資料
  await page2.click("nav.tabs button:nth-child(1)");
  await page2.click(".seg button:nth-child(3)");
  await page2.waitForFunction(() => /全部 [1-9]\d/.test(document.body.innerText), null, { timeout: 6 * 60_000 });
  await page2.click(".chips button:nth-child(4)");
  await page2.waitForSelector(".item", { timeout: 10000 });
  const us = await page2.$$eval(".item", (rs) => rs.slice(0, 6).map((r) => r.innerText.replace(/\s+/g, " ")));
  log("美股", JSON.stringify(us));
  check(us.length >= 6, "美股清單有資料", us[0]);
  const prices = new Set(us.map((r) => /(\d[\d,]*\.\d\d)/.exec(r)?.[1]));
  check(prices.size >= 4, "美股各檔價格不同（是真實資料）", [...prices].join(" "));
  await shot("07-選股-美股");

  // 搜尋不在預設清單裡的美股（使用者回報 AAOI 搜不到）
  await page2.fill(".search", "AAOI");
  await page2.waitForSelector('[data-testid="us-add"]', { timeout: 10000 });
  await page2.click('[data-testid="us-add"]');
  await page2.waitForFunction(() => [...document.querySelectorAll(".item")].some((e) => /AAOI/.test(e.innerText)) || /查不到|下載失敗/.test(document.body.innerText), null, { timeout: 180000 });
  const aaoi = await page2.evaluate(() => ([...document.querySelectorAll(".item")].find((e) => /AAOI/.test(e.innerText))?.innerText || document.querySelector(".error")?.innerText || "").replace(/\s+/g, " "));
  log("AAOI", aaoi);
  check(/AAOI/.test(aaoi) && /(買入|觀望|離場)/.test(aaoi) && /分數 \d+/.test(aaoi), "搜尋清單外的美股 AAOI，下載後顯示評等", aaoi);
  await shot("07b-美股-搜尋AAOI");
  await page2.fill(".search", "");

  // ---------- Claude AI（有提供金鑰才測） ----------
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    await page2.click("nav.tabs button:nth-child(6)");
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
    check(nHold === 7, "匯入後共有 7 檔持股", `${nHold} 檔`);
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
    await page2.click("nav.tabs button:nth-child(5)");
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

  // ---------- App 內更新：檢查版本、權限、從 GitHub 下載並打開系統安裝畫面 ----------
  const fg = async () => String(await device.shell("dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity'"));
  await page2.click("nav.tabs button:nth-child(6)");
  await page2.waitForSelector('[data-testid="update-card"]', { timeout: 10000 });
  await page2.waitForFunction(() => /已是最新版本|有新版本|檢查更新失敗/.test(document.querySelector('[data-testid="update-card"]').innerText), null, { timeout: 60000 });
  const card = await page2.$eval('[data-testid="update-card"]', (e) => e.innerText.replace(/\s+/g, " "));
  log("更新", card);
  const run = process.env.GITHUB_RUN_NUMBER || "0";
  check(card.includes(`目前版本 1.0.${run}`), "App 讀到自己的版本號", card);
  // 上一版還沒有 version.json 時會是 404，之後的版本都要讀得到
  check(/已是最新版本/.test(card) || /HTTP 404/.test(card), "檢查更新可以讀到 GitHub 上的最新版資訊", card);
  await page2.evaluate(() => window.__srForceUpdate());
  await device.shell(`appops set ${PKG} REQUEST_INSTALL_PACKAGES default`);
  await page2.click('[data-testid="install-update"]');
  await sleep(3000);
  const f1 = await fg();
  log("沒有安裝權限時", f1);
  check(/settings/i.test(f1), "第一次更新會打開「允許安裝」設定頁", f1);
  await shot("12-更新-允許安裝設定");
  await device.shell("input keyevent 4");
  await sleep(1500);
  await device.shell(`appops set ${PKG} REQUEST_INSTALL_PACKAGES allow`);
  await page2.click('[data-testid="install-update"]');
  let f2 = "";
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    f2 = await fg();
    if (/packageinstaller/i.test(f2)) break;
    const st = await page2.evaluate(() => document.querySelector('[data-testid="update-card"]')?.innerText || "").catch(() => "");
    if (/下載更新失敗/.test(st)) { f2 = st; break; }
  }
  log("下載後", f2);
  check(/packageinstaller/i.test(f2), "從 GitHub 下載新版並打開 Android 安裝畫面", f2);
  await sleep(1500);
  await shot("13-更新-安裝畫面");
  await device.shell("input keyevent 4");
  await sleep(1000);

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
