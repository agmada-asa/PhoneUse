/** Builds an over-budget accessibility tree with one early, independently scannable branch. */
package dev.phoneuse.fixture;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Combines a deep useful branch with broad later siblings for bounded-traversal checks. */
public final class DeepActivity extends Activity {
  /** Broad sibling count exceeds the total traversal visit ceiling. */
  private static final int DECORATIVE_NODE_COUNT = 5200;
  /** Useful content depth remains reachable when scoped directly to its branch. */
  private static final int NESTING_DEPTH = 48;

  /** Places a small, useful branch before a broad branch that exceeds the total visit ceiling. */
  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().setStatusBarColor(Color.WHITE);
    getWindow().setNavigationBarColor(Color.WHITE);

    ScrollView scroll = new ScrollView(this);
    LinearLayout content = new LinearLayout(this);
    content.setOrientation(LinearLayout.VERTICAL);
    content.setPadding(dp(16), dp(16), dp(16), dp(24));
    scroll.addView(content);

    LinearLayout usefulBranch = new LinearLayout(this);
    usefulBranch.setId(R.id.deep_section);
    usefulBranch.setOrientation(LinearLayout.VERTICAL);
    usefulBranch.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
    LinearLayout parent = usefulBranch;
    for (int depth = 0; depth < NESTING_DEPTH; depth++) {
      LinearLayout nested = new LinearLayout(this);
      nested.setOrientation(LinearLayout.VERTICAL);
      nested.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
      parent.addView(nested);
      parent = nested;
    }
    parent.addView(label("Deep scoped target"));
    content.addView(usefulBranch);

    LinearLayout broadBranch = new LinearLayout(this);
    broadBranch.setOrientation(LinearLayout.VERTICAL);
    broadBranch.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
    broadBranch.addView(label("Broad branch"));
    for (int index = 0; index < DECORATIVE_NODE_COUNT; index++) {
      broadBranch.addView(label("Broad decorative row " + index));
    }
    content.addView(broadBranch);
    setContentView(scroll);
  }

  /** Creates harmless text nodes with consistent labels and contrast. */
  private TextView label(String value) {
    TextView text = new TextView(this);
    text.setText(value);
    text.setTextColor(Color.rgb(26, 32, 44));
    return text;
  }

  /** Converts density-independent pixels for the current display. */
  private int dp(float value) {
    return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
  }
}
