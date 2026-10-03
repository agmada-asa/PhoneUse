/** File role: Inspects visible accessibility windows and enforces local command safety checks. */
package dev.phoneuse.app;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Path;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Owns on-device accessibility inspection and action execution behind consent and blocklist checks.
 */
public final class PhoneAccessibilityService extends AccessibilityService {
  /** Hard traversal and text bounds for one semantic observation. */
  private static final int NODE_LIMIT = 500, TEXT_LIMIT = 300;

  /** Main-thread handler for framework accessibility reads and actions. */
  private final Handler main = new Handler(Looper.getMainLooper());

  /** Changes on observed screen, consent, and connection transitions. */
  private volatile long generation = 0;

  /** Last serialized snapshot, used to scope node IDs and detect stale actions. */
  private JSONObject lastSnapshot;

  /** Framework node handles retained only for the current snapshot. */
  private final List<AccessibilityNodeInfo> lastNodes = new ArrayList<>();

  /** App package for each retained node, checked before semantic actions. */
  private final List<String> lastNodeWindows = new ArrayList<>();

  /** Package represented by the latest active-window semantic observation. */
  private String observedPackageName = "";

  /** Earliest next screenshot time, enforced on the serialized command worker. */
  private long lastScreenshotAt;

  /** Publishes this service only while Android has it connected. */
  @Override
  public void onServiceConnected() {
    super.onServiceConnected();
    PhoneState.accessibility = this;
    generation++;
    clearLastNodes();
    lastSnapshot = null;
    observedPackageName = "";
    ConnectionService.publishLocalStatus();
  }

  /** Invalidates node references whenever the observed accessibility UI changes. */
  @Override
  public void onAccessibilityEvent(AccessibilityEvent event) {
    int type = event.getEventType();
    boolean windowTransition =
        type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            || type == AccessibilityEvent.TYPE_WINDOWS_CHANGED;
    CharSequence eventPackage = event.getPackageName();
    boolean observedContentChange =
        (type == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
                || type == AccessibilityEvent.TYPE_VIEW_SCROLLED)
            && eventPackage != null
            && eventPackage.toString().equals(observedPackageName);
    if (windowTransition || observedContentChange) {
      generation++;
      clearLastNodes();
      lastSnapshot = null;
      observedPackageName = "";
    }
  }

  /** Stops consent and cached actions when Android interrupts service feedback. */
  @Override
  public void onInterrupt() {
    clearLastNodes();
    lastSnapshot = null;
    observedPackageName = "";
    PhoneState.controlEnabled = false;
    generation++;
    ConnectionService.publishLocalStatus();
  }

  /** Clears consent and cached node handles when Android unbinds disabled accessibility access. */
  @Override
  public boolean onUnbind(android.content.Intent intent) {
    clearLastNodes();
    lastSnapshot = null;
    observedPackageName = "";
    PhoneState.accessibility = null;
    PhoneState.controlEnabled = false;
    generation++;
    ConnectionService.publishLocalStatus();
    return super.onUnbind(intent);
  }

  @Override
  public void onDestroy() {
    clearLastNodes();
    lastSnapshot = null;
    observedPackageName = "";
    PhoneState.accessibility = null;
    PhoneState.controlEnabled = false;
    generation++;
    ConnectionService.publishLocalStatus();
    super.onDestroy();
  }

  /** Invalidates retained semantic node references on session and consent changes. */
  static void invalidateForSessionChange() {
    PhoneAccessibilityService service = PhoneState.accessibility;
    if (service != null) {
      service.generation++;
      service.main.post(
          () -> {
            service.clearLastNodes();
            service.lastSnapshot = null;
            service.observedPackageName = "";
          });
    }
  }

  /** Validates the command envelope and runs an allowed method on the Android main thread. */
  JSONObject runCommand(JSONObject command, long deadline) throws Exception {
    if (!(command.opt("method") instanceof String)
        || !(command.opt("params") instanceof JSONObject))
      throw invalid("Command fields are invalid.");
    String method = command.getString("method");
    JSONObject params = command.getJSONObject("params");
    final JSONObject commandParams = params;
    checkDeadline(deadline);
    validateProperties(method, commandParams);
    if ("screenshot".equals(method)) {
      long captureGeneration =
          onMain(
              () -> {
                checkDeadline(deadline);
                enforceLocalGuards();
                return generation;
              });
      JSONObject captured;
      try {
        captured = screenshot();
      } catch (CommandFailure e) {
        throw e;
      } catch (Exception e) {
        throw new CommandFailure("CAPTURE_FAILED", "Screen capture could not be processed.");
      }
      onMain(
          () -> {
            checkDeadline(deadline);
            enforceLocalGuards();
            if (generation != captureGeneration)
              throw new CommandFailure(
                  "STALE_SNAPSHOT", "The screen changed during capture. Observe again.");
            return Boolean.TRUE;
          });
      return captured;
    }
    if ("tap".equals(method) || "swipe".equals(method)) {
      GestureWait wait =
          onMain(
              () -> {
                checkDeadline(deadline);
                enforceLocalGuards();
                return beginGesture(commandParams, "swipe".equals(method), deadline);
              });
      if (!wait.accepted) throw new CommandFailure("ACTION_FAILED", "The gesture could not start.");
      boolean finished = wait.latch.await(4, TimeUnit.SECONDS);
      if (!finished) {
        CommandFailure timeout =
            new CommandFailure("ACTION_TIMEOUT", "The gesture did not finish in time.");
        wait.requestCancel(timeout);
        main.post(() -> requestGestureRelease(wait));
        wait.latch.await(250, TimeUnit.MILLISECONDS);
        throw timeout;
      }
      if (wait.failure != null) throw wait.failure;
      if (!wait.completed.get())
        throw new CommandFailure("ACTION_FAILED", "The gesture did not complete.");
      checkDeadline(deadline);
      return new JSONObject().put("performed", true);
    }
    return onMain(
        () -> {
          checkDeadline(deadline);
          enforceLocalGuards();
          switch (method) {
            case "snapshot":
              return snapshot();
            case "click":
              return click(commandParams);
            case "set_text":
              return setText(commandParams);
            case "global_action":
              return globalAction(commandParams);
            default:
              throw new CommandFailure("INVALID_COMMAND", "Unsupported command method.");
          }
        });
  }

  /**
   * Ensures consent, service availability, lock state and every visible window's package policy.
   */
  private void enforceLocalGuards() throws CommandFailure {
    if (!PhoneState.controlEnabled)
      throw new CommandFailure("CONTROL_DISABLED", "Enable control on your phone.");
    if (!PhoneState.accessibilityEnabled(this) || PhoneState.accessibility != this)
      throw new CommandFailure(
          "ACCESSIBILITY_DISABLED", "Enable PhoneUse accessibility access on your phone.");
    android.app.KeyguardManager keyguard =
        (android.app.KeyguardManager) getSystemService(KEYGUARD_SERVICE);
    if (keyguard != null && keyguard.isKeyguardLocked())
      throw new CommandFailure("SCREEN_LOCKED", "Unlock your phone before controlling it.");
    Set<String> blocked = getBlockedPackages();
    List<AccessibilityWindowInfo> windows = getWindows();
    if (windows == null || windows.isEmpty())
      throw new CommandFailure("APP_BLOCKED", "Phone control is unavailable on this screen.");
    boolean activeRootFound = false;
    for (AccessibilityWindowInfo window : windows) {
      AccessibilityNodeInfo root = window.getRoot();
      if (root == null)
        throw new CommandFailure("APP_BLOCKED", "Phone control is unavailable on this screen.");
      CharSequence packageName = root.getPackageName();
      if (packageName == null || packageName.length() == 0)
        throw new CommandFailure("APP_BLOCKED", "Phone control is unavailable on this screen.");
      if (window.isActive()) activeRootFound = true;
      if (packageName != null
          && (PhoneState.OWN_PACKAGE.equals(packageName.toString())
              || blocked.contains(packageName.toString()))) {
        throw new CommandFailure("APP_BLOCKED", "Phone control is unavailable on this screen.");
      }
    }
    if (!activeRootFound)
      throw new CommandFailure("APP_BLOCKED", "Phone control is unavailable on this screen.");
  }

  /** Returns the phone-local package blocklist, always including PhoneUse itself. */
  private Set<String> getBlockedPackages() {
    HashSet<String> result = new HashSet<>();
    result.add(PhoneState.OWN_PACKAGE);
    String raw = PhoneState.prefs(this).getString("blocked_packages", "");
    if (raw != null) for (String item : raw.split("\\n")) if (!item.isEmpty()) result.add(item);
    return result;
  }

  /** Builds a bounded semantic snapshot and retains node references only for this UI generation. */
  private JSONObject snapshot() throws Exception {
    AccessibilityWindowInfo active = null;
    for (AccessibilityWindowInfo w : getWindows())
      if (w.isActive()) {
        active = w;
        break;
      }
    AccessibilityNodeInfo root = active == null ? getRootInActiveWindow() : active.getRoot();
    if (root == null)
      throw new CommandFailure("CAPTURE_FAILED", "The current screen could not be inspected.");
    String packageName = root.getPackageName() == null ? "" : root.getPackageName().toString();
    android.util.DisplayMetrics metrics = new android.util.DisplayMetrics();
    getSystemService(android.view.WindowManager.class).getDefaultDisplay().getRealMetrics(metrics);
    long startGeneration = generation;
    JSONArray nodes = new JSONArray();
    clearLastNodes();
    lastSnapshot = null;
    observedPackageName = "";
    ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
    queue.add(root);
    Set<AccessibilityNodeInfo> seen = new HashSet<>();
    int visited = 0;
    while (!queue.isEmpty() && lastNodes.size() < NODE_LIMIT && visited < 5000) {
      AccessibilityNodeInfo node = queue.removeFirst();
      visited++;
      if (!seen.add(node)) continue;
      Rect bounds = new Rect();
      node.getBoundsInScreen(bounds);
      String nodePackage =
          node.getPackageName() == null ? packageName : node.getPackageName().toString();
      boolean password = node.isPassword();
      if (node.isVisibleToUser()
          && bounds.intersect(0, 0, metrics.widthPixels, metrics.heightPixels)
          && bounds.width() > 0
          && bounds.height() > 0) {
        JSONObject item = new JSONObject();
        String id = Integer.toString(lastNodes.size());
        item.put("id", id);
        putBounded(item, "text", password ? null : node.getText());
        if (!password) putBounded(item, "description", node.getContentDescription());
        putBounded(item, "viewId", node.getViewIdResourceName());
        putBounded(item, "className", node.getClassName());
        item.put(
            "bounds",
            new JSONObject()
                .put("left", bounds.left)
                .put("top", bounds.top)
                .put("right", bounds.right)
                .put("bottom", bounds.bottom));
        item.put("clickable", node.isClickable());
        item.put("editable", node.isEditable() && !password);
        item.put("scrollable", node.isScrollable());
        item.put("enabled", node.isEnabled());
        nodes.put(item);
        lastNodes.add(AccessibilityNodeInfo.obtain(node));
        lastNodeWindows.add(nodePackage);
      }
      if (!password)
        for (int i = 0; i < node.getChildCount() && visited < 5000; i++) {
          AccessibilityNodeInfo child = node.getChild(i);
          if (child != null) queue.addLast(child);
        }
    }
    boolean truncated = !queue.isEmpty() || visited >= 5000;
    String snapshotId = UUID.randomUUID().toString();
    long madeAt = generation;
    if (startGeneration != madeAt)
      throw new CommandFailure(
          "STALE_SNAPSHOT", "The screen changed during observation. Observe again.");
    lastSnapshot =
        new JSONObject()
            .put("snapshotId", snapshotId)
            .put("packageName", packageName)
            .put(
                "screen",
                new JSONObject()
                    .put("width", metrics.widthPixels)
                    .put("height", metrics.heightPixels))
            .put("nodes", nodes)
            .put("truncated", truncated);
    snapshotGeneration = madeAt;
    observedPackageName = packageName;
    return new JSONObject(lastSnapshot.toString());
  }

  /** Generation associated with the last node snapshot. */
  private long snapshotGeneration = -1;

  /** Adds bounded non-empty accessibility text to a node record. */
  private static void putBounded(JSONObject obj, String key, CharSequence value) throws Exception {
    if (value != null && value.length() > 0)
      obj.put(
          key,
          value.length() > TEXT_LIMIT
              ? value.subSequence(0, TEXT_LIMIT).toString()
              : value.toString());
  }

  /** Captures the default display, scales to 1440 pixels, and encodes bounded PNG data. */
  private JSONObject screenshot() throws Exception {
    long now = SystemClock.elapsedRealtime();
    if (now - lastScreenshotAt < 1000)
      throw new CommandFailure(
          "RATE_LIMITED", "Wait briefly before requesting another screenshot.");
    lastScreenshotAt = now;
    CountDownLatch latch = new CountDownLatch(1);
    final android.accessibilityservice.AccessibilityService.ScreenshotResult[] result =
        new android.accessibilityservice.AccessibilityService.ScreenshotResult[1];
    final Throwable[] failure = new Throwable[1];
    takeScreenshot(
        Display.DEFAULT_DISPLAY,
        getMainExecutor(),
        new TakeScreenshotCallback() {
          @Override
          public void onSuccess(ScreenshotResult screenshot) {
            result[0] = screenshot;
            latch.countDown();
          }

          @Override
          public void onFailure(int errorCode) {
            failure[0] = new IllegalStateException("Screenshot capture failed (" + errorCode + ")");
            latch.countDown();
          }
        });
    if (!latch.await(5, TimeUnit.SECONDS))
      throw new CommandFailure("CAPTURE_TIMEOUT", "Screen capture timed out.");
    if (failure[0] != null)
      throw new CommandFailure("CAPTURE_FAILED", "Screen capture is unavailable for this content.");
    HardwareBuffer buffer = result[0].getHardwareBuffer();
    Bitmap hardware = null, source = null, scaled = null;
    try {
      hardware = Bitmap.wrapHardwareBuffer(buffer, result[0].getColorSpace());
      if (hardware == null)
        throw new CommandFailure("CAPTURE_FAILED", "Screen capture could not be decoded.");
      source = hardware.copy(Bitmap.Config.ARGB_8888, false);
      if (source == null)
        throw new CommandFailure("CAPTURE_FAILED", "Screen capture could not be decoded.");
      int width = source.getWidth(), height = source.getHeight(), longest = Math.max(width, height);
      float scale = Math.min(1f, 1440f / longest);
      int outW = Math.max(1, Math.round(width * scale)),
          outH = Math.max(1, Math.round(height * scale));
      scaled = Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888);
      new Canvas(scaled).drawBitmap(source, null, new Rect(0, 0, outW, outH), null);
      ByteArrayOutputStream stream = new ByteArrayOutputStream();
      if (!scaled.compress(Bitmap.CompressFormat.PNG, 100, stream))
        throw new CommandFailure("CAPTURE_FAILED", "Screen capture could not be encoded.");
      byte[] png = stream.toByteArray();
      if (png.length > 5 * 1024 * 1024)
        throw new CommandFailure("CAPTURE_TOO_LARGE", "Screen capture exceeds the message limit.");
      String data = android.util.Base64.encodeToString(png, android.util.Base64.NO_WRAP);
      return new JSONObject()
          .put("mimeType", "image/png")
          .put("data", data)
          .put("width", outW)
          .put("height", outH);
    } catch (CommandFailure e) {
      throw e;
    } catch (RuntimeException e) {
      throw new CommandFailure("CAPTURE_FAILED", "Screen capture could not be processed.");
    } finally {
      if (scaled != null) scaled.recycle();
      if (source != null) source.recycle();
      if (hardware != null) hardware.recycle();
      buffer.close();
    }
  }

  /** Releases retained framework node handles before replacing a semantic snapshot. */
  private void clearLastNodes() {
    for (AccessibilityNodeInfo node : lastNodes) if (node != null) node.recycle();
    lastNodes.clear();
    lastNodeWindows.clear();
  }

  /** Starts a tap or bounded swipe sequence on Android's main thread. */
  private GestureWait beginGesture(JSONObject p, boolean swipe, long deadline) throws Exception {
    int ex = swipe ? integer(p, "endX", true) : integer(p, "x", true),
        ey = swipe ? integer(p, "endY", true) : integer(p, "y", true);
    int sx = swipe ? integer(p, "startX", true) : ex, sy = swipe ? integer(p, "startY", true) : ey;
    int duration = swipe ? integer(p, "durationMs", true) : 1;
    if (swipe && (duration < 100 || duration > 3000))
      throw invalid("Swipe duration must be from 100 to 3000 ms.");
    android.util.DisplayMetrics dm = new android.util.DisplayMetrics();
    getSystemService(android.view.WindowManager.class).getDefaultDisplay().getRealMetrics(dm);
    if (sx < 0
        || sy < 0
        || ex < 0
        || ey < 0
        || sx >= dm.widthPixels
        || ex >= dm.widthPixels
        || sy >= dm.heightPixels
        || ey >= dm.heightPixels) throw invalid("Gesture coordinates are outside the display.");
    GestureWait wait = new GestureWait(deadline, sx, sy, ex, ey, duration);
    int firstDuration = swipe ? Math.min(75, duration) : 1;
    int firstX = pointAt(sx, ex, firstDuration, duration);
    int firstY = pointAt(sy, ey, firstDuration, duration);
    Path path = new Path();
    path.moveTo(sx, sy);
    if (swipe) path.lineTo(firstX, firstY);
    boolean more = swipe && firstDuration < duration;
    GestureDescription.StrokeDescription stroke =
        new GestureDescription.StrokeDescription(path, 0, firstDuration, more);
    wait.accepted =
        dispatchGestureSegment(wait, stroke, firstX, firstY, firstDuration, more, false);
    if (!wait.accepted) finishGesture(wait, false);
    return wait;
  }

  /** Continues a swipe in at most 75 ms segments and checks phone policy before each one. */
  private boolean dispatchGestureSegment(
      GestureWait wait,
      GestureDescription.StrokeDescription stroke,
      int endX,
      int endY,
      int elapsedMs,
      boolean more,
      boolean releasing) {
    wait.stroke = stroke;
    wait.endX = endX;
    wait.endY = endY;
    wait.elapsedMs = elapsedMs;
    wait.inFlight = true;
    boolean accepted;
    try {
      accepted =
          dispatchGesture(
              new GestureDescription.Builder().addStroke(stroke).build(),
              new GestureResultCallback() {
                @Override
                public void onCompleted(GestureDescription gesture) {
                  wait.inFlight = false;
                  if (wait.finished.get()) return;
                  if (releasing) {
                    finishGesture(wait, false);
                    return;
                  }
                  if (!more) {
                    finishGesture(wait, !wait.cancelRequested);
                    return;
                  }
                  if (wait.cancelRequested) {
                    releaseGesture(wait);
                    return;
                  }
                  try {
                    checkDeadline(wait.deadline);
                    enforceLocalGuards();
                    int nextElapsed = Math.min(wait.durationMs, wait.elapsedMs + 75);
                    int nextDuration = nextElapsed - wait.elapsedMs;
                    int nextX = pointAt(wait.startX, wait.targetX, nextElapsed, wait.durationMs);
                    int nextY = pointAt(wait.startY, wait.targetY, nextElapsed, wait.durationMs);
                    Path nextPath = new Path();
                    nextPath.moveTo(wait.endX, wait.endY);
                    nextPath.lineTo(nextX, nextY);
                    boolean nextMore = nextElapsed < wait.durationMs;
                    GestureDescription.StrokeDescription continuation =
                        wait.stroke.continueStroke(nextPath, 0, nextDuration, nextMore);
                    if (!dispatchGestureSegment(
                        wait, continuation, nextX, nextY, nextElapsed, nextMore, false)) {
                      wait.requestCancel(
                          new CommandFailure("ACTION_FAILED", "The swipe could not continue."));
                      releaseGesture(wait);
                    }
                  } catch (CommandFailure policyFailure) {
                    wait.requestCancel(policyFailure);
                    releaseGesture(wait);
                  } catch (RuntimeException failure) {
                    wait.requestCancel(
                        new CommandFailure("ACTION_FAILED", "The swipe stopped unexpectedly."));
                    releaseGesture(wait);
                  }
                }

                @Override
                public void onCancelled(GestureDescription gesture) {
                  wait.inFlight = false;
                  if (wait.failure == null)
                    wait.requestCancel(
                        new CommandFailure("ACTION_FAILED", "Android cancelled the gesture."));
                  finishGesture(wait, false);
                }
              },
              main);
    } catch (RuntimeException dispatchFailure) {
      wait.inFlight = false;
      return false;
    }
    if (!accepted) wait.inFlight = false;
    return accepted;
  }

  /** Releases a held swipe pointer at its current endpoint without starting a new touch. */
  private void releaseGesture(GestureWait wait) {
    if (wait.finished.get() || wait.inFlight || wait.stroke == null) return;
    try {
      Path releasePath = new Path();
      releasePath.moveTo(wait.endX, wait.endY);
      releasePath.lineTo(wait.endX, wait.endY);
      GestureDescription.StrokeDescription release =
          wait.stroke.continueStroke(releasePath, 0, 1, false);
      if (!dispatchGestureSegment(wait, release, wait.endX, wait.endY, wait.elapsedMs, false, true))
        finishGesture(wait, false);
    } catch (RuntimeException releaseFailure) {
      finishGesture(wait, false);
    }
  }

  /** Requests release after the current short segment completes. */
  private void requestGestureRelease(GestureWait wait) {
    if (wait.finished.get()) return;
    wait.requestCancel(new CommandFailure("ACTION_TIMEOUT", "The gesture did not finish in time."));
    releaseGesture(wait);
  }

  /** Completes one sequence exactly once and wakes its serialized command worker. */
  private void finishGesture(GestureWait wait, boolean success) {
    if (wait.finished.compareAndSet(false, true)) {
      wait.completed.set(success);
      wait.latch.countDown();
    }
  }

  /** Maps a swipe's elapsed fraction to one display coordinate. */
  private static int pointAt(int start, int end, int elapsed, int duration) {
    return start + (int) Math.round((end - start) * (elapsed / (double) duration));
  }

  /** Clicks a node only when its snapshot generation, package, and node identity still match. */
  private JSONObject click(JSONObject p) throws Exception {
    AccessibilityNodeInfo node = staleCheckedNode(p);
    if (!node.isEnabled() || !node.isClickable())
      throw new CommandFailure("ACTION_FAILED", "This item cannot be clicked.");
    if (!node.performAction(AccessibilityNodeInfo.ACTION_CLICK))
      throw new CommandFailure("ACTION_FAILED", "The item did not accept the click.");
    return new JSONObject().put("performed", true);
  }

  /** Replaces text only in a current, enabled, supported non-password editable field. */
  private JSONObject setText(JSONObject p) throws Exception {
    String text = p.getString("text");
    if (text.length() > 4000) throw invalid("Text is limited to 4000 characters.");
    AccessibilityNodeInfo node = staleCheckedNode(p);
    if (!node.isEnabled() || !node.isEditable() || node.isPassword())
      throw new CommandFailure("ACTION_FAILED", "This field cannot accept remote text.");
    BundleCompat bundle = new BundleCompat(text);
    if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle.bundle))
      throw new CommandFailure("ACTION_FAILED", "The field did not accept the text.");
    return new JSONObject().put("performed", true);
  }

  /** Validates snapshot identity and rejects node IDs from old observations. */
  private AccessibilityNodeInfo staleCheckedNode(JSONObject p) throws Exception {
    String snapshotId = p.getString("snapshotId"), nodeId = p.getString("nodeId");
    if (lastSnapshot == null
        || snapshotGeneration != generation
        || !lastSnapshot.optString("snapshotId").equals(snapshotId))
      throw new CommandFailure("STALE_SNAPSHOT", "Observe the phone again before acting.");
    int index;
    try {
      index = Integer.parseInt(nodeId);
    } catch (Exception e) {
      throw invalid("Node id is invalid.");
    }
    if (index < 0 || index >= lastNodes.size())
      throw new CommandFailure("STALE_SNAPSHOT", "Observe the phone again before acting.");
    AccessibilityNodeInfo node = lastNodes.get(index);
    if (node == null || !node.isVisibleToUser())
      throw new CommandFailure("STALE_SNAPSHOT", "Observe the phone again before acting.");
    if (!node.refresh())
      throw new CommandFailure("STALE_SNAPSHOT", "Observe the phone again before acting.");
    AccessibilityNodeInfo active = getRootInActiveWindow();
    String activePackage =
        active == null || active.getPackageName() == null ? "" : active.getPackageName().toString();
    if (!lastSnapshot.optString("packageName").equals(activePackage))
      throw new CommandFailure("STALE_SNAPSHOT", "Observe the phone again before acting.");
    CharSequence current = node.getPackageName();
    if (current != null && !lastNodeWindows.get(index).equals(current.toString()))
      throw new CommandFailure("STALE_SNAPSHOT", "Observe the phone again before acting.");
    return node;
  }

  /** Performs only the three protocol-defined Android global actions. */
  private JSONObject globalAction(JSONObject p) throws Exception {
    String action = p.getString("action");
    int id;
    switch (action) {
      case "back":
        id = GLOBAL_ACTION_BACK;
        break;
      case "home":
        id = GLOBAL_ACTION_HOME;
        break;
      case "recents":
        id = GLOBAL_ACTION_RECENTS;
        break;
      default:
        throw invalid("Global action is unsupported.");
    }
    if (!performGlobalAction(id))
      throw new CommandFailure("ACTION_FAILED", "Android did not perform the requested action.");
    return new JSONObject().put("performed", true);
  }

  /** Rejects unknown keys and validates every method-specific input before execution. */
  private static void validateProperties(String method, JSONObject p) throws Exception {
    Set<String> allowed = new HashSet<>();
    switch (method) {
      case "snapshot":
      case "screenshot":
        break;
      case "tap":
        allowed.add("x");
        allowed.add("y");
        break;
      case "swipe":
        allowed.add("startX");
        allowed.add("startY");
        allowed.add("endX");
        allowed.add("endY");
        allowed.add("durationMs");
        break;
      case "click":
        allowed.add("snapshotId");
        allowed.add("nodeId");
        break;
      case "set_text":
        allowed.add("snapshotId");
        allowed.add("nodeId");
        allowed.add("text");
        break;
      case "global_action":
        allowed.add("action");
        break;
      default:
        throw new CommandFailure("INVALID_COMMAND", "Unsupported command method.");
    }
    JSONArray names = p.names();
    if (names != null)
      for (int i = 0; i < names.length(); i++) {
        String key = names.getString(i);
        if (!allowed.contains(key)) throw invalid("Command contains an unknown parameter.");
      }
    switch (method) {
      case "tap":
        integer(p, "x", true);
        integer(p, "y", true);
        break;
      case "swipe":
        integer(p, "startX", true);
        integer(p, "startY", true);
        integer(p, "endX", true);
        integer(p, "endY", true);
        integer(p, "durationMs", true);
        break;
      case "click":
        requiredString(p, "snapshotId");
        requiredString(p, "nodeId");
        break;
      case "set_text":
        requiredString(p, "snapshotId");
        requiredString(p, "nodeId");
        if (!p.has("text") || !(p.get("text") instanceof String))
          throw invalid("Text must be a string.");
        break;
      case "global_action":
        requiredString(p, "action");
    }
  }

  /** Creates a typed parameter validation error. */
  private static CommandFailure invalid(String message) {
    return new CommandFailure("INVALID_PARAMS", message);
  }

  /** Stops work whose desktop deadline expired while it waited in the serialized queue. */
  private static void checkDeadline(long deadline) throws CommandFailure {
    if (deadline <= System.currentTimeMillis())
      throw new CommandFailure("COMMAND_EXPIRED", "This command has expired.");
  }

  /** Reads a finite integer parameter and rejects numeric strings, fractions, and overflow. */
  private static int integer(JSONObject p, String key, boolean required) throws Exception {
    if (!required && !p.has(key)) return 0;
    Object v = p.opt(key);
    if (!(v instanceof Number)) throw invalid("Coordinate and duration values must be integers.");
    double d = ((Number) v).doubleValue();
    if (!Double.isFinite(d) || d != Math.rint(d) || d < Integer.MIN_VALUE || d > Integer.MAX_VALUE)
      throw invalid("Coordinate and duration values must be finite integers.");
    return (int) d;
  }

  /** Reads a required nonempty text parameter without coercing another JSON type. */
  private static String requiredString(JSONObject p, String k) throws Exception {
    if (!p.has(k) || !(p.get(k) instanceof String) || p.getString(k).isEmpty())
      throw invalid("A required text parameter is missing.");
    return p.getString(k);
  }

  /** Executes an accessibility operation on the Android main thread with a bounded wait. */
  private <T> T onMain(java.util.concurrent.Callable<T> operation) throws Exception {
    FutureTask<T> task = new FutureTask<>(operation);
    main.post(task);
    try {
      return task.get(8, TimeUnit.SECONDS);
    } catch (java.util.concurrent.TimeoutException e) {
      task.cancel(false);
      throw new CommandFailure("ACTION_TIMEOUT", "The phone action timed out.");
    } catch (InterruptedException e) {
      task.cancel(false);
      Thread.currentThread().interrupt();
      throw new CommandFailure("ACTION_CANCELLED", "The phone action was interrupted.");
    } catch (java.util.concurrent.ExecutionException e) {
      Throwable cause = e.getCause();
      if (cause instanceof Exception) throw (Exception) cause;
      throw new CommandFailure("ACTION_FAILED", "The phone action failed.");
    }
  }

  /** Carries safe, user-facing command errors across the WebSocket boundary. */
  static final class CommandFailure extends Exception {
    final String code;

    CommandFailure(String code, String message) {
      super(message);
      this.code = code;
    }
  }

  /** Tracks 75 ms gesture segments so revocation can release the active pointer promptly. */
  private final class GestureWait {
    final CountDownLatch latch = new CountDownLatch(1);
    final AtomicBoolean completed = new AtomicBoolean(false);
    final AtomicBoolean finished = new AtomicBoolean(false);
    final long deadline;
    final int startX, startY, targetX, targetY, durationMs;
    volatile boolean accepted, inFlight, cancelRequested;
    volatile int endX, endY, elapsedMs;
    volatile CommandFailure failure;
    GestureDescription.StrokeDescription stroke;

    GestureWait(long deadline, int startX, int startY, int targetX, int targetY, int durationMs) {
      this.deadline = deadline;
      this.startX = startX;
      this.startY = startY;
      this.targetX = targetX;
      this.targetY = targetY;
      this.durationMs = durationMs;
    }

    /** Preserves the first policy or timeout failure and requests release at the next boundary. */
    void requestCancel(CommandFailure reason) {
      if (failure == null) failure = reason;
      cancelRequested = true;
    }
  }

  /** Provides the Bundle required by ACTION_SET_TEXT without sharing mutable text buffers. */
  private static final class BundleCompat {
    final android.os.Bundle bundle = new android.os.Bundle();

    BundleCompat(String text) {
      bundle.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
    }
  }
}
