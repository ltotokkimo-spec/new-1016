package tw.ltotokkimo.stockradar;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 背景檢查持股（AlertsPlugin 排程，每 15 分鐘一次）：只在台北時間週一到週五 9:00～13:35 抓證交所即時價。
 * 跌破停損：現價 ≤ 停損價（停損價不高於均價時）。
 * 達標離場：獲利 ≥ +10% 且現價跌破 5 日線（現價 < 前 4 天收盤平均），或停損價高於均價（停利價）且現價 ≤ 停利價。
 * 同一個帳戶、同一檔、同一種警示，一天只通知一次。和 App 畫面上的紅綠燈用同一套條件。
 */
public class AlertWorker extends Worker {
    static final String CHANNEL = "holding_alerts";

    public AlertWorker(@NonNull Context c, @NonNull WorkerParameters p) { super(c, p); }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        TimeZone tz = TimeZone.getTimeZone("Asia/Taipei");
        Calendar now = Calendar.getInstance(tz);
        int dow = now.get(Calendar.DAY_OF_WEEK), hm = now.get(Calendar.HOUR_OF_DAY) * 100 + now.get(Calendar.MINUTE);
        if (dow == Calendar.SATURDAY || dow == Calendar.SUNDAY || hm < 900 || hm > 1335) return Result.success();
        if (!AlertsPlugin.granted(ctx)) return Result.success();
        SharedPreferences sp = AlertsPlugin.prefs(ctx);
        try {
            JSONArray items = new JSONArray(sp.getString("items", "[]"));
            if (items.length() == 0) return Result.success();
            StringBuilder ch = new StringBuilder();
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.getJSONObject(i);
                String key = it.optString("ex", "tse") + "_" + it.getString("code") + ".tw";
                if (ch.indexOf(key) >= 0) continue;
                if (ch.length() > 0) ch.append('|');
                ch.append(key);
            }
            Map<String, Double> px = fetchPrices(ch.toString());
            SimpleDateFormat df = new SimpleDateFormat("yyyyMMdd", Locale.US);
            df.setTimeZone(tz);
            String today = df.format(now.getTime());
            SharedPreferences.Editor ed = sp.edit();
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.getJSONObject(i);
                String code = it.getString("code");
                Double p = px.get(code);
                if (p == null || !(p > 0)) continue;
                double avg = it.optDouble("avg", 0), stop = it.optDouble("stop", 0), ma4 = it.optDouble("ma4", Double.NaN);
                String acct = "dual".equals(it.optString("acct")) ? "雙引擎實單" : "我的實單";
                String name = it.optString("name", code);
                boolean lock = stop > avg && avg > 0;
                boolean stopHit = !lock && stop > 0 && p <= stop;
                boolean tpHit = (avg > 0 && p / avg - 1 >= 0.10 && !Double.isNaN(ma4) && p < ma4) || (lock && p <= stop);
                if (stopHit) send(ctx, sp, ed, today, it.optString("acct") + code + "stop", "⚠ " + acct + "：" + name + " 跌破停損",
                        String.format(Locale.US, "%s %s 現價 %s ≤ 停損 %s（均價 %s）", name, code, fmt(p), fmt(stop), fmt(avg)));
                if (tpHit) send(ctx, sp, ed, today, it.optString("acct") + code + "tp", "🔴 " + acct + "：" + name + " 達標離場",
                        String.format(Locale.US, "%s %s 現價 %s，%s（均價 %s）", name, code, fmt(p),
                                lock && p <= stop ? "跌破停利價 " + fmt(stop) : String.format(Locale.US, "獲利 %+.1f%% 且跌破 5 日線", (p / avg - 1) * 100), fmt(avg)));
            }
            ed.apply();
        } catch (Exception e) {
            return Result.success(); // 網路或資料問題：下一輪再試，不要讓系統一直重排
        }
        return Result.success();
    }

    static String fmt(double x) { return x >= 100 ? String.format(Locale.US, "%.1f", x) : String.format(Locale.US, "%.2f", x); }

    /** 證交所即時價：成交價 z（沒成交時是 "-"，改用最佳買價第一檔） */
    static Map<String, Double> fetchPrices(String exCh) throws Exception {
        Map<String, Double> out = new HashMap<>();
        URL u = new URL("https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=" + java.net.URLEncoder.encode(exCh, "UTF-8"));
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setConnectTimeout(15000); c.setReadTimeout(15000);
        c.setRequestProperty("User-Agent", "Mozilla/5.0");
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
            String line; while ((line = r.readLine()) != null) sb.append(line);
        } finally { c.disconnect(); }
        JSONArray arr = new JSONObject(sb.toString()).optJSONArray("msgArray");
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject q = arr.getJSONObject(i);
            double p = num(q.optString("z"));
            if (!(p > 0)) { String b = q.optString("b"); p = num(b.contains("_") ? b.substring(0, b.indexOf('_')) : b); }
            if (p > 0) out.put(q.optString("c"), p);
        }
        return out;
    }
    static double num(String s) { try { return Double.parseDouble(s); } catch (Exception e) { return Double.NaN; } }

    static void send(Context ctx, SharedPreferences sp, SharedPreferences.Editor ed, String today, String key, String title, String body) {
        String k = "sent_" + key;
        if (today.equals(sp.getString(k, ""))) return;
        ed.putString(k, today);
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "持股警示（達標離場／跌破停損）", NotificationManager.IMPORTANCE_HIGH));
        }
        Intent open = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, key.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.radar_icon)
                .setContentTitle(title).setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true).setContentIntent(pi);
        try { NotificationManagerCompat.from(ctx).notify(key.hashCode(), b.build()); } catch (SecurityException e) { /* 沒有通知權限 */ }
    }
}
