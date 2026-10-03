/** File role: Keeps reconnect backoff and network eligibility deterministic for the connection service. */
package dev.phoneuse.app;

/** Pure retry calculations shared by the connection service and local unit tests. */
final class ConnectionRetryPolicy {
  /** First retry delay in milliseconds. */
  static final long INITIAL_DELAY_MS = 1000;
  /** Maximum retry delay in milliseconds. */
  static final long MAX_DELAY_MS = 60000;

  private ConnectionRetryPolicy() {}

  /** Returns a delay with a validated 50–100 percent jitter factor. */
  static long jitteredDelayMillis(long baseDelayMs, int jitterPermille) {
    if (baseDelayMs < 1 || baseDelayMs > MAX_DELAY_MS) throw new IllegalArgumentException("Invalid retry delay");
    if (jitterPermille < 500 || jitterPermille > 1000) throw new IllegalArgumentException("Invalid retry jitter");
    return Math.max(1, baseDelayMs * jitterPermille / 1000);
  }

  /** Doubles the retry delay while keeping it within the one-minute ceiling. */
  static long nextBaseDelayMillis(long baseDelayMs) {
    if (baseDelayMs < 1 || baseDelayMs > MAX_DELAY_MS) throw new IllegalArgumentException("Invalid retry delay");
    return Math.min(MAX_DELAY_MS, baseDelayMs * 2);
  }

  /** Accepts Internet connections plus Wi-Fi or Ethernet networks used for local bridges. */
  static boolean isSuitableNetwork(boolean hasInternet, boolean isWifi, boolean isEthernet) {
    return hasInternet || isWifi || isEthernet;
  }
}
