package tw.ltotokkimo.stockradar;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 原生剪貼簿（11/14）：網頁的 navigator.clipboard.readText() 在 App 內嵌網頁裡，沒有按按鈕時會被拒絕，
 * 所以「從 Claude App 複製回覆、回到金雷達自動載入」要用原生的方式讀。
 * Android 10 起只有畫面在前景且拿到焦點的 App 讀得到；has() 不會讀內容（不會跳出「已從剪貼簿貼上」的系統提示），
 * 網頁端先用 has() 等到拿到焦點，再用 read() 讀一次。
 */
@CapacitorPlugin(name = "Clip")
public class ClipPlugin extends Plugin {
    private ClipboardManager cm() {
        return (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
    }

    /** App 從背景回到前景：通知網頁端（不靠網頁自己的 visibilitychange，那個在有些手機上不一定會觸發） */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        notifyListeners("resume", new JSObject());
    }

    @PluginMethod
    public void has(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject r = new JSObject();
            boolean has = false;
            try {
                ClipboardManager m = cm();
                has = m != null && getActivity().hasWindowFocus() && m.hasPrimaryClip();
            } catch (Exception e) { /* 當作沒有 */ }
            r.put("has", has);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void read(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject r = new JSObject();
            String text = "";
            try {
                ClipboardManager m = cm();
                ClipData c = m == null ? null : m.getPrimaryClip();
                if (c != null && c.getItemCount() > 0) {
                    CharSequence s = c.getItemAt(0).coerceToText(getContext());
                    if (s != null) text = s.toString();
                }
            } catch (Exception e) { /* 讀不到就回空字串 */ }
            r.put("text", text);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void write(PluginCall call) {
        final String text = call.getString("text", "");
        getActivity().runOnUiThread(() -> {
            try {
                ClipboardManager m = cm();
                if (m == null) { call.reject("沒有剪貼簿"); return; }
                m.setPrimaryClip(ClipData.newPlainText("金雷達", text));
                call.resolve();
            } catch (Exception e) {
                call.reject("寫入剪貼簿失敗：" + e.getMessage());
            }
        });
    }
}
