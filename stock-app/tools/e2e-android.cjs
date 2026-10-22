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
  const t0 = Date.now();
  await shot("00-啟動動畫");
  // 雷達要轉滿一圈（1 秒）才切到 App：第二張截圖時應該還在啟動畫面
  log("啟動動畫截圖耗時", Date.now() - t0, "ms");
  await shot("00b-啟動動畫第二張");
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
  // 今日漲跌：前 60 檔用證交所即時價（盤中標示「現價 HH:MM」），其餘用最近收盤
  const pickDay = await page.waitForFunction(() => {
    const els = [...document.querySelectorAll('[data-testid="pick-day"]')];
    return els.length >= 3 ? els.slice(0, 3).map((e) => e.closest(".item").querySelector(".px").innerText.replace(/\s+/g, " ")) : null;
  }, null, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null);
  log("選股今日漲跌", JSON.stringify(pickDay));
  check(!!pickDay && pickDay.every((t) => /(現價|收盤).*今日\s*[+-]?\d/.test(t)), "選股每列顯示今日漲跌", JSON.stringify(pickDay));
  await shot("02-選股-台股");

  // 剛轉強：回測資料裡的訊號（站上 20 日線 5% 以內、MACD 剛翻正、RSI<70、法人買超）
  const hasTurn = await page.waitForSelector('[data-testid="turn-chip"]', { timeout: 60000 }).then(() => true).catch(() => false);
  check(hasTurn, "選股有「剛轉強」篩選");
  if (hasTurn) {
    await page.click('[data-testid="turn-chip"]');
    await page.waitForSelector('[data-testid="turn-card"]', { timeout: 5000 });
    await sleep(500);
    const tv = await page.evaluate(() => ({
      chip: document.querySelector('[data-testid="turn-chip"]').textContent,
      card: document.querySelector('[data-testid="turn-card"]').innerText.replace(/\s+/g, " "),
      rows: [...document.querySelectorAll(".item")].slice(0, 8).map((r) => r.innerText.replace(/\s+/g, " ")),
      empty: document.querySelector(".empty")?.innerText || "",
    }));
    log("剛轉強", JSON.stringify(tv));
    const n = Number(/(\d+) 檔/.exec(tv.chip)?.[1] ?? -1);
    check(/條件：收盤在 20 日線上方 5% 以內/.test(tv.card) && /根據 \d+\/\d+/.test(tv.card), "剛轉強說明條件與資料日期", tv.card.slice(0, 80));
    check(n === 0 ? /沒有股票同時符合/.test(tv.empty) : tv.rows.length === Math.min(n, 8) && tv.rows.every((r) => /離20日線 \+\d/.test(r) && /停損參考 \d/.test(r)), "剛轉強每檔顯示離 20 日線與停損價", `${n} 檔 ${tv.rows[0] ?? tv.empty}`);
    // 文字不能被截斷（…）：停損價要完整看得到
    const clipped = await page.$$eval('[data-testid="turn-info"], [data-testid="turn-stop"]', (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.innerText));
    check(clipped.length === 0, "剛轉強資訊沒有被截斷", JSON.stringify(clipped.slice(0, 3)));
    await shot("02c-剛轉強");
    await page.evaluate(() => [...document.querySelectorAll(".chips .chip")].find((c) => c.textContent.startsWith("買入"))?.click());
    await sleep(500);
  }

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
  // 點族群 → 選股只看該族群：要有明顯的篩選提示，評等檔數要跟清單一致，取消後恢復全部
  await page.click("table.sectors tbody tr");
  await page.waitForSelector('[data-testid="sector-filter"]', { timeout: 10000 });
  const secView = await page.evaluate(() => ({
    banner: document.querySelector('[data-testid="sector-filter"]').innerText.replace(/\s+/g, " "),
    chip: document.querySelector('.chips .chip[aria-pressed="true"]').textContent,
    title: document.querySelector(".section-title").innerText.replace(/\s+/g, " "),
  }));
  log("族群篩選", JSON.stringify(secView));
  const chipN = Number(/(\d+) 檔/.exec(secView.chip)?.[1]), listN = Number(/(\d+) 檔/.exec(secView.title)?.[1]);
  check(/只看「.+」族群/.test(secView.banner) && chipN === listN, "族群篩選有明顯提示，評等檔數與清單一致", `${secView.chip} / ${secView.title}`);
  await shot("04b-族群篩選");
  await page.click('[data-testid="sector-filter"] button');
  await page.waitForFunction(() => !document.querySelector('[data-testid="sector-filter"]'), null, { timeout: 5000 });
  const allN = await page.$eval('.chips .chip[aria-pressed="true"]', (c) => Number(/(\d+) 檔/.exec(c.textContent)?.[1]));
  check(allN >= chipN, "取消族群篩選後恢復全部", `${allN} 檔`);

  // 數據：CNBC 國際指標＋證交所指數
  await page.click("nav.tabs button:nth-child(5)");
  await page.waitForFunction(() => document.querySelectorAll(".metric").length >= 8, null, { timeout: 60000 });
  const macro = await page.$$eval(".metric", (ms) => ms.map((m) => m.innerText.replace(/\s+/g, " ")));
  log("數據", JSON.stringify(macro.slice(0, 12)));
  check(macro.some((m) => m.includes("加權指數")), "顯示台股加權指數");
  check(macro.some((m) => m.includes("S&P 500")) && macro.some((m) => m.includes("美債 10 年")), "顯示美股與美債殖利率");
  check(macro.some((m) => /^韓國 KOSPI [\d,.]+/.test(m)) && macro.some((m) => /^日經 225 [\d,.]+/.test(m)), "亞洲大盤顯示日經與韓國 KOSPI", JSON.stringify(macro.filter((m) => /KOSPI|日經/.test(m))));
  // 台股指數盤中即時（證交所 MIS）：有「盤中 HH:MM」或「收盤」標題，且四大指數都在
  const idxTitle = await page.$eval('[data-testid="tw-index-title"]', (e) => e.innerText).catch(() => "");
  log("台股指數區", idxTitle);
  check(/台股(盤中 \d\d:\d\d|收盤)/.test(idxTitle), "台股指數改成盤中即時（或收盤）", idxTitle);
  check(["加權指數", "臺灣50指數", "半導體類指數", "金融保險類指數"].every((n) => macro.some((m) => m.includes(n))), "四大台股指數都顯示", JSON.stringify(macro.slice(0, 6)));
  // 盤中量能：成交量（億股）與成交筆數（萬筆）
  // 開盤前（台灣時間 09:00 前）證交所即時資料全是 0，沒有量能可顯示：四大指數漲跌都是 0.00 就略過
  const preOpen = ["加權指數", "臺灣50指數", "半導體類指數", "金融保險類指數"].every((n) => macro.some((m) => m.startsWith(n) && /0\.00（0\.00%）/.test(m)));
  check(preOpen || (macro.some((m) => /成交量 [\d.]+ 億股/.test(m)) && macro.some((m) => /成交筆數 \d+ 萬筆/.test(m))), "顯示大盤成交量與成交筆數", preOpen ? "尚未開盤，略過" : JSON.stringify(macro.filter((m) => /成交/.test(m))));
  // 收盤漲跌家數：上市、上櫃都要有「漲 N／跌 N」，且上市家數合理（普通股約 1000 檔以上）
  check(macro.some((m) => /^上市 漲 \d+／跌 \d+ 持平 \d+/.test(m)) && macro.some((m) => /^上櫃 漲 \d+／跌 \d+ 持平 \d+/.test(m)), "顯示收盤漲跌家數（上市、上櫃）", JSON.stringify(macro.filter((m) => /漲 \d+／跌/.test(m))));
  const bsum = macro.find((m) => /^上市 漲 \d+／跌/.test(m))?.match(/漲 (\d+)／跌 (\d+) 持平 (\d+)/);
  check(!!bsum && +bsum[1] + +bsum[2] + +bsum[3] >= 900, "上市漲跌家數加總合理（≥900）", bsum ? bsum.slice(1).join("/") : "無");
  await shot("05-國內外數據");

  // 自組 ETF：手動記一筆台積電成交，檢查淨值與 0050 對照
  await page.click("nav.tabs button:nth-child(4)");
  // 預設是 Claude 虛擬操作：從 GitHub 下載 Claude 每天更新的虛擬組合
  await page.waitForSelector('[data-testid="virtual-summary"]', { timeout: 30000 });
  const virt = await page.$eval('[data-testid="virtual-summary"]', (e) => e.innerText.replace(/\s+/g, " "));
  log("Claude 虛擬操作", virt.slice(0, 160));
  check(/報酬 [+-]?[\d.]+% 總損益 [+-]?[\d,]+/.test(virt) && (virt.match(/總損益/g) || []).length === 2, "虛擬操作淨值與 0050 兩格都在報酬後面顯示總損益", virt.slice(0, 200));
  check(/虛擬資金 50\.0 萬/.test(virt) && /0050/.test(virt), "自組ETF 顯示 Claude 虛擬操作（虛擬 50 萬、0050 對照）", virt.slice(0, 80));
  check(/起資金由 10\.0 萬 加到 50\.0 萬/.test(virt) && /加碼前 \d+ 天/.test(virt), "虛擬操作顯示加碼說明與加碼前報酬", virt.slice(0, 300));
  check((await page.$$('[data-testid="virtual-view"] .list .item')).length >= 4, "Claude 虛擬操作列出持股");
  const posLines = await page.$$eval('[data-testid="virtual-pos-line"]', (els) => els.map((e) => e.innerText.replace(/\s+/g, " ")));
  log("持股行", JSON.stringify(posLines));
  check(posLines.length >= 4 && posLines.every((t) => /均價 [\d.,]+・損益 [+-]?[\d,]+・佔/.test(t)), "虛擬操作每檔持股在均價後顯示台幣損益", JSON.stringify(posLines.slice(0, 2)));
  const gauge = await page.$eval('[data-testid="cash-gauge"]', (e) => e.innerText.replace(/\s+/g, " ")).catch(() => "");
  log("資金水位", gauge.slice(0, 200));
  const noteN = await page.$$eval('[data-testid="virtual-notes"] > div', (d) => d.length).catch(() => -1);
  check(noteN === 1, "每日操作說明只顯示最新一天", `${noteN} 則`);
  check(/股票 \d+%・現金 \d+%/.test(gauge) && /目標股票 \d+%/.test(gauge) && /7 成股票・3 成現金/.test(gauge), "虛擬操作顯示資金水位（股票／現金比重、目標、規劃）", gauge.slice(0, 160));
  // 即時報價（證交所 mis）：每檔持股要顯示「現價 HH:MM」或「收盤」＋今日漲跌
  const livePx = await page.waitForFunction(() => {
    const els = [...document.querySelectorAll('[data-testid="virtual-price"]')];
    return els.length && document.querySelector('[data-testid="virtual-view"]').innerText.includes("今日") ? els.map((e) => e.innerText.replace(/\s+/g, " ")) : null;
  }, null, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null);
  log("即時價", JSON.stringify(livePx));
  check(!!livePx && livePx.every((t) => /(現價|收盤).*\d/.test(t)), "Claude 虛擬操作持股顯示即時價（證交所 mis）");
  const vTrades = await page.$eval('[data-testid="virtual-trades"]', (e) => e.innerText.replace(/\s+/g, " ")).catch(() => "");
  check(/成交價 [\d.,]+/.test(vTrades) && !vTrades.includes("@"), "虛擬成交紀錄寫「成交價」、不再用 @ 符號", vTrades.slice(0, 120));
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
  check(/報酬 [+-]?[\d.]+% 總損益 [+-]?[\d,]+/.test(etfSum) && (etfSum.match(/總損益/g) || []).length === 2, "實單紀錄淨值與 0050 兩格都在報酬後面顯示總損益", etfSum.slice(0, 200));
  check(!!(await page.$("text=台積電")), "自組ETF 持股列出台積電");
  // 持股列的「賣出」按鈕：帶入代號、全部股數，表單切到賣出
  await page.click('[data-testid="sell-btn-2330"]');
  await page.waitForSelector('[data-testid="etf-trade-form"]', { timeout: 5000 });
  const sellForm = await page.evaluate(() => ({ code: document.querySelector("#etf-code").value, shares: document.querySelector("#etf-shares").value, sellOn: document.querySelector('[data-testid="etf-trade-form"] .seg button[aria-pressed="true"]')?.textContent }));
  check(sellForm.code === "2330" && sellForm.shares === "10" && sellForm.sellOn === "賣出", "持股的「賣出」按鈕帶入代號、全部股數並切到賣出", JSON.stringify(sellForm));
  await page.click('[data-testid="etf-trade-form"] button:has-text("取消")');
  check(!!(await page.$('[data-testid="etf-ask"]')), "自組ETF 有請 Claude 建議按鈕");
  // 從 Claude App 回來：模擬已按過「在 Claude App 檢視」再回到前景，要出現偵測卡或「貼上並載入」按鈕
  await page.evaluate(() => { localStorage.setItem("proPending", String(Date.now())); document.dispatchEvent(new Event("visibilitychange")); });
  const resumeUi = await page.waitForSelector('[data-testid="pro-found"], [data-testid="pro-resume"]', { timeout: 8000 }).then((h) => h.getAttribute("data-testid")).catch(() => "");
  check(!!resumeUi, "從 Claude App 回來時出現「偵測到回覆／貼上並載入」提示", resumeUi);
  if (resumeUi === "pro-resume") await page.click("text=不用了");
  await page.evaluate(() => localStorage.removeItem("proPending"));
  // 把「送給 Claude 的提問」貼進回覆框：要立刻提醒、不能儲存
  await page.fill('[data-testid="pro-text"]', "今天是 2026/10/21。我要用新台幣 100,000 元做「自組 ETF」，會照你的建議真的下單。\n【持股】\n| 代號 | 名稱 |\n".padEnd(260, "字"));
  const promptErr = await page.$eval('[data-testid="pro-err"]', (e) => e.innerText).catch(() => "");
  const saveOff = await page.$eval('[data-testid="pro-save"]', (b) => b.disabled).catch(() => false);
  check(/不是 Claude 的回覆/.test(promptErr) && saveOff, "貼上送給 Claude 的提問會立刻提醒、不能儲存", promptErr.slice(0, 60));
  await page.click('[data-testid="pro-clear"]');
  const wide = await page.evaluate(() => { const m = document.querySelector("main"); return [m.scrollWidth, m.clientWidth]; });
  check(wide[0] <= wide[1] + 1, "我的實單紀錄固定滿版，不會左右晃動", `內容寬 ${wide[0]}／螢幕寬 ${wide[1]}`);
  const rTrades = await page.$eval('[data-testid="etf-trades"]', (e) => e.innerText.replace(/\s+/g, " ")).catch(() => "");
  check(/成交價 [\d.,]+・損益 [+-]?[\d,]+/.test(rTrades) && !rTrades.includes("@"), "實單成交紀錄寫「成交價・損益」、不再用 @ 符號", rTrades.slice(0, 120));
  // 按成交紀錄的 ✕：只是從列表移除，持股不能跟著消失
  const posBefore = await page.$$eval('.list .item .name', (e) => e.length);
  page.once("dialog", (d) => d.accept());
  await page.click('[data-testid="trade-hide"]');
  await page.waitForTimeout(600);
  const afterHide = await page.evaluate(() => ({ rows: document.querySelectorAll('[data-testid="etf-trades"] .row').length, pos: document.querySelectorAll('.list .item .name').length, nav: document.querySelector('[data-testid="etf-summary"]').innerText.includes("股票市值") }));
  check(afterHide.rows === 0 && afterHide.pos === posBefore && afterHide.pos > 0 && afterHide.nav, "刪除成交紀錄那一列時，持股不會跟著消失", JSON.stringify({ posBefore, ...afterHide }));
  const cand = await page.$eval('[data-testid="candidates"]', (e) => ({ rows: e.querySelectorAll("tbody tr:not(.grp)").length, grp: e.querySelectorAll("tbody tr.grp").length, cols: e.querySelectorAll("thead th").length, over: e.querySelector("table").scrollWidth > e.querySelector("table").parentElement.clientWidth + 1 })).catch(() => null);
  check(!!cand && cand.rows >= 3 && cand.rows <= 12 && cand.cols === 5 && !cand.over, "候選股一覽：依產業分組、5 欄、手機寬度不用左右滑", JSON.stringify(cand));
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
  const dayTxt = await page.waitForFunction(() => document.querySelector('[data-testid="hold-day"]')?.innerText, null, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => "");
  log("持股今日漲跌", dayTxt);
  check(/今日\s*[+-]?\d/.test(dayTxt), "持股顯示今日漲跌", dayTxt);

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
  const hasPrice = (r) => /現價(\s*\d\d:\d\d)?\s*\d[\d,]*(\.\d+)?/.test(r) && /損益\s*[+-]?\$?[\d,]+（[+-]?\d+(\.\d)?%）/.test(r) && !/—/.test(r);
  check(/元大台灣50/.test(row("0050")) && /參考/.test(row("0050")) && !/(買入|觀望|離場)/.test(row("0050")) && hasPrice(row("0050")), "0050 顯示現價、損益，只當參考不給買賣評等", row("0050"));
  check(hasPrice(row("00406A")) && !/無資料/.test(row("00406A")), "00406A 顯示現價與損益", row("00406A"));
  check(/貝爾威勒/.test(row("7861")) && /無評等/.test(row("7861")) && /興櫃/.test(row("7861")) && hasPrice(row("7861")), "興櫃 7861 顯示現價與損益、不評等", row("7861"));
  // 美股持股：美金損益有 $ 符號，下一行台幣損益有 NT$ 符號；市值卡片也一樣
  await page.click("text=手動新增");
  await page.fill("#h-code", "AAPL");
  await page.fill("#h-shares", "10");
  await page.fill("#h-cost", "100");
  await page.click("text=儲存");
  await page.waitForFunction(() => [...document.querySelectorAll(".list .item")].some((e) => /AAPL/.test(e.innerText) && e.querySelector('[data-testid="hold-ntd"]')), null, { timeout: 120000 }).catch(() => {});
  const usHold = await page.evaluate(() => {
    const it = [...document.querySelectorAll(".list .item")].find((e) => /AAPL/.test(e.innerText));
    const t = (el) => (el ? el.innerText.replace(/\s+/g, " ").trim() : "");
    return { pnl: t(it?.querySelector('[data-testid="hold-pnl"]')), ntd: t(it?.querySelector('[data-testid="hold-ntd"]')), cardNtd: t(document.querySelector('[data-testid="us-ntd"]')), cardText: t([...document.querySelectorAll(".card")].find((c) => /美股市值/.test(c.innerText))), note: document.body.innerText.replace(/\s+/g, " ") };
  });
  log("美股持股", JSON.stringify(usHold));
  check(/損益 [+-]\$[\d,]+（[+-]?\d+(\.\d)?%）/.test(usHold.pnl), "美股持股損益用美金符號 $", usHold.pnl);
  check(/^[+-]NT\$[\d,]+$/.test(usHold.ntd), "美股持股另外顯示台幣損益（NT$）", usHold.ntd);
  check(/^[+-]NT\$[\d,]+$/.test(usHold.cardNtd) && /\$[\d,]+/.test(usHold.cardText), "美股市值卡片顯示美金與台幣損益", usHold.cardText);
  // 只有一檔美股：卡片與持股列的台幣損益要一樣，且換算出的匯率合理（不顯示匯率，從金額反推）；也確認畫面上不再出現匯率說明
  const usd = Number((usHold.pnl.match(/([+-])\$([\d,]+)/) || []).slice(1).join("").replace(/,/g, ""));
  const twd = Number(usHold.ntd.replace(/NT\$|,/g, ""));
  const impliedRate = Math.abs(twd / usd);
  check(usHold.cardNtd === usHold.ntd && impliedRate > 20 && impliedRate < 50 && !/今日匯率/.test(usHold.note), "台幣損益由美金損益換算（匯率合理），畫面不顯示匯率", `${usd} → ${twd}（約 ${impliedRate.toFixed(1)}）`);
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
  // 美股即時價（CNBC）：盤中/盤前盤後要用即時價，紐約半夜（盤後已收、盤前未開）則顯示收盤——兩種都要正確顯示「收盤/現價 今日%」
  // 先等即時報價灌進來（至少一列），證明 CNBC 這條路有通
  const anyLive = await page2.waitForFunction(() => [...document.querySelectorAll(".item")].slice(0, 6).some((r) => r.dataset.live === "1"), null, { timeout: 30000 }).then(() => true).catch(() => false);
  const usLive = await page2.$$eval(".item", (rs) => rs.slice(0, 6).map((r) => ({ live: r.dataset.live === "1", px: r.querySelector(".px").innerText.replace(/\s+/g, " ") })));
  // 紐約是否在交易或盤前盤後時段（平日 4:00~20:00）；是的話要有即時列，否則只要收盤列正確
  const nyH = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  const nyWd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date());
  const usTrading = !["Sat", "Sun"].includes(nyWd) && nyH >= 4 && nyH < 20;
  log("美股即時價", `紐約 ${nyH}時 ${nyWd} 交易時段=${usTrading} 有即時=${anyLive}`, JSON.stringify(usLive));
  check(usTrading ? anyLive : true, "美股盤中/盤前盤後有即時報價（紐約半夜顯示收盤）", `紐約 ${nyH}時 交易=${usTrading} 有即時=${anyLive}`);
  check(usLive.every((r) => /(現價 \d\d:\d\d|收盤)\s*[\d,]+\.\d+ 今日\s*[+-]?\d/.test(r.px)), "美股每列顯示收盤/現價與今日漲跌", JSON.stringify(usLive.map((r) => r.px)));
  const usAsof = await page2.$eval(".asof", (e) => e.innerText);
  // 預期資料日：紐約 17:00 後算當天，往前找平日
  const ny = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const P = Object.fromEntries(ny.map((x) => [x.type, x.value]));
  let exp = new Date(Date.UTC(+P.year, +P.month - 1, +P.day - (+P.hour >= 17 ? 0 : 1)));
  while ([0, 6].includes(exp.getUTCDay())) exp = new Date(exp.getTime() - 86400000);
  const expTxt = `${exp.getUTCMonth() + 1}/${exp.getUTCDate()}`;
  log("美股資料日", usAsof, "預期", expTxt);
  check(usAsof.includes(`美股資料 ${expTxt}`), "美股資料是最近一個收盤日", `${usAsof} 預期 ${expTxt}（美國假日會不同）`);
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
    check(nHold === 8, "匯入後共有 8 檔持股（含美股 AAPL）", `${nHold} 檔`);
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
