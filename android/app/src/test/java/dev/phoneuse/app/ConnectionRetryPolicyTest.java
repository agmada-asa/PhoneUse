/** File role: Verifies bounded reconnect timing and LAN network eligibility without Android services. */
package dev.phoneuse.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Exercises deterministic retry policy edges used by ConnectionService. */
public final class ConnectionRetryPolicyTest {
  /** Confirms jitter endpoints remain inside the documented backoff window. */
  @Test
  public void jitterStaysBetweenHalfAndFullBaseDelay() {
    assertEquals(500, ConnectionRetryPolicy.jitteredDelayMillis(1000, 500));
    assertEquals(1000, ConnectionRetryPolicy.jitteredDelayMillis(1000, 1000));
  }

  /** Confirms exponential backoff is bounded and remains capped on later retries. */
  @Test
  public void backoffDoublesUntilOneMinuteCap() {
    assertEquals(2000, ConnectionRetryPolicy.nextBaseDelayMillis(ConnectionRetryPolicy.INITIAL_DELAY_MS));
    assertEquals(ConnectionRetryPolicy.MAX_DELAY_MS, ConnectionRetryPolicy.nextBaseDelayMillis(30000));
    assertEquals(ConnectionRetryPolicy.MAX_DELAY_MS, ConnectionRetryPolicy.nextBaseDelayMillis(60000));
  }

  /** Confirms local Wi-Fi and Ethernet remain eligible without Internet capability. */
  @Test
  public void localNetworksCanWakeReconnect() {
    assertFalse(ConnectionRetryPolicy.isSuitableNetwork(false, false, false));
    assertTrue(ConnectionRetryPolicy.isSuitableNetwork(false, true, false));
    assertTrue(ConnectionRetryPolicy.isSuitableNetwork(false, false, true));
    assertTrue(ConnectionRetryPolicy.isSuitableNetwork(true, false, false));
  }
}
