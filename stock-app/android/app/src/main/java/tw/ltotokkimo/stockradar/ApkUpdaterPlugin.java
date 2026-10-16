package tw.ltotokkimo.stockradar;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** App 內更新：下載新版 APK 到快取資料夾，再交給 Android 的安裝程式（使用者按「更新」確認）。 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {
    private volatile boolean busy = false;

    @PluginMethod
    public void getVersion(PluginCall call) {
        try {
            Context ctx = getContext();
            PackageInfo info = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
            JSObject r = new JSObject();
            r.put("versionCode", code);
            r.put("versionName", info.versionName);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** Android 8 以上要先允許「安裝不明應用程式」 */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject r = new JSObject();
        r.put("allowed", Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(r);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 26) {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        call.resolve();
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        if (url == null) { call.reject("缺少下載網址"); return; }
        if (busy) { call.reject("正在下載中"); return; }
        busy = true;
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                dir.mkdirs();
                File apk = new File(dir, "stock-radar.apk");
                File part = new File(dir, "stock-radar.apk.part");
                // GitHub 下載會轉址到另一個網域，手動跟隨
                URL u = new URL(url);
                for (int hop = 0; ; hop++) {
                    conn = (HttpURLConnection) u.openConnection();
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(20000);
                    conn.setReadTimeout(60000);
                    conn.setRequestProperty("User-Agent", "StockRadar-Updater");
                    int code = conn.getResponseCode();
                    if (code >= 300 && code < 400 && hop < 5) {
                        u = new URL(u, conn.getHeaderField("Location"));
                        conn.disconnect();
                        continue;
                    }
                    if (code != 200) throw new Exception("下載失敗 HTTP " + code);
                    break;
                }
                long total = conn.getContentLengthLong();
                try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(part)) {
                    byte[] buf = new byte[64 * 1024];
                    long done = 0, lastEmit = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        done += n;
                        long now = System.currentTimeMillis();
                        if (now - lastEmit > 300) {
                            lastEmit = now;
                            JSObject p = new JSObject();
                            p.put("done", done);
                            p.put("total", total);
                            notifyListeners("progress", p);
                        }
                    }
                }
                if (total > 0 && part.length() != total) throw new Exception("下載不完整，請再試一次");
                if (apk.exists()) apk.delete();
                if (!part.renameTo(apk)) throw new Exception("無法儲存安裝檔");

                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                JSObject r = new JSObject();
                r.put("bytes", apk.length());
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
                busy = false;
            }
        }).start();
    }
}
