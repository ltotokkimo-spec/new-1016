package tw.ltotokkimo.stockradar;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;

/** 手機內建文字辨識（Google ML Kit 中文模型，離線、免費）：把庫存截圖的文字與位置交給網頁端整理成持股（11/12 使用者要求）。 */
@CapacitorPlugin(name = "TextOcr")
public class TextOcrPlugin extends Plugin {
    @PluginMethod
    public void recognize(PluginCall call) {
        String b64 = call.getString("base64");
        if (b64 == null || b64.isEmpty()) {
            call.reject("沒有圖片");
            return;
        }
        final Bitmap bmp;
        try {
            byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
            bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (Exception e) {
            call.reject("圖片讀取失敗：" + e.getMessage());
            return;
        }
        if (bmp == null) {
            call.reject("圖片格式不支援");
            return;
        }
        final TextRecognizer rec = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
        rec.process(InputImage.fromBitmap(bmp, 0))
            .addOnSuccessListener(text -> {
                JSArray lines = new JSArray();
                for (Text.TextBlock b : text.getTextBlocks()) {
                    for (Text.Line l : b.getLines()) {
                        JSObject o = new JSObject();
                        o.put("text", l.getText());
                        Rect r = l.getBoundingBox();
                        if (r != null) {
                            o.put("x", r.left);
                            o.put("y", r.top);
                            o.put("w", r.width());
                            o.put("h", r.height());
                        }
                        // 每個字詞的位置：同一行裡相隔較遠的欄位（股數、均價）用真實位置拆開
                        JSArray els = new JSArray();
                        for (Text.Element e : l.getElements()) {
                            Rect er = e.getBoundingBox();
                            if (er == null) continue;
                            JSObject eo = new JSObject();
                            eo.put("text", e.getText());
                            eo.put("x", er.left);
                            eo.put("y", er.top);
                            eo.put("w", er.width());
                            eo.put("h", er.height());
                            els.put(eo);
                        }
                        o.put("els", els);
                        lines.put(o);
                    }
                }
                JSObject res = new JSObject();
                res.put("lines", lines);
                res.put("width", bmp.getWidth());
                res.put("height", bmp.getHeight());
                call.resolve(res);
                rec.close();
            })
            .addOnFailureListener(e -> {
                call.reject("文字辨識失敗：" + e.getMessage());
                rec.close();
            });
    }
}
