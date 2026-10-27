// 探測：證交所 T86 三大法人（10/27、10/26、10/23、10/22）實際回應與耗時
const H = { "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36", accept: "application/json, text/plain, */*" };
for (const d of ["20261027", "20261026", "20261023", "20261022", "20261021"]) {
  const t0 = Date.now();
  try {
    const r = await fetch(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${d}&selectType=ALLBUT0999&response=json`, { headers: H, signal: AbortSignal.timeout(60000) });
    const t = await r.text();
    console.log("T86", d, r.status, Date.now() - t0, "ms", t.length, t.slice(0, 160).replace(/\s+/g, " "));
  } catch (e) { console.log("T86", d, "ERR", Date.now() - t0, "ms", String(e), e.cause ? String(e.cause) : ""); }
  await new Promise((r) => setTimeout(r, 3500));
}
