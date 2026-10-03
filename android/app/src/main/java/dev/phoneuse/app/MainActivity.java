/** File role: Provides the phone-local setup, consent, and app protection controls. */
package dev.phoneuse.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.InsetDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;
import androidx.core.content.ContextCompat;
import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;
import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Presents pairing, Android accessibility setup, per-session consent, and the phone-local
 * blocklist as a status card with one next action, followed by setup and protection cards.
 * Styling follows the EightForge palette: warm paper, ink, and brand blue, in light and dark.
 */
public final class MainActivity extends Activity {
  /** Connection lifecycle as shown to the phone user, derived from the service status text. */
  private enum Stage {
    NOT_PAIRED,
    DISCONNECTED,
    CONNECTING,
    CONNECTED
  }

  /** Theme colors resolved once for the current light or dark configuration. */
  private int paper, card, ink, muted, sunk, line, brand, ok, okSoft, warn, warnSoft, danger;

  /** Status card views that change with connection and consent state. */
  private TextView pill, headline, detail;

  /** The status card's single contextual next action, plus disconnect while a session exists. */
  private Button primaryAction, disconnectButton;

  /** Setup rows that reflect accessibility and pairing state. */
  private TextView accessibilityStatus, pairingStatus, blockedView;

  /** Setup actions shown or hidden as state changes. */
  private Button accessibilityAction, accessibilityHelp, rescanAction, pasteToggle, packageToggle;

  /** Collapsible manual-entry sections; hidden until the phone user asks for them. */
  private LinearLayout pastePanel, packagePanel;

  /** Local pairing code input; cleared immediately after valid credentials are stored. */
  private EditText pairingInput, packageInput;

  /** Consent switch held only in process memory. */
  private Switch controlSwitch;

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
    resolvePalette();
    getWindow().setStatusBarColor(paper);
    getWindow().setNavigationBarColor(paper);
    getWindow().setDecorFitsSystemWindows(false);
    getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    buildUi();
    refreshStatus();
    if (handlePairingIntent(getIntent())) clearIncomingPairingIntent();
  }

  /** Handles scanner links delivered to an already visible singleTop activity. */
  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    if (handlePairingIntent(intent)) clearIncomingPairingIntent();
  }

  /**
   * Refreshes the accessibility and connection state when the user returns from system settings.
   */
  @Override
  protected void onResume() {
    super.onResume();
    if (headline != null) {
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

  /** Reports whether the system is in night mode, which selects the dark palette. */
  private boolean isDark() {
    return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
        == Configuration.UI_MODE_NIGHT_YES;
  }

  /** Picks the EightForge light or dark palette for the current configuration. */
  private void resolvePalette() {
    boolean dark = isDark();
    paper = dark ? 0xFF0E0D0B : 0xFFF3F0E8;
    card = dark ? 0xFF181613 : 0xFFFFFDF8;
    ink = dark ? 0xFFF3F0E8 : 0xFF14130F;
    muted = dark ? 0xFFA89F91 : 0xFF6E6659;
    sunk = dark ? 0xFF24211C : 0xFFE7E0D3;
    line = dark ? 0x1FFFFFFF : 0x1F14130F;
    brand = 0xFF286BF1;
    ok = dark ? 0xFF8FD1A6 : 0xFF2F6B47;
    okSoft = dark ? 0x248FD1A6 : 0xFFDCEBDF;
    warn = dark ? 0xFFF0C27A : 0xFF8A5A12;
    warnSoft = dark ? 0x24F0C27A : 0xFFF3E3C4;
    danger = dark ? 0xFFFEB2B2 : 0xFF8B3022;
  }

  /** Builds the screen: header, status card, setup card, and protected apps card. */
  private void buildUi() {
    ScrollView scroll = new ScrollView(this);
    scroll.setBackgroundColor(paper);
    root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setFocusableInTouchMode(true);
    scroll.addView(root);
    // Clip at the status bar so scrolled content never draws underneath it.
    scroll.setClipToPadding(true);
    scroll.addOnLayoutChangeListener(
        (v, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
          if (bottom - top == oldBottom - oldTop) return;
          View focused = v.findFocus();
          if (focused != null && focused != v) {
            focused.requestRectangleOnScreen(
                new android.graphics.Rect(0, 0, focused.getWidth(), focused.getHeight()), true);
          }
        });
    scroll.setOnApplyWindowInsetsListener(
        (v, insets) -> {
          android.graphics.Insets bars =
              insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
          android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
          v.setPadding(0, bars.top, 0, 0);
          root.setPadding(dp(16), dp(12), dp(16), bars.bottom + dp(24));
          int keyboardMargin = insets.isVisible(WindowInsets.Type.ime()) ? ime.bottom : 0;
          FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) v.getLayoutParams();
          if (params.bottomMargin != keyboardMargin) {
            params.bottomMargin = keyboardMargin;
            v.setLayoutParams(params);
          }
          return insets;
        });

    root.addView(header(), margin(4, 0, 4, 16));
    root.addView(statusCard(), margin(0, 0, 0, 12));
    root.addView(setupCard(), margin(0, 0, 0, 12));
    root.addView(protectedAppsCard(), margin(0, 0, 0, 0));
    setContentView(scroll);
  }

  /** Brand mark, wordmark, and the live connection pill. */
  private View header() {
    LinearLayout row = horizontal();
    row.setMinimumHeight(dp(48));
    ImageView mark = new ImageView(this);
    mark.setImageResource(R.drawable.ic_mark);
    mark.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
    row.addView(mark, new LinearLayout.LayoutParams(dp(15), dp(20)));
    TextView name = text("Phone Use", 19, ink, true);
    name.setLetterSpacing(-0.02f);
    LinearLayout.LayoutParams nameParams = weighted();
    nameParams.leftMargin = dp(8);
    row.addView(name, nameParams);
    pill = text("", 13, ink, true);
    pill.setPadding(dp(12), dp(6), dp(12), dp(6));
    pill.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    row.addView(pill, wrap());
    return row;
  }

  /** The main card: what is happening now, the next action, and the consent switch. */
  private View statusCard() {
    LinearLayout card = card();
    headline = text("", 24, ink, true);
    headline.setLetterSpacing(-0.03f);
    card.addView(headline);
    detail = text("", 15, muted, false);
    card.addView(detail, margin(0, 6, 0, 16));
    primaryAction = button("", Style.PRIMARY);
    card.addView(primaryAction, margin(0, 0, 0, 0));

    controlSwitch = new Switch(this);
    controlSwitch.setText(R.string.allow_control);
    controlSwitch.setTextSize(16);
    controlSwitch.setTextColor(ink);
    controlSwitch.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    controlSwitch.setMinHeight(dp(56));
    controlSwitch.setPadding(dp(16), dp(8), dp(12), dp(8));
    controlSwitch.setBackground(rounded(sunk, 0, 16));
    controlSwitch.setThumbTintList(switchColors(Color.WHITE, isDark() ? 0xFFD1CABF : Color.WHITE));
    controlSwitch.setTrackTintList(switchColors(brand, isDark() ? 0x55FFFFFF : 0x4014130F));
    controlSwitch.setChecked(PhoneState.controlEnabled);
    controlSwitch.setOnCheckedChangeListener(
        (b, checked) -> {
          if (updatingConsent) return;
          PhoneState.controlEnabled = checked;
          PhoneAccessibilityService.invalidateForSessionChange();
          sendStatus();
          refreshStatus();
        });
    card.addView(controlSwitch, margin(0, 4, 0, 0));

    disconnectButton = button("Disconnect", Style.DESTRUCTIVE);
    disconnectButton.setOnClickListener(
        v -> {
          PhoneState.controlEnabled = false;
          syncConsentUi();
          startService(
              new Intent(this, ConnectionService.class)
                  .setAction(ConnectionService.ACTION_DISCONNECT));
          refreshStatus();
        });
    card.addView(disconnectButton, margin(0, 12, 0, 0));
    return card;
  }

  /** Accessibility and pairing rows, each with its own small action. */
  private View setupCard() {
    LinearLayout card = card();
    card.addView(sectionTitle("Setup"));

    LinearLayout access = setupRow("Accessibility");
    accessibilityStatus = (TextView) access.getTag();
    accessibilityAction = button("Turn on", Style.OUTLINE_SMALL);
    accessibilityAction.setOnClickListener(
        v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
    access.addView(accessibilityAction, wrap());
    card.addView(access, margin(0, 8, 0, 0));
    accessibilityHelp = button("Setup help", Style.LINK);
    accessibilityHelp.setOnClickListener(v -> showAccessibilityHelp());
    card.addView(accessibilityHelp, wrapMargin(-10, 0, 0, 4));

    card.addView(divider(), margin(0, 4, 0, 8));

    LinearLayout pairing = setupRow("Computer");
    pairingStatus = (TextView) pairing.getTag();
    card.addView(pairing);
    LinearLayout pairActions = horizontal();
    // Before pairing, the status card already offers scanning; this row adds re-pairing.
    rescanAction = button("Scan a new code", Style.OUTLINE_SMALL);
    rescanAction.setOnClickListener(v -> startQrScan());
    pairActions.addView(rescanAction, wrapMargin(0, 0, 4, 0));
    pasteToggle = button("Paste a code instead", Style.LINK);
    pasteToggle.setOnClickListener(v -> togglePanel(pastePanel, pasteToggle));
    pairActions.addView(pasteToggle, wrap());
    card.addView(pairActions, margin(0, 10, 0, 0));

    pastePanel = vertical();
    pastePanel.setVisibility(View.GONE);
    pairingInput = input("phoneuse:…");
    pairingInput.setMinLines(2);
    pairingInput.setMaxLines(4);
    pairingInput.setInputType(
        InputType.TYPE_CLASS_TEXT
            | InputType.TYPE_TEXT_FLAG_MULTI_LINE
            | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
    pastePanel.addView(pairingInput, margin(0, 0, 0, 8));
    Button save = button("Save pairing code", Style.PRIMARY);
    save.setOnClickListener(v -> savePairing());
    pastePanel.addView(save, wrap());
    card.addView(pastePanel, margin(0, 10, 0, 0));
    return card;
  }

  /** The phone-owned blocklist, with the app picker first and manual entry tucked away. */
  private View protectedAppsCard() {
    LinearLayout card = card();
    card.addView(sectionTitle("Protected apps"));
    card.addView(
        text(
            "The computer can't read or control these apps, or Phone Use itself. Commands stop"
                + " while one is on screen.",
            14,
            muted,
            false),
        margin(0, 4, 0, 12));
    blockedView = text("", 15, ink, false);
    blockedView.setLineSpacing(dp(4), 1f);
    blockedView.setPadding(dp(14), dp(12), dp(14), dp(12));
    blockedView.setBackground(rounded(sunk, 0, 14));
    card.addView(blockedView, margin(0, 0, 0, 12));
    LinearLayout actions = horizontal();
    Button choose = button("Choose apps", Style.OUTLINE_SMALL);
    choose.setOnClickListener(v -> showAppPicker());
    actions.addView(choose, wrap());
    packageToggle = button("Add by package name", Style.LINK);
    packageToggle.setOnClickListener(v -> togglePanel(packagePanel, packageToggle));
    LinearLayout.LayoutParams toggleParams = wrap();
    toggleParams.leftMargin = dp(4);
    actions.addView(packageToggle, toggleParams);
    card.addView(actions);

    packagePanel = vertical();
    packagePanel.setVisibility(View.GONE);
    packagePanel.addView(
        text("For apps missing from the list, or to remove ones no longer installed.", 14, muted,
            false),
        margin(0, 0, 0, 8));
    packageInput = input("Package name, for example com.example.app");
    packageInput.setSingleLine(true);
    packageInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    packagePanel.addView(packageInput, margin(0, 0, 0, 8));
    LinearLayout packageActions = horizontal();
    Button add = button("Block package name", Style.PRIMARY);
    add.setOnClickListener(v -> addManualPackage());
    packageActions.addView(add, wrap());
    Button manage = button("Remove blocked apps", Style.LINK);
    manage.setOnClickListener(v -> showBlocklistManager());
    LinearLayout.LayoutParams manageParams = wrap();
    manageParams.leftMargin = dp(4);
    packageActions.addView(manage, manageParams);
    packagePanel.addView(packageActions);
    card.addView(packagePanel, margin(0, 12, 0, 0));
    return card;
  }

  /** Shows or hides an optional manual-entry panel and keeps its toggle's label honest. */
  private void togglePanel(LinearLayout panel, Button toggle) {
    boolean open = panel.getVisibility() != View.VISIBLE;
    panel.setVisibility(open ? View.VISIBLE : View.GONE);
    if (panel == pastePanel) toggle.setText(open ? "Hide code entry" : "Paste a code instead");
    else toggle.setText(open ? "Hide package entry" : "Add by package name");
    if (open) panel.getChildAt(panel == pastePanel ? 0 : 1).requestFocus();
  }

  /** Opens the QR-only camera scanner without retaining camera frames or decoded text in logs. */
  private void startQrScan() {
    IntentIntegrator scanner = new IntentIntegrator(this);
    scanner.setDesiredBarcodeFormats(IntentIntegrator.QR_CODE);
    scanner.setPrompt("Scan the pairing QR code shown by Phone Use on your computer");
    scanner.setBeepEnabled(false);
    scanner.setOrientationLocked(false);
    scanner.initiateScan();
  }

  /** Validates scan output and asks the phone user to confirm the computer address before saving. */
  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    IntentResult result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
    if (result == null) return;
    String code = result.getContents();
    if (code == null) {
      showMessage(
          "Scan canceled or camera access was denied. Allow Camera in Phone Use app permissions"
              + " and try again, or paste a pairing code.");
      return;
    }
    confirmPairingCode(code, "This QR code");
  }

  /** Routes validated Phone Use links from external scanners through the same confirmation flow. */
  private boolean handlePairingIntent(Intent intent) {
    if (intent == null
        || !Intent.ACTION_VIEW.equals(intent.getAction())
        || intent.getData() == null
        || !"phoneuse".equalsIgnoreCase(intent.getData().getScheme())) return false;
    Uri data = intent.getData();
    String code = data.toString();
    if (!data.isOpaque()
        || data.getEncodedAuthority() != null
        || data.getEncodedFragment() != null
        || code.length() > 4096) {
      showMessage("Enter or scan a valid Phone Use pairing code.");
      return true;
    }
    confirmPairingCode(code, "This link");
    return true;
  }

  /** Removes incoming credentials from the Activity's retained launch Intent after handling. */
  private void clearIncomingPairingIntent() {
    setIntent(new Intent(this, MainActivity.class));
  }

  /** Validates pairing data and confirms the computer address before storing credentials. */
  private void confirmPairingCode(String code, String source) {
    try {
      PairingConfig config = PairingConfig.parse(code);
      String address = config.displayAddress();
      new AlertDialog.Builder(this)
          .setTitle("Save this pairing?")
          .setMessage(source + " will pair with " + address + ".")
          .setNegativeButton("Cancel", (dialog, which) -> showMessage("Pairing was not saved."))
          .setPositiveButton("Save pairing", (dialog, which) -> savePairing(config))
          .show();
    } catch (Exception e) {
      showMessage(e.getMessage() == null ? "Pairing code is invalid." : e.getMessage());
    }
  }

  /** Explains Android's sideload restriction and offers the app-info page for the manual override. */
  private void showAccessibilityHelp() {
    new AlertDialog.Builder(this)
        .setTitle("Allow accessibility access")
        .setMessage(
            "Android can block accessibility access for apps installed outside an app store."
                + " Open Phone Use app info, tap the three-dot menu, and choose Allow restricted"
                + " settings. Then return here and enable Phone Use in Accessibility settings.")
        .setNegativeButton("Close", null)
        .setNeutralButton("Open app info", (dialog, which) -> openAppInfo())
        .setPositiveButton(
            "Open Accessibility settings",
            (dialog, which) -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)))
        .show();
  }

  /** Opens this package's Android app-info page so the phone user can allow restricted settings. */
  private void openAppInfo() {
    Intent intent =
        new Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", getPackageName(), null));
    startActivity(intent);
  }

  /** Saves only valid v1 pairing codes into this app's private preferences. */
  private void savePairing() {
    try {
      PairingConfig config = PairingConfig.parse(pairingInput.getText().toString().trim());
      savePairing(config);
    } catch (Exception e) {
      showMessage(e.getMessage() == null ? "Pairing code is invalid." : e.getMessage());
    }
  }

  /**
   * Stores validated credentials in private preferences without retaining the source code, then
   * connects when idle. Connecting grants nothing: control stays off until the switch is turned on.
   */
  private void savePairing(PairingConfig config) {
    PhoneState.prefs(this)
        .edit()
        .putString("pair_url", config.url)
        .putString("pair_token", config.token)
        .putString("pair_pin", config.fingerprint)
        .apply();
    pairingInput.setText("");
    pairingInput.clearFocus();
    pastePanel.setVisibility(View.GONE);
    pasteToggle.setText("Paste a code instead");
    root.requestFocus();
    getSystemService(android.view.inputmethod.InputMethodManager.class)
        .hideSoftInputFromWindow(pairingInput.getWindowToken(), 0);
    if (stage() == Stage.DISCONNECTED) {
      Toast.makeText(this, "Pairing saved. Connecting to your computer.", Toast.LENGTH_SHORT)
          .show();
      beginConnection();
    } else {
      showMessage("Pairing saved. Disconnect, then connect to use the new computer.");
      refreshStatus();
    }
  }

  /** Starts the visible-user foreground connection service only after a pairing code is saved. */
  private void beginConnection() {
    if (PhoneState.prefs(this).getString("pair_url", null) == null) {
      showMessage("Scan or paste a pairing code first.");
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

  /** Returns the saved computer's host and port, or null before pairing. */
  private String pairedAddress() {
    String url = PhoneState.prefs(this).getString("pair_url", null);
    if (url == null) return null;
    try {
      URI uri = URI.create(url);
      return uri.getHost() + (uri.getPort() < 0 ? "" : ":" + uri.getPort());
    } catch (IllegalArgumentException e) {
      return null;
    }
  }

  /** Maps the service's status text and saved pairing onto the four visible stages. */
  private Stage stage() {
    String status = PhoneState.connectionStatus;
    if ("Connected".equals(status)) return Stage.CONNECTED;
    if (status.startsWith("Connecting")
        || status.startsWith("Connection lost")
        || status.startsWith("Could not connect")) return Stage.CONNECTING;
    return pairedAddress() == null ? Stage.NOT_PAIRED : Stage.DISCONNECTED;
  }

  /**
   * Shows the current stage with one next action, without exposing pairing material. Consent is
   * only offered once connected with accessibility on, since it cannot take effect otherwise.
   */
  private void refreshStatus() {
    if (headline == null) return;
    syncConsentUi();
    boolean access = PhoneState.accessibilityEnabled(this);
    String address = pairedAddress();
    Stage stage = stage();
    primaryAction.setVisibility(View.VISIBLE);
    primaryAction.setOnClickListener(null);
    switch (stage) {
      case NOT_PAIRED:
        setPill("Not paired", sunk, muted);
        headline.setText("Pair with your computer");
        detail.setText(
            "On your computer, open the Phone Use console and select Show pairing QR code. Then"
                + " scan it here."
                + " Both devices must be on the same Wi-Fi.");
        primaryAction.setText("Scan pairing QR code");
        primaryAction.setOnClickListener(v -> startQrScan());
        break;
      case DISCONNECTED:
        if (!"Disconnected".equals(PhoneState.connectionStatus)) {
          setPill("Connection problem", warnSoft, warn);
          headline.setText("Connection needs attention");
          detail.setText(PhoneState.connectionStatus);
        } else {
          setPill("Disconnected", sunk, muted);
          headline.setText("Ready to connect");
          detail.setText(
              "Paired with " + address + ". Connecting lets the computer see that this phone is"
                  + " available. It can't do anything until you allow control.");
        }
        primaryAction.setText("Connect");
        primaryAction.setOnClickListener(v -> beginConnection());
        break;
      case CONNECTING:
        setPill("Connecting", warnSoft, warn);
        headline.setText("Connecting…");
        detail.setText(
            PhoneState.connectionStatus.startsWith("Connecting")
                ? "Reaching " + address + ". Make sure the computer bridge is running."
                : PhoneState.connectionStatus
                    + ". Make sure the computer bridge is running and both devices are on the"
                    + " same Wi-Fi.");
        primaryAction.setVisibility(View.GONE);
        break;
      case CONNECTED:
        if (!access) {
          setPill("Connected", warnSoft, warn);
          headline.setText("Turn on accessibility");
          detail.setText(
              "Phone Use needs accessibility access to read the screen and tap for the computer."
                  + " Enable Phone Use in the list that opens.");
          primaryAction.setText("Open Accessibility settings");
          primaryAction.setOnClickListener(
              v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        } else if (!PhoneState.controlEnabled) {
          setPill("Connected", okSoft, ok);
          headline.setText("Connected");
          detail.setText(
              "Control is off. The computer can't see or touch anything until you allow it"
                  + " below.");
          primaryAction.setVisibility(View.GONE);
        } else {
          setPill("Control on", brand, Color.WHITE);
          headline.setText("Computer has control");
          detail.setText(
              "It can read the screen and act in apps you haven't protected. Turn control off or"
                  + " disconnect at any time.");
          primaryAction.setVisibility(View.GONE);
        }
        break;
    }
    controlSwitch.setVisibility(stage == Stage.CONNECTED && access ? View.VISIBLE : View.GONE);
    disconnectButton.setVisibility(
        stage == Stage.CONNECTED || stage == Stage.CONNECTING ? View.VISIBLE : View.GONE);
    disconnectButton.setText(stage == Stage.CONNECTING ? "Stop connecting" : "Disconnect");

    accessibilityStatus.setText(access ? "On" : "Off. Needed to read the screen and tap.");
    accessibilityStatus.setTextColor(access ? ok : muted);
    accessibilityAction.setVisibility(access ? View.GONE : View.VISIBLE);
    accessibilityHelp.setVisibility(access ? View.GONE : View.VISIBLE);
    pairingStatus.setText(address == null ? "Not paired yet" : "Paired with " + address);
    pairingStatus.setTextColor(address == null ? muted : ok);
    rescanAction.setVisibility(address == null ? View.GONE : View.VISIBLE);
    ((LinearLayout.LayoutParams) pasteToggle.getLayoutParams()).leftMargin =
        address == null ? dp(-10) : 0;
    updateBlocklistLabel();
  }

  /** Mirrors the process-scoped consent state without treating a refresh as a user action. */
  private void syncConsentUi() {
    if (controlSwitch != null && controlSwitch.isChecked() != PhoneState.controlEnabled) {
      updatingConsent = true;
      controlSwitch.setChecked(PhoneState.controlEnabled);
      updatingConsent = false;
    }
  }

  /** Notifies a live service of a local consent change. */
  private void sendStatus() {
    if (PhoneState.connectionStatus.equals("Disconnected")) return;
    ConnectionService.publishLocalStatus();
  }

  /** One launcher app offered by the protected apps picker. */
  private static final class AppChoice {
    final String packageName, label;

    AppChoice(String packageName, String label) {
      this.packageName = packageName;
      this.label = label;
    }
  }

  /**
   * Opens a searchable picker of launcher apps, styled like the rest of the screen, and saves the
   * checked apps to the persisted user-owned blocklist. Blocked packages that are no longer
   * launchable are kept unchanged.
   */
  private void showAppPicker() {
    PackageManager pm = getPackageManager();
    Intent query = new Intent(Intent.ACTION_MAIN);
    query.addCategory(Intent.CATEGORY_LAUNCHER);
    ArrayList<AppChoice> apps = new ArrayList<>();
    HashSet<String> listed = new HashSet<>();
    for (ResolveInfo info : pm.queryIntentActivities(query, PackageManager.MATCH_ALL)) {
      String pkg = info.activityInfo.packageName;
      if (PhoneState.OWN_PACKAGE.equals(pkg) || !listed.add(pkg)) continue;
      apps.add(new AppChoice(pkg, String.valueOf(info.loadLabel(pm))));
    }
    Collections.sort(apps, (a, b) -> a.label.compareToIgnoreCase(b.label));
    Set<String> original = blockedPackages();
    HashSet<String> selected = new HashSet<>(original);
    HashMap<String, Drawable> icons = new HashMap<>();
    ArrayList<AppChoice> visible = new ArrayList<>(apps);

    Dialog dialog = new Dialog(this, android.R.style.Theme_DeviceDefault_Dialog_NoActionBar);
    LinearLayout sheet = vertical();
    sheet.setPadding(0, dp(20), 0, dp(12));

    LinearLayout heading = vertical();
    heading.setPadding(dp(20), 0, dp(20), 0);
    TextView title = sectionTitle("Choose protected apps");
    heading.addView(title);
    TextView count = text("", 14, muted, false);
    count.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    heading.addView(count, margin(0, 2, 0, 12));
    EditText search = input("Search apps");
    search.setSingleLine(true);
    search.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
    heading.addView(search, margin(0, 0, 0, 8));
    sheet.addView(heading);

    TextView empty = text("No apps match your search.", 15, muted, false);
    empty.setGravity(Gravity.CENTER);
    empty.setPadding(dp(20), dp(32), dp(20), dp(32));
    empty.setVisibility(View.GONE);
    sheet.addView(empty, margin(0, 0, 0, 0));

    ListView list = new ListView(this);
    list.setDivider(null);
    list.setSelector(android.R.color.transparent);
    list.setClipToPadding(false);
    list.setPadding(dp(8), 0, dp(8), dp(8));
    Runnable updateCount =
        () ->
            count.setText(
                selected.isEmpty()
                    ? "No apps protected yet"
                    : selected.size() + (selected.size() == 1 ? " app" : " apps") + " protected");
    BaseAdapter adapter =
        new BaseAdapter() {
          @Override
          public int getCount() {
            return visible.size();
          }

          @Override
          public AppChoice getItem(int position) {
            return visible.get(position);
          }

          @Override
          public long getItemId(int position) {
            return position;
          }

          @Override
          public View getView(int position, View convertView, android.view.ViewGroup parent) {
            View row = convertView != null ? convertView : appRow();
            AppRowViews views = (AppRowViews) row.getTag();
            AppChoice app = getItem(position);
            Drawable icon = icons.get(app.packageName);
            if (icon == null) {
              try {
                icon = pm.getApplicationIcon(app.packageName);
              } catch (PackageManager.NameNotFoundException e) {
                icon = pm.getDefaultActivityIcon();
              }
              icons.put(app.packageName, icon);
            }
            boolean on = selected.contains(app.packageName);
            views.icon.setImageDrawable(icon);
            views.label.setText(app.label);
            views.packageName.setText(app.packageName);
            styleCheck(views.check, on);
            row.setBackground(
                withRipple(rounded(on ? sunk : Color.TRANSPARENT, 0, 16), rippleColor()));
            row.setContentDescription(app.label + (on ? ", protected" : ", not protected"));
            return row;
          }
        };
    list.setAdapter(adapter);
    list.setOnItemClickListener(
        (parent, view, position, id) -> {
          String pkg = visible.get(position).packageName;
          if (!selected.remove(pkg)) selected.add(pkg);
          adapter.notifyDataSetChanged();
          updateCount.run();
        });
    sheet.addView(list, new LinearLayout.LayoutParams(-1, 0, 1f));

    search.addTextChangedListener(
        new android.text.TextWatcher() {
          @Override
          public void beforeTextChanged(CharSequence s, int start, int count, int after) {}

          @Override
          public void onTextChanged(CharSequence s, int start, int before, int count) {}

          @Override
          public void afterTextChanged(android.text.Editable s) {
            String needle = s.toString().trim().toLowerCase(Locale.ROOT);
            visible.clear();
            for (AppChoice app : apps)
              if (needle.isEmpty()
                  || app.label.toLowerCase(Locale.ROOT).contains(needle)
                  || app.packageName.toLowerCase(Locale.ROOT).contains(needle)) visible.add(app);
            adapter.notifyDataSetChanged();
            empty.setVisibility(visible.isEmpty() ? View.VISIBLE : View.GONE);
          }
        });

    LinearLayout footer = horizontal();
    footer.setGravity(Gravity.CENTER_VERTICAL | Gravity.END);
    footer.setPadding(dp(16), dp(12), dp(16), 0);
    Button cancel = button("Cancel", Style.LINK);
    cancel.setOnClickListener(v -> dialog.dismiss());
    footer.addView(cancel, wrap());
    Button save = button("Save", Style.PRIMARY);
    save.setOnClickListener(
        v -> {
          // Keep blocked packages the picker could not show, such as uninstalled apps.
          HashSet<String> updated = new HashSet<>(selected);
          for (String old : original) if (!listed.contains(old)) updated.add(old);
          saveBlocklist(updated);
          dialog.dismiss();
        });
    footer.addView(save, wrapMargin(8, 0, 0, 0));
    sheet.addView(footer);

    updateCount.run();
    dialog.setContentView(sheet);
    android.view.Window window = dialog.getWindow();
    window.setBackgroundDrawable(
        new InsetDrawable(rounded(card, line, 24), dp(12), dp(16), dp(12), dp(16)));
    // Fill the screen inside the inset margins so the keyboard can shrink the list, not hide Save.
    window.setLayout(-1, -1);
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    dialog.show();
  }

  /** Views inside one recycled picker row, kept as the row's tag. */
  private static final class AppRowViews {
    ImageView icon, check;
    TextView label, packageName;
  }

  /** Builds one reusable picker row: app icon, name and package, and a round check on the right. */
  private View appRow() {
    AppRowViews views = new AppRowViews();
    LinearLayout row = horizontal();
    row.setMinimumHeight(dp(64));
    row.setPadding(dp(12), dp(8), dp(12), dp(8));
    views.icon = new ImageView(this);
    views.icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
    row.addView(views.icon, new LinearLayout.LayoutParams(dp(40), dp(40)));
    LinearLayout labels = vertical();
    views.label = text("", 16, ink, true);
    views.label.setSingleLine(true);
    views.label.setEllipsize(TextUtils.TruncateAt.END);
    labels.addView(views.label);
    views.packageName = text("", 13, muted, false);
    views.packageName.setSingleLine(true);
    views.packageName.setEllipsize(TextUtils.TruncateAt.MIDDLE);
    labels.addView(views.packageName);
    LinearLayout.LayoutParams labelParams = weighted();
    labelParams.leftMargin = dp(14);
    labelParams.rightMargin = dp(12);
    row.addView(labels, labelParams);
    views.check = new ImageView(this);
    views.check.setPadding(dp(4), dp(4), dp(4), dp(4));
    views.check.setImageTintList(ColorStateList.valueOf(paper));
    views.check.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
    row.addView(views.check, new LinearLayout.LayoutParams(dp(24), dp(24)));
    row.setTag(views);
    return row;
  }

  /** Draws the picker's round check: filled with a tick when protected, an empty ring otherwise. */
  private void styleCheck(ImageView check, boolean on) {
    check.setImageResource(on ? R.drawable.ic_check : 0);
    check.setBackground(
        on
            ? rounded(brand, 0, 999)
            : rounded(Color.TRANSPARENT, isDark() ? 0x59FFFFFF : 0x5914130F, 999));
  }

  /** Touch feedback color for transparent controls in the current theme. */
  private int rippleColor() {
    return isDark() ? 0x33FFFFFF : 0x2214130F;
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
      showMessage("Enter a valid app package name. Phone Use is always blocked.");
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

  /** Lists blocked apps by name where installed, falling back to the package name. */
  private void updateBlocklistLabel() {
    if (blockedView == null) return;
    ArrayList<String> names = new ArrayList<>();
    for (String pkg : blockedPackages()) {
      try {
        names.add(
            String.valueOf(
                getPackageManager()
                    .getApplicationLabel(getPackageManager().getApplicationInfo(pkg, 0))));
      } catch (PackageManager.NameNotFoundException e) {
        names.add(pkg);
      }
    }
    Collections.sort(names, String.CASE_INSENSITIVE_ORDER);
    blockedView.setText(
        names.isEmpty() ? "No apps protected yet" : TextUtils.join("\n", names));
    blockedView.setTextColor(names.isEmpty() ? muted : ink);
  }

  /** Visual button variants, matching the EightForge pill buttons. */
  private enum Style {
    PRIMARY,
    OUTLINE_SMALL,
    DESTRUCTIVE,
    LINK
  }

  /** Creates a sentence-case pill button with a comfortable touch target. */
  private Button button(String label, Style style) {
    Button b = new Button(this);
    b.setText(label);
    b.setAllCaps(false);
    b.setStateListAnimator(null);
    b.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    b.setLetterSpacing(-0.01f);
    b.setMinHeight(dp(48));
    b.setMinimumHeight(dp(48));
    b.setMinWidth(0);
    b.setMinimumWidth(0);
    int ripple = isDark() ? 0x33FFFFFF : 0x2214130F;
    switch (style) {
      case PRIMARY:
        b.setTextSize(16);
        b.setTextColor(paper);
        b.setPadding(dp(22), 0, dp(22), 0);
        b.setBackground(withRipple(rounded(ink, 0, 999), 0x33FFFFFF));
        break;
      case OUTLINE_SMALL:
        b.setTextSize(14);
        b.setTextColor(ink);
        b.setPadding(dp(16), 0, dp(16), 0);
        b.setBackground(withRipple(rounded(Color.TRANSPARENT, isDark() ? 0x40FFFFFF : 0x5914130F, 999), ripple));
        break;
      case DESTRUCTIVE:
        b.setTextSize(15);
        b.setTextColor(danger);
        b.setPadding(dp(18), 0, dp(18), 0);
        b.setBackground(withRipple(rounded(Color.TRANSPARENT, isDark() ? 0x4DF5DEDA : 0x669F4234, 999), ripple));
        break;
      case LINK:
        b.setTextSize(14);
        b.setTextColor(isDark() ? 0xFF93BCF8 : 0xFF1E53CB);
        b.setPadding(dp(10), 0, dp(10), 0);
        b.setBackground(withRipple(rounded(Color.TRANSPARENT, 0, 999), ripple));
        break;
    }
    return b;
  }

  /** Creates a readable native text element. */
  private TextView text(String value, int size, int color, boolean bold) {
    TextView v = new TextView(this);
    v.setText(value);
    v.setTextColor(color);
    v.setTextSize(size);
    v.setLineSpacing(0, 1.15f);
    if (bold) v.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    return v;
  }

  /** A section heading inside a card. */
  private TextView sectionTitle(String value) {
    TextView v = text(value, 18, ink, true);
    v.setLetterSpacing(-0.02f);
    v.setAccessibilityHeading(true);
    return v;
  }

  /** A rounded, bordered card container. */
  private LinearLayout card() {
    LinearLayout c = vertical();
    c.setPadding(dp(20), dp(20), dp(20), dp(20));
    c.setBackground(rounded(card, line, 22));
    return c;
  }

  /**
   * A setup row with a title and a status line on the left. The status view is stored as the
   * row's tag so the caller can update it; actions are appended on the right.
   */
  private LinearLayout setupRow(String title) {
    LinearLayout row = horizontal();
    LinearLayout labels = vertical();
    labels.addView(text(title, 16, ink, true));
    TextView status = text("", 14, muted, false);
    labels.addView(status);
    row.addView(labels, weighted());
    row.setTag(status);
    return row;
  }

  /** A hairline separator between setup rows. */
  private View divider() {
    View v = new View(this);
    v.setBackgroundColor(line);
    v.setLayoutParams(new LinearLayout.LayoutParams(-1, Math.max(1, dp(1) / 2)));
    return v;
  }

  /** A themed text field with a rounded sunken background. */
  private EditText input(String hint) {
    EditText e = new EditText(this);
    e.setHint(hint);
    e.setTextColor(ink);
    e.setHintTextColor(muted);
    e.setTextSize(14);
    e.setMinHeight(dp(48));
    e.setPadding(dp(14), dp(12), dp(14), dp(12));
    e.setBackground(rounded(sunk, 0, 12));
    return e;
  }

  /** Builds a rounded rectangle with an optional hairline stroke. */
  private GradientDrawable rounded(int fill, int stroke, int radiusDp) {
    GradientDrawable d = new GradientDrawable();
    d.setColor(fill);
    d.setCornerRadius(dp(radiusDp));
    if (stroke != 0) d.setStroke(Math.max(1, dp(1)), stroke);
    return d;
  }

  /** Adds touch feedback on top of a shape. */
  private RippleDrawable withRipple(GradientDrawable shape, int rippleColor) {
    return new RippleDrawable(ColorStateList.valueOf(rippleColor), shape, null);
  }

  /** Colors for a switch part in its checked and unchecked states. */
  private ColorStateList switchColors(int checked, int unchecked) {
    return new ColorStateList(
        new int[][] {new int[] {android.R.attr.state_checked}, new int[] {}},
        new int[] {checked, unchecked});
  }

  /** Updates the header status pill's text and colors. */
  private void setPill(String label, int background, int foreground) {
    pill.setText(label);
    pill.setTextColor(foreground);
    pill.setBackground(rounded(background, 0, 999));
  }

  /** A vertical linear layout. */
  private LinearLayout vertical() {
    LinearLayout l = new LinearLayout(this);
    l.setOrientation(LinearLayout.VERTICAL);
    return l;
  }

  /** A horizontal, vertically centered linear layout. */
  private LinearLayout horizontal() {
    LinearLayout l = new LinearLayout(this);
    l.setOrientation(LinearLayout.HORIZONTAL);
    l.setGravity(Gravity.CENTER_VERTICAL);
    return l;
  }

  /** Layout params that take the remaining width in a horizontal row. */
  private LinearLayout.LayoutParams weighted() {
    return new LinearLayout.LayoutParams(0, -2, 1f);
  }

  /** Layout params sized to content. */
  private LinearLayout.LayoutParams wrap() {
    return new LinearLayout.LayoutParams(-2, -2);
  }

  /** Content-sized layout params with density-scaled margins. */
  private LinearLayout.LayoutParams wrapMargin(int left, int top, int right, int bottom) {
    LinearLayout.LayoutParams p = wrap();
    p.setMargins(dp(left), dp(top), dp(right), dp(bottom));
    return p;
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
