package tw.ltotokkimo.stockradar;

import android.os.Bundle;
import android.os.SystemClock;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** 啟動畫面的雷達掃描動畫轉一圈的時間（和 avd_radar.xml 的 duration 一致） */
    private static final long ONE_TURN_MS = 1000;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 讓雷達完整轉一圈才切到 App 畫面
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        final long start = SystemClock.uptimeMillis();
        splash.setKeepOnScreenCondition(() -> SystemClock.uptimeMillis() - start < ONE_TURN_MS);
        registerPlugin(ApkUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
