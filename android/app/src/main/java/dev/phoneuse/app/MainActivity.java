/** File role: Provides the phone-local setup, consent, and app protection controls. */
package dev.phoneuse.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.core.content.ContextCompat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Presents pairing, Android accessibility setup, per-session consent, and the phone-local
 * blocklist.
 */
public final class MainActivity extends Activity {
  /** Live labels for connection, accessibility permission, and blocked packages. */
  private TextView statusView, accessibilityView, blockedView;

  /** Local pairing code input; cleared immediately after valid credentials are stored. */
  private EditText pairingInput, packageInput;

  /** Consent switch held only in process memory. */
  private CheckBox controlCheck;

  /** Root container for the native setup screen. */
  private LinearLayout root;

  /** Prevents state refreshes from being interpreted as a phone user's consent tap. */
  private boolean updatingConsent;

  /** Refreshes labels when the foreground connection service reports a state change. */
  private final BroadcastReceiver stateReceiver =
      new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
          refreshStatus();
        }
      };

  /** Builds the native settings screen while preserving consent already chosen in this process. */
  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().setStatusBarColor(Color.WHITE);
    getWindow().setNavigationBarColor(Color.WHITE);
    getWindow().setDecorFitsSystemWindows(false);
    buildUi();
    refreshStatus();
  }

  /**
   * Refreshes the accessibility and connection state when the user returns from system settings.
   */
  @Override
  protected void onResume() {
    super.onResume();
    if (statusView != null) {
      refreshStatus();
      IntentFilter f = new IntentFilter("dev.phoneuse.app.STATE_CHANGED");
      ContextCompat.registerReceiver(this, stateReceiver, f, ContextCompat.RECEIVER_NOT_EXPORTED);
    }
  }

  @Override
  protected void onPause() {
    try {
      unregisterReceiver(stateReceiver);
    } catch (IllegalArgumentException ignored) {
    }
    super.onPause();
  }

  /** Builds the screen with native controls and safe touch spacing. */
  private void buildUi() {
    ScrollView scroll = new ScrollView(this);
    root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setPadding(dp(22), dp(20), dp(22), dp(28));
    root.setBackgroundColor(Color.WHITE);
    scroll.addView(root);
    root.setOnApplyWindowInsetsListener(
        (v, insets) -> {
          android.graphics.Insets bars =
              insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
          v.setPadding(dp(22), bars.top + dp(16), dp(22), bars.bottom + dp(22));
          return insets;
        });
    TextView title = text("Control your Android phone", 26, true);
    root.addView(title);
    root.addView(
        text(
            "Pair this phone with a computer on the same local network. Control stays off until you"
                + " enable it here.",
            16,
            false),
        margin(0, 8, 0, 20));
    statusView = text("Disconnected", 16, true);
    root.addView(statusView);
    accessibilityView = text("Accessibility access is off", 15, false);
    root.addView(accessibilityView, margin(0, 5, 0, 12));
    Button blockApps = button("Choose apps to block");
    blockApps.setOnClickListener(v -> showAppPicker());
    root.addView(blockApps, margin(0, 0, 0, 8));
    Button access = button("Open Accessibility settings");
    access.setOnClickListener(
        v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
    root.addView(access, margin(0, 0, 0, 20));
    root.addView(text("Pairing code", 19, true));
    root.addView(
        text(
            "Paste the code shown by PhoneUse on your computer, then save it on this phone.",
            15,
            false),
        margin(0, 5, 0, 8));
    pairingInput = new EditText(this);
    pairingInput.setHint("phoneuse:…");
    pairingInput.setMinLines(2);
    pairingInput.setMaxLines(4);
    pairingInput.setInputType(
        InputType.TYPE_CLASS_TEXT
            | InputType.TYPE_TEXT_FLAG_MULTI_LINE
            | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
    root.addView(pairingInput, margin(0, 0, 0, 8));
    Button save = button("Save pairing code");
    save.setOnClickListener(v -> savePairing());
    root.addView(save, margin(0, 0, 0, 8));
    Button connect = button("Connect");
    connect.setOnClickListener(v -> beginConnection());
    root.addView(connect, margin(0, 0, 0, 18));
    controlCheck = new CheckBox(this);
    controlCheck.setText(R.string.allow_control);
    controlCheck.setTextSize(16);
    controlCheck.setMinHeight(dp(52));
    controlCheck.setChecked(PhoneState.controlEnabled);
    controlCheck.setOnCheckedChangeListener(
        (b, checked) -> {
          if (updatingConsent) return;
          PhoneState.controlEnabled = checked;
          PhoneAccessibilityService.invalidateForSessionChange();
          statusView.setText(
              getString(
                  checked ? R.string.status_control_enabled : R.string.status_control_off,
                  PhoneState.connectionStatus));
          sendStatus();
        });
    root.addView(controlCheck, margin(0, 0, 0, 12));
    Button disconnect = button("Disconnect");
    disconnect.setOnClickListener(
        v -> {
          PhoneState.controlEnabled = false;
          controlCheck.setChecked(false);
          startService(
              new Intent(this, ConnectionService.class)
                  .setAction(ConnectionService.ACTION_DISCONNECT));
          refreshStatus();
        });
    root.addView(disconnect, margin(0, 0, 0, 22));
    root.addView(text("Blocked apps", 19, true));
    root.addView(
        text(
            "PhoneUse is always protected. Commands stop when any visible accessibility window"
                + " belongs to a blocked app.",
            15,
            false),
        margin(0, 5, 0, 8));
    blockedView = text("No apps blocked", 15, false);
    root.addView(blockedView, margin(0, 0, 0, 8));
    Button manage = button("Remove blocked apps");
    manage.setOnClickListener(v -> showBlocklistManager());
    root.addView(manage, margin(0, 0, 0, 8));
    packageInput = new EditText(this);
    packageInput.setHint("Package name, for example com.example.app");
    packageInput.setSingleLine(true);
    packageInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    root.addView(packageInput, margin(0, 0, 0, 8));
    Button add = button("Block package name");
    add.setOnClickListener(v -> addManualPackage());
    root.addView(add, margin(0, 0, 0, 12));
    setContentView(scroll);
  }

  /** Saves only valid v1 pairing codes into this app's private preferences. */
  private void savePairing() {
    try {
      PairingConfig config = PairingConfig.parse(pairingInput.getText().toString().trim());
      PhoneState.prefs(this)
          .edit()
          .putString("pair_url", config.url)
          .putString("pair_token", config.token)
          .putString("pair_pin", config.fingerprint)
          .apply();
      pairingInput.setText("");
      showMessage("Pairing code saved on this phone.");
    } catch (Exception e) {
      showMessage(e.getMessage() == null ? "Pairing code is invalid." : e.getMessage());
    }
  }

  /** Starts the visible-user foreground connection service only after a pairing code is saved. */
  private void beginConnection() {
    if (PhoneState.prefs(this).getString("pair_url", null) == null) {
      showMessage("Save a valid pairing code first.");
      return;
    }
    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 5);
    }
    PhoneState.controlEnabled = false;
    syncConsentUi();
    Intent intent =
        new Intent(this, ConnectionService.class).setAction(ConnectionService.ACTION_CONNECT);
    startForegroundService(intent);
    refreshStatus();
  }

  /** Reports current connection and Android service access without exposing pairing material. */
  private void refreshStatus() {
    if (statusView == null) return;
    statusView.setText(
        getString(
            PhoneState.controlEnabled
                ? R.string.status_control_enabled
                : R.string.status_control_off,
            PhoneState.connectionStatus));
    syncConsentUi();
    boolean enabled = PhoneState.accessibilityEnabled(this);
    accessibilityView.setText(enabled ? R.string.accessibility_on : R.string.accessibility_off);
    updateBlocklistLabel();
  }

  /** Mirrors the process-scoped consent state without treating a refresh as a user action. */
  private void syncConsentUi() {
    if (controlCheck != null && controlCheck.isChecked() != PhoneState.controlEnabled) {
      updatingConsent = true;
      controlCheck.setChecked(PhoneState.controlEnabled);
      updatingConsent = false;
    }
  }

  /** Notifies a live service of a local consent change. */
  private void sendStatus() {
    if (PhoneState.connectionStatus.equals("Disconnected")) return;
    ConnectionService.publishLocalStatus();
  }

  /** Lists launcher apps and edits the persisted user-owned blocklist in one native picker. */
  private void showAppPicker() {
    Intent query = new Intent(Intent.ACTION_MAIN);
    query.addCategory(Intent.CATEGORY_LAUNCHER);
    List<ResolveInfo> installed =
        getPackageManager().queryIntentActivities(query, PackageManager.MATCH_ALL);
    Collections.sort(
        installed,
        Comparator.comparing(
            r ->
                String.valueOf(r.loadLabel(getPackageManager()))
                    .toLowerCase(java.util.Locale.ROOT)));
    ArrayList<String> packages = new ArrayList<>(), labels = new ArrayList<>();
    Set<String> selected = blockedPackages();
    for (ResolveInfo info : installed) {
      String pkg = info.activityInfo.packageName;
      if (PhoneState.OWN_PACKAGE.equals(pkg) || packages.contains(pkg)) continue;
      packages.add(pkg);
      labels.add(info.loadLabel(getPackageManager()) + "  ·  " + pkg);
    }
    boolean[] checked = new boolean[packages.size()];
    for (int i = 0; i < packages.size(); i++) checked[i] = selected.contains(packages.get(i));
    new AlertDialog.Builder(this)
        .setTitle("Choose blocked apps")
        .setMultiChoiceItems(
            labels.toArray(new String[0]),
            checked,
            (dialog, which, isChecked) -> checked[which] = isChecked)
        .setNegativeButton("Cancel", null)
        .setPositiveButton(
            "Save",
            (dialog, which) -> {
              HashSet<String> updated = new HashSet<>();
              for (int i = 0; i < packages.size(); i++)
                if (checked[i]) updated.add(packages.get(i));
              for (String old : selected) if (!packages.contains(old)) updated.add(old);
              saveBlocklist(updated);
            })
        .show();
  }

  /** Lets the phone user remove manually added or no-longer-installed package names. */
  private void showBlocklistManager() {
    ArrayList<String> items = new ArrayList<>(blockedPackages());
    Collections.sort(items);
    if (items.isEmpty()) {
      showMessage("There are no blocked apps to remove.");
      return;
    }
    new AlertDialog.Builder(this)
        .setTitle("Remove a blocked app")
        .setItems(
            items.toArray(new String[0]),
            (dialog, which) -> {
              Set<String> updated = blockedPackages();
              updated.remove(items.get(which));
              saveBlocklist(updated);
            })
        .setNegativeButton("Done", null)
        .show();
  }

  /** Adds a syntactically valid package name without granting the remote peer blocklist access. */
  private void addManualPackage() {
    String pkg = packageInput.getText().toString().trim();
    if (!pkg.matches("[A-Za-z0-9_]+(\\.[A-Za-z0-9_]+)+") || PhoneState.OWN_PACKAGE.equals(pkg)) {
      showMessage("Enter a valid app package name. PhoneUse is always blocked.");
      return;
    }
    Set<String> updated = blockedPackages();
    updated.add(pkg);
    saveBlocklist(updated);
    packageInput.setText("");
  }

  /** Reads the current phone-owned blocklist. */
  private Set<String> blockedPackages() {
    String raw = PhoneState.prefs(this).getString("blocked_packages", "");
    HashSet<String> values = new HashSet<>();
    if (raw != null && !raw.isEmpty()) Collections.addAll(values, raw.split("\\n"));
    values.remove(PhoneState.OWN_PACKAGE);
    return values;
  }

  /** Saves the local blocklist and refreshes its concise summary. */
  private void saveBlocklist(Set<String> packages) {
    ArrayList<String> sorted = new ArrayList<>(packages);
    Collections.sort(sorted);
    PhoneState.prefs(this)
        .edit()
        .putString("blocked_packages", android.text.TextUtils.join("\n", sorted))
        .apply();
    updateBlocklistLabel();
  }

  /** Displays only package names chosen locally on the phone. */
  private void updateBlocklistLabel() {
    if (blockedView == null) return;
    Set<String> packages = blockedPackages();
    blockedView.setText(
        packages.isEmpty() ? "No apps blocked" : android.text.TextUtils.join("\n", packages));
  }

  /** Creates a readable native text element with the app's standard ink color. */
  private TextView text(String value, int size, boolean bold) {
    TextView v = new TextView(this);
    v.setText(value);
    v.setTextColor(Color.rgb(26, 32, 44));
    v.setTextSize(size);
    if (bold) v.setTypeface(null, android.graphics.Typeface.BOLD);
    return v;
  }

  /** Creates a sentence-case native button with comfortable default touch height. */
  private Button button(String label) {
    Button b = new Button(this);
    b.setText(label);
    b.setAllCaps(false);
    b.setTextSize(16);
    return b;
  }

  /** Creates a full-width layout slot with density-scaled margins. */
  private LinearLayout.LayoutParams margin(int left, int top, int right, int bottom) {
    LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
    p.setMargins(dp(left), dp(top), dp(right), dp(bottom));
    return p;
  }

  /** Converts design-independent pixels to this device's physical pixel scale. */
  private int dp(float value) {
    return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
  }

  /** Shows a brief local validation or save result. */
  private void showMessage(String message) {
    new AlertDialog.Builder(this).setMessage(message).setPositiveButton("OK", null).show();
  }
}
