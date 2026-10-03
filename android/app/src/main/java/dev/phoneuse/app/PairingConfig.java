/** File role: Validates the pasted or scanned v1 pairing credential before it is stored. */
package dev.phoneuse.app;

import android.util.Base64;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import org.json.JSONException;
import org.json.JSONObject;

/** Parses and validates a v1 pairing code before saving transport credentials. */
final class PairingConfig {
  /** Outbound desktop WebSocket URL, bearer token, and exact certificate DER pin. */
  final String url, token, fingerprint;

  /** Stores the validated v1 fields without retaining the pasted code string. */
  private PairingConfig(String url, String token, String fingerprint) {
    this.url = url;
    this.token = token;
    this.fingerprint = fingerprint;
  }

  /** Returns only the validated computer host and port for an on-phone confirmation. */
  String displayAddress() {
    URI uri = URI.create(url);
    return uri.getHost() + (uri.getPort() < 0 ? "" : ":" + uri.getPort());
  }

  /** Decodes only the supported pairing prefix, URL shape, bearer token and certificate pin. */
  static PairingConfig parse(String code) throws Exception {
    if (code == null || !code.startsWith("phoneuse:") || code.length() > 4096)
      throw new IllegalArgumentException("Enter or scan a valid Phone Use pairing code.");
    byte[] bytes;
    try {
      bytes = Base64.decode(code.substring(9), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    } catch (IllegalArgumentException e) {
      throw invalidFormat();
    }
    JSONObject j;
    try {
      j = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
    } catch (JSONException e) {
      throw invalidFormat();
    }
    if (j.optInt("v", -1) != 1)
      throw new IllegalArgumentException("This pairing code version is not supported.");
    String url, token, pin;
    try {
      url = j.getString("url");
      token = j.getString("token");
      pin = j.getString("fingerprint");
    } catch (JSONException e) {
      throw invalidFormat();
    }
    URI uri;
    try {
      uri = URI.create(url);
    } catch (IllegalArgumentException e) {
      throw invalidFormat();
    }
    if (!"wss".equals(uri.getScheme())
        || uri.getHost() == null
        || uri.getUserInfo() != null
        || uri.getQuery() != null
        || uri.getFragment() != null
        || !"/phone".equals(uri.getPath()))
      throw new IllegalArgumentException(
          "Pairing URL must be a wss /phone address without credentials or extra parameters.");
    if (!token.matches("[0-9a-fA-F]{64}") || !pin.matches("[0-9a-f]{64}"))
      throw new IllegalArgumentException("Pairing token or certificate fingerprint is invalid.");
    return new PairingConfig(uri.toString(), token, pin.toLowerCase(Locale.ROOT));
  }

  /** Returns a fixed message for malformed encoded input without exposing its contents. */
  private static IllegalArgumentException invalidFormat() {
    return new IllegalArgumentException("Pairing code format is invalid.");
  }
}
