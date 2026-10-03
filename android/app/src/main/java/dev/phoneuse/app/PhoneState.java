/** File role: Stores local pairing and blocklist preferences plus process-only consent state. */
package dev.phoneuse.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.provider.Settings;
import android.text.TextUtils;
import java.util.UUID;

/**
 * Holds local pairing preferences and per-process consent; remote data never changes the blocklist.
 */
final class PhoneState {
  /** Immutable package protected from every remote command. */
  static final String OWN_PACKAGE = "dev.phoneuse.app";

  /** Explicit remote-control consent; false until a phone user checks the local switch. */
  static volatile boolean controlEnabled = false;

  /** Whether the phone user or bridge explicitly stopped the current session. */
  static volatile boolean explicitlyDisconnected = true;

  /** UI label for the active connection lifecycle. */
  static volatile String connectionStatus = "Disconnected";

  /** Live Android accessibility service, null whenever local access is unavailable. */
  static volatile PhoneAccessibilityService accessibility;

  /** Name of private preference storage for credentials and the phone-owned blocklist. */
  private static final String PREFS = "phoneuse_local";

  private PhoneState() {}

  /** Returns private local preferences. Pairing data stays off backups and logs. */
  static SharedPreferences prefs(Context context) {
    return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  /** Returns a stable random device id, creating it locally once. */
  static String deviceId(Context context) {
    SharedPreferences p = prefs(context);
    String id = p.getString("device_id", null);
    if (id == null) {
      id = UUID.randomUUID().toString();
      p.edit().putString("device_id", id).apply();
    }
    return id;
  }

  /** Reports whether the user enabled this app in Android Accessibility settings. */
  static boolean accessibilityEnabled(Context context) {
    String enabled =
        Settings.Secure.getString(
            context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
    if (TextUtils.isEmpty(enabled)) return false;
    for (String component : enabled.split(":")) {
      ComponentName name = ComponentName.unflattenFromString(component);
      if (name != null && OWN_PACKAGE.equals(name.getPackageName())) return true;
    }
    return false;
  }
}
