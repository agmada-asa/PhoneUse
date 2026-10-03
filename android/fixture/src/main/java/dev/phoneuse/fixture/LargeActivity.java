/** Builds a dense visible grid for testing useful-node selection beyond the response ceiling. */
package dev.phoneuse.fixture;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.widget.Button;
import android.widget.EditText;
import android.widget.GridLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Places useful controls after a visible collection to expose result-cap starvation. */
public final class LargeActivity extends Activity {
  /** Grid dimensions exceed the bridge response limit while remaining on screen. */
  private static final int GRID_ROWS = 27;
  private static final int GRID_COLUMNS = 20;

  /** Creates more than 500 visible low-value cells before the important controls. */
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
    content.addView(label("Large hierarchy fixture"));
    Button traversal = new Button(this);
    traversal.setText("Open bounded traversal");
    traversal.setAllCaps(false);
    traversal.setOnClickListener(view -> startActivity(new android.content.Intent(this, DeepActivity.class)));
    content.addView(traversal);
    GridLayout grid = new GridLayout(this);
    grid.setRowCount(GRID_ROWS);
    grid.setColumnCount(GRID_COLUMNS);
    for (int index = 0; index < GRID_ROWS * GRID_COLUMNS; index++) {
      TextView cell = label("·");
      cell.setTextSize(8);
      cell.setMinWidth(dp(13));
      cell.setMinHeight(dp(13));
      GridLayout.LayoutParams params = new GridLayout.LayoutParams(
          GridLayout.spec(index / GRID_COLUMNS), GridLayout.spec(index % GRID_COLUMNS));
      params.width = dp(13);
      params.height = dp(13);
      grid.addView(cell, params);
    }
    grid.setContentDescription("Dense test grid with low-priority cells");
    content.addView(grid);

    EditText importantInput = new EditText(this);
    importantInput.setSingleLine(true);
    importantInput.setHint("Priority input");
    content.addView(importantInput);
    Button importantButton = new Button(this);
    importantButton.setText("Priority action");
    importantButton.setAllCaps(false);
    importantButton.setOnClickListener(view -> importantButton.setText("Priority action complete"));
    content.addView(importantButton);
    setContentView(scroll);
  }

  /** Creates low-cost, readable text nodes that do not expose device data. */
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
