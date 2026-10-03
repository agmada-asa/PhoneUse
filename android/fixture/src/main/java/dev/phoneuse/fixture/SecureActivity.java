/** Provides a FLAG_SECURE test window for verifying that capture cannot expose protected pixels. */
package dev.phoneuse.fixture;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.TextView;

/** Shows a secure window so screenshot capture can be checked for a clear failure. */
public final class SecureActivity extends Activity {
  /** Marks this isolated activity secure and displays a recognizable test message. */
  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    getWindow().setStatusBarColor(Color.WHITE);
    getWindow().setNavigationBarColor(Color.WHITE);
    TextView message = new TextView(this);
    message.setText("Secure test screen\nScreenshot capture should fail clearly.");
    message.setTextSize(22);
    message.setTextColor(Color.rgb(26, 32, 44));
    message.setPadding(dp(24), dp(32), dp(24), dp(24));
    setContentView(message);
  }

  /** Converts density-independent pixels for the current display. */
  private int dp(float value) {
    return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
  }
}
