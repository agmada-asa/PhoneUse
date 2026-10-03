/**
 * Provides deterministic controls for isolated Android end-to-end tests without touching personal
 * apps.
 */
package dev.phoneuse.fixture;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Hosts predictable accessible controls for exercising PhoneUse snapshots and actions on an
 * emulator.
 */
public final class FixtureActivity extends Activity {
  private TextView counter;
  private int count;

  /** Builds the fixture screen with stable IDs and system-bar-safe spacing. */
  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    if (state != null) count = state.getInt("count", 0);
    getWindow().setStatusBarColor(Color.WHITE);
    getWindow().setNavigationBarColor(Color.WHITE);
    if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);

    ScrollView scroller = new ScrollView(this);
    LinearLayout content = new LinearLayout(this);
    content.setOrientation(LinearLayout.VERTICAL);
    content.setPadding(dp(20), dp(16), dp(20), dp(24));
    content.setBackgroundColor(Color.WHITE);
    scroller.addView(content);
    if (Build.VERSION.SDK_INT >= 30) {
      content.setOnApplyWindowInsetsListener(
          (view, insets) -> {
            android.graphics.Insets bars =
                insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            view.setPadding(dp(20), bars.top + dp(16), dp(20), bars.bottom + dp(24));
            return insets;
          });
    }

    content.addView(text("PhoneUse test screen", 24, true));
    content.addView(text("Text entry and button action", 17, true), margin(0, 18, 0, 4));

    EditText input = new EditText(this);
    input.setId(R.id.input);
    input.setSingleLine(true);
    input.setHint("Enter test text");
    input.setInputType(
        android.text.InputType.TYPE_CLASS_TEXT
            | android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
    content.addView(input, margin(0, 0, 0, 8));

    counter = text("Button presses: " + count, 16, false);
    counter.setId(R.id.counter);
    content.addView(counter, margin(0, 0, 0, 4));
    Button increment = button("Increment counter");
    increment.setOnClickListener(
        view -> {
          count++;
          counter.setText("Button presses: " + count);
        });
    content.addView(increment, margin(0, 0, 0, 12));

    content.addView(text("Password redaction check", 17, true), margin(0, 8, 0, 4));
    EditText password = new EditText(this);
    password.setId(R.id.password);
    password.setSingleLine(true);
    password.setHint("Password content must stay hidden");
    password.setInputType(
        android.text.InputType.TYPE_CLASS_TEXT
            | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
    password.setText("fixture-only-secret");
    content.addView(password, margin(0, 0, 0, 12));

    Button secure = button("Open secure screen");
    secure.setOnClickListener(view -> startActivity(new Intent(this, SecureActivity.class)));
    content.addView(secure, margin(0, 0, 0, 16));

    content.addView(text("Scrollable content", 17, true), margin(0, 4, 0, 4));
    for (int i = 1; i <= 30; i++) {
      content.addView(text("List item " + i, 16, false), margin(0, 7, 0, 7));
    }
    setContentView(scroller);
  }

  /** Retains the visible counter when the system recreates this activity. */
  @Override
  protected void onSaveInstanceState(Bundle state) {
    state.putInt("count", count);
    super.onSaveInstanceState(state);
  }

  /** Creates readable fixture text with consistent color and type weight. */
  private TextView text(String value, int size, boolean bold) {
    TextView view = new TextView(this);
    view.setText(value);
    view.setTextColor(Color.rgb(26, 32, 44));
    view.setTextSize(size);
    if (bold) view.setTypeface(null, android.graphics.Typeface.BOLD);
    return view;
  }

  /** Creates a native button with sentence-case fixture copy. */
  private Button button(String label) {
    Button button = new Button(this);
    button.setText(label);
    button.setAllCaps(false);
    return button;
  }

  /** Creates a full-width content row with margins in density-independent units. */
  private LinearLayout.LayoutParams margin(int left, int top, int right, int bottom) {
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
    params.setMargins(dp(left), dp(top), dp(right), dp(bottom));
    return params;
  }

  /** Converts density-independent pixels for the current display. */
  private int dp(float value) {
    return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
  }
}
