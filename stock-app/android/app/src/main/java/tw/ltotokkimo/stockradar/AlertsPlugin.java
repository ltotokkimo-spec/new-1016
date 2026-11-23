package tw.ltotokkimo.stockradar;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;

/**
 * 持股警示推播（11/23 使用者）：網頁端把「我的實單」「雙引擎實單」要盯的持股交給這裡，
 * 用 WorkManager 每 15 分鐘在背景檢查一次（AlertWorker），達標離場或跌破停損就跳手機通知。
 */
@CapacitorPlugin(name = "Alerts", permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) })
public class AlertsPlugin extends Plugin {
    static final String PREFS = "radar_alerts";
    static final String WORK = "radar-holding-alerts";

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    static boolean granted(Context c) {
        return Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void setWatch(PluginCall call) {
        String items = call.getString("items", "[]");
        int n = 0;
        try { n = new JSONArray(items).length(); } catch (Exception e) { items = "[]"; }
        prefs(getContext()).edit().putString("items", items).apply();
        WorkManager wm = WorkManager.getInstance(getContext());
        if (n > 0) {
            Constraints c = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
            PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(AlertWorker.class, 15, TimeUnit.MINUTES).setConstraints(c).build();
            wm.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, req);
        } else {
            wm.cancelUniqueWork(WORK);
        }
        JSObject r = new JSObject();
        r.put("count", n);
        call.resolve(r);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject r = new JSObject(); r.put("granted", granted(getContext())); call.resolve(r); return;
        }
        requestPermissionForAlias("notifications", call, "permCallback");
    }

    @PermissionCallback
    private void permCallback(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", granted(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void status(PluginCall call) {
        int n = 0;
        try { n = new JSONArray(prefs(getContext()).getString("items", "[]")).length(); } catch (Exception e) { /* 0 */ }
        JSObject r = new JSObject();
        r.put("count", n);
        r.put("granted", granted(getContext()));
        r.put("scheduled", n > 0);
        call.resolve(r);
    }
}
