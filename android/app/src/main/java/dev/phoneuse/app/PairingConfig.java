/** File role: Validates the manually pasted v1 pairing credential before it is stored. */
package dev.phoneuse.app;

import android.util.Base64;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import org.json.JSONObject;

/** Parses and validates the v1 manually pasted pairing code before saving transport credentials. */
final class PairingConfig {
  /** Outbound desktop WebSocket URL, bearer token, and exact certificate DER pin. */
  final String url, token, fingerprint;

  /** Stores the validated v1 fields without retaining the pasted code string. */
  private PairingConfig(String url, String token, String fingerprint) {
    this.url = url;
    this.token = token;
    this.fingerprint = fingerprint;
  }

  /** Decodes only the supported pairing prefix, URL shape, bearer token and certificate pin. */
  static PairingConfig parse(String code) throws Exception {
    if (code == null || !code.startsWith("phoneuse:") || code.length() > 4096)
      throw new IllegalArgumentException("Paste a valid PhoneUse pairing code.");
    byte[] bytes =
        Base64.decode(code.substring(9), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    JSONObject j = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
    if (j.optInt("v", -1) != 1)
      throw new IllegalArgumentException("This pairing code version is not supported.");
    String url = j.getString("url"), token = j.getString("token"), pin = j.getString("fingerprint");
    URI uri = URI.create(url);
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
}
