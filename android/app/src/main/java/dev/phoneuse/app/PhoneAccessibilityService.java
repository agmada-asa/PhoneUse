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
import java.util.Comparator;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.HashMap;
import java.util.Map;
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
  /** Limits total work, including queued children, for one semantic observation. */
  private static final int VISIT_LIMIT = 5000;
  /** Hard cap on main-thread accessibility traversal time, independent of command timeout. */
  private static final long TRAVERSAL_BUDGET_MS = 750;

  /** Leaves a short safety pass and serialization margin after the traversal budget. */
  private static final long SNAPSHOT_BUDGET_MS = 1500;

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

  /** Android window identity paired with each retained node. */
  private final List<Integer> lastNodeWindowIds = new ArrayList<>();

  /** Most recent accessibility event time, used for bounded post-action settling. */
  private volatile long lastRelevantEventAt = SystemClock.elapsedRealtime();

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
    ConnectionService.publishLocalStatus();
  }

  /** Invalidates node references whenever the observed accessibility UI changes. */
  @Override
  public void onAccessibilityEvent(AccessibilityEvent event) {
    int type = event.getEventType();
    boolean windowTransition =
        type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            || type == AccessibilityEvent.TYPE_WINDOWS_CHANGED;
    boolean contentChange = type == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        || type == AccessibilityEvent.TYPE_VIEW_SCROLLED
        || type == AccessibilityEvent.TYPE_VIEW_CLICKED
        || type == AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED
        || type == AccessibilityEvent.TYPE_VIEW_FOCUSED;
    if (windowTransition || contentChange)
      lastRelevantEventAt = SystemClock.elapsedRealtime();
    if (windowTransition || contentChange) {
      generation++;
      clearLastNodes();
      lastSnapshot = null;
    }
  }

  /** Stops consent and cached actions when Android interrupts service feedback. */
  @Override
  public void onInterrupt() {
    clearLastNodes();
    lastSnapshot = null;
    PhoneState.controlEnabled = false;
    generation++;
    ConnectionService.publishLocalStatus();
  }

  /** Clears consent and cached node handles when Android unbinds disabled accessibility access. */
  @Override
  public boolean onUnbind(android.content.Intent intent) {
    clearLastNodes();
    lastSnapshot = null;
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
        captured = screenshot(commandParams);
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
    if ("observe_action".equals(method)) return observeAction(commandParams, deadline);
    return onMain(
        () -> {
          checkDeadline(deadline);
          if ("snapshot".equals(method)) enforceControlBasics();
          else enforceLocalGuards();
          switch (method) {
            case "snapshot":
              return snapshot(commandParams, deadline);
            case "click":
              return click(commandParams);
            case "set_text":
              return setText(commandParams);
            case "scroll":
              return scroll(commandParams);
            case "global_action":
              return globalAction(commandParams);
            default:
              throw new CommandFailure("INVALID_COMMAND", "Unsupported command method.");
          }
        });
  }

  /** Executes one validated action, then waits for a bounded quiet period before observing. */
  private JSONObject observeAction(JSONObject params, long deadline) throws Exception {
    JSONObject action = params.getJSONObject("action");
    String method = action.getString("method");
    JSONObject actionParams = action.getJSONObject("params");
    validateProperties(method, actionParams);
    if ("observe_action".equals(method) || "screenshot".equals(method) || "snapshot".equals(method))
      throw invalid("The observed action must change or navigate the screen.");
    int quietMs = params.has("quietMs") ? integer(params, "quietMs", true) : 200;
    int maxWaitMs = params.has("maxWaitMs") ? integer(params, "maxWaitMs", true) : 2000;
    if (quietMs < 100 || quietMs > 1000 || maxWaitMs < 200 || maxWaitMs > 3000
        || quietMs > maxWaitMs)
      throw invalid("Observation timing is outside its allowed range.");

    runCommand(new JSONObject().put("method", method).put("params", actionParams), deadline);
    try {
      long waitStarted = SystemClock.elapsedRealtime();
      long quietSince = Math.max(waitStarted, lastRelevantEventAt);
      while (true) {
        try {
          onMain(() -> {
            checkDeadline(deadline);
            enforceLocalGuards();
            return Boolean.TRUE;
          });
          long now = SystemClock.elapsedRealtime();
          quietSince = Math.max(quietSince, lastRelevantEventAt);
          boolean settled = now - quietSince >= quietMs;
          if (settled || now - waitStarted >= maxWaitMs) {
            // Snapshot owns both the initial root policy check and the final safety pass.
            JSONObject observed = onMain(() -> {
              checkDeadline(deadline);
              enforceControlBasics();
              return snapshot(new JSONObject(), deadline);
            });
            return new JSONObject().put("performed", true)
                .put("observation", new JSONObject().put("ok", true)
                    .put("snapshot", observed).put("settled", settled));
          }
        } catch (CommandFailure e) {
          if (!"APP_BLOCKED".equals(e.code)
              || SystemClock.elapsedRealtime() - waitStarted >= maxWaitMs)
            return observationFailure(e.code, e.getMessage());
          // Disappearing windows can briefly have no root. Wait without observing or acting.
          quietSince = SystemClock.elapsedRealtime();
        }
        Thread.sleep(50);
      }
    } catch (CommandFailure e) {
      return observationFailure(e.code, e.getMessage());
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      return observationFailure("ACTION_CANCELLED", "Observation was interrupted after the action completed.");
    } catch (Exception e) {
      return observationFailure("CAPTURE_FAILED", "The screen could not be observed after the action completed.");
    }
  }

  /** Builds a safe post-action observation failure without changing action success. */
  private static JSONObject observationFailure(String code, String message) throws Exception {
    JSONObject error = new JSONObject().put("code", code).put("message", message);
    return new JSONObject()
        .put("performed", true)
        .put("observation", new JSONObject().put("ok", false).put("error", error));
  }

  /**
   * Ensures consent, service availability, lock state and every visible window's package policy.
   */
  private void enforceLocalGuards() throws CommandFailure {
    enforceControlBasics();
    Set<String> blocked = getBlockedPackages();
    List<AccessibilityWindowInfo> windows = getWindows();
    if (windows == null || windows.isEmpty())
      throw new CommandFailure("APP_BLOCKED", "Phone control is unavailable on this screen.");
    boolean activeRootFound = false;
    try {
      for (AccessibilityWindowInfo window : windows) {
        AccessibilityNodeInfo root = null;
        try {
          root = window.getRoot();
          if (root == null)
            throw new CommandFailure("APP_BLOCKED", "Phone control is unavailable on this screen.");
          CharSequence packageName = root.getPackageName();
          if (packageName == null || packageName.length() == 0)
            throw new CommandFailure("APP_BLOCKED", "Phone control is unavailable on this screen.");
          if (window.isActive()) activeRootFound = true;
          if (PhoneState.OWN_PACKAGE.equals(packageName.toString())
              || blocked.contains(packageName.toString()))
            throw new CommandFailure("APP_BLOCKED", "Phone control is unavailable on this screen.");
        } finally {
          if (root != null) root.recycle();
        }
      }
    } finally {
      for (AccessibilityWindowInfo window : windows) if (window != null) window.recycle();
    }
    if (!activeRootFound)
      throw new CommandFailure("APP_BLOCKED", "Phone control is unavailable on this screen.");
  }

  /** Checks phone-side consent, service, and lock state without fetching windows. */
  private void enforceControlBasics() throws CommandFailure {
    if (!PhoneState.controlEnabled)
      throw new CommandFailure("CONTROL_DISABLED", "Enable control on your phone.");
    if (!PhoneState.accessibilityEnabled(this) || PhoneState.accessibility != this)
      throw new CommandFailure(
          "ACCESSIBILITY_DISABLED", "Enable PhoneUse accessibility access on your phone.");
    android.app.KeyguardManager keyguard =
        (android.app.KeyguardManager) getSystemService(KEYGUARD_SERVICE);
    if (keyguard != null && keyguard.isKeyguardLocked())
      throw new CommandFailure("SCREEN_LOCKED", "Unlock your phone before controlling it.");
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
  private JSONObject snapshot(JSONObject params, long deadline) throws Exception {
    long startGeneration = generation;
    long traversalStarted = SystemClock.elapsedRealtime();
    android.util.DisplayMetrics metrics = new android.util.DisplayMetrics();
    getSystemService(android.view.WindowManager.class).getDefaultDisplay().getRealMetrics(metrics);
    Integer requestedWindow = params.has("windowId") ? integer(params, "windowId", true) : null;
    JSONObject rootScope = params.optJSONObject("root");
    if (requestedWindow != null && rootScope != null)
      throw invalid("Choose either a window or a node root.");
    AccessibilityNodeInfo scopedRoot = null;
    boolean scopedRootTraversed = false;
    int scopedWindow = -1;
    String packageName = "";
    if (rootScope != null) {
      String sid = requiredString(rootScope, "snapshotId"), nid = requiredString(rootScope, "nodeId");
      try { UUID.fromString(sid); } catch (IllegalArgumentException e) { throw invalid("Snapshot id is invalid."); }
      JSONObject rootParams = new JSONObject().put("snapshotId", sid).put("nodeId", nid);
      AccessibilityNodeInfo prior = staleCheckedNode(rootParams);
      scopedRoot = AccessibilityNodeInfo.obtain(prior);
      int index = Integer.parseInt(nid);
      scopedWindow = lastNodeWindowIds.get(index);
      packageName = lastNodeWindows.get(index);
    }
    List<AccessibilityWindowInfo> windows = getWindows();
    if (windows == null || windows.isEmpty()) {
      if (scopedRoot != null) scopedRoot.recycle();
      throw new CommandFailure("CAPTURE_FAILED", "The current screen could not be inspected.");
    }
    JSONArray windowJson = new JSONArray();
    JSONArray nodes = new JSONArray();
    ArrayList<NodeCandidate> candidates = new ArrayList<>();
    int admissions = 0, visited = 0;
    boolean truncated = false;
    boolean selectedWindowFound = false;
    boolean activeRootFound = false;
    Set<String> blockedPackages = getBlockedPackages();
    Set<AccessibilityNodeInfo> seenNodes = Collections.newSetFromMap(new IdentityHashMap<>());
    ArrayList<AccessibilityNodeInfo> visitedHandles = new ArrayList<>();
    Set<Integer> contextWindows = new HashSet<>();
    try {
      for (AccessibilityWindowInfo window : windows) {
        checkDeadline(deadline);
        AccessibilityNodeInfo root = null;
        try {
          root = window.getRoot();
          if (root == null)
            throw new CommandFailure("APP_BLOCKED", "Phone control is unavailable on this screen.");
          CharSequence pkg = root.getPackageName();
          String windowPackage = pkg == null ? "" : pkg.toString();
          if (windowPackage.isEmpty() || blockedPackages.contains(windowPackage))
            throw new CommandFailure("APP_BLOCKED", "Phone control is unavailable on this screen.");
          if (window.isActive()) activeRootFound = true;
          if (window.isActive()) packageName = windowPackage;
          Rect wb = new Rect();
          window.getBoundsInScreen(wb);
          boolean listedWindow = windowJson.length() < 32;
          if (listedWindow) windowJson.put(new JSONObject()
              .put("id", window.getId()).put("type", window.getType())
              .put("active", window.isActive()).put("focused", window.isFocused())
              .put("bounds", boundsJson(wb)));
          else truncated = true;
          boolean selected = requestedWindow == null && rootScope == null
              ? true
              : requestedWindow != null && requestedWindow == window.getId()
                  || rootScope != null && scopedWindow == window.getId();
          if (!selected) continue;
          if (!listedWindow) continue;
          selectedWindowFound = true;
          if (packageName.isEmpty()) packageName = windowPackage;
          if (admissions >= VISIT_LIMIT
              || SystemClock.elapsedRealtime() - traversalStarted >= TRAVERSAL_BUDGET_MS) {
            truncated = true;
            continue;
          }
          ArrayDeque<QueuedNode> queue = new ArrayDeque<>();
          AccessibilityNodeInfo walkRoot = rootScope == null ? AccessibilityNodeInfo.obtain(root) : null;
          if (rootScope != null && scopedWindow == window.getId()) {
            walkRoot = scopedRoot;
            scopedRootTraversed = true;
          }
          if (walkRoot == null) continue;
          queue.add(new QueuedNode(walkRoot, null, window.getId(), windowPackage));
          admissions++;
          try {
            while (!queue.isEmpty() && visited < VISIT_LIMIT) {
              checkDeadline(deadline);
              if (SystemClock.elapsedRealtime() - traversalStarted >= TRAVERSAL_BUDGET_MS) {
                truncated = true;
                break;
              }
              QueuedNode queued = queue.removeFirst();
              AccessibilityNodeInfo node = queued.node;
              visited++;
              if (!seenNodes.add(node)) { node.recycle(); continue; }
              visitedHandles.add(node);
              Rect bounds = new Rect();
              node.getBoundsInScreen(bounds);
              boolean password = node.isPassword();
              int childCount = password ? 0 : node.getChildCount();
              NodeCandidate candidate = null;
              if (node.isVisibleToUser()
                  && bounds.intersect(0, 0, metrics.widthPixels, metrics.heightPixels)
                  && bounds.width() > 0 && bounds.height() > 0) {
                candidate = new NodeCandidate(node, queued.parent, queued.windowId, queued.packageName, bounds, candidates.size(), childCount > 0);
                candidates.add(candidate);
                boolean actionable = node.isEnabled() && (node.isClickable() || node.isEditable() || node.isScrollable());
                boolean labeled = (node.getText() != null && node.getText().length() > 0)
                    || (node.getContentDescription() != null && node.getContentDescription().length() > 0);
                boolean rootContext = queued.parent == null;
                boolean containerContext = !rootContext && queued.parent.parent == null
                    && childCount > 0 && !contextWindows.contains(queued.windowId);
                candidate.score = (actionable ? 10000 : labeled ? 1000 : 0)
                    + (node.isEnabled() ? 100 : 0)
                    + (rootContext ? 100000 : containerContext ? 90000 : 0);
                if (containerContext) contextWindows.add(queued.windowId);
              }
              for (int i = 0; i < childCount; i++) {
                if (admissions >= VISIT_LIMIT
                    || SystemClock.elapsedRealtime() - traversalStarted >= TRAVERSAL_BUDGET_MS) {
                  truncated = true;
                  break;
                }
                admissions++;
                AccessibilityNodeInfo child = node.getChild(i);
                if (child == null) continue;
                queue.addLast(new QueuedNode(child, candidate == null ? queued.parent : candidate,
                    queued.windowId, queued.packageName));
              }
              if (admissions >= VISIT_LIMIT && !queue.isEmpty()) truncated = true;
            }
          } finally {
            while (!queue.isEmpty()) queue.removeFirst().node.recycle();
          }
          if (visited >= VISIT_LIMIT) truncated = true;
          if (SystemClock.elapsedRealtime() - traversalStarted >= TRAVERSAL_BUDGET_MS) truncated = true;
        } finally {
          if (root != null) root.recycle();
        }
      }
    } catch (Exception failure) {
      Set<AccessibilityNodeInfo> candidateNodes = Collections.newSetFromMap(new IdentityHashMap<>());
      for (NodeCandidate candidate : candidates) candidateNodes.add(candidate.node);
      for (AccessibilityNodeInfo node : visitedHandles) if (!candidateNodes.contains(node)) node.recycle();
      for (NodeCandidate candidate : candidates) recycleCandidate(candidate);
      throw failure;
    } finally {
      if (scopedRoot != null && !scopedRootTraversed) scopedRoot.recycle();
      for (AccessibilityWindowInfo window : windows) if (window != null) window.recycle();
    }
    Set<AccessibilityNodeInfo> candidateNodes = Collections.newSetFromMap(new IdentityHashMap<>());
    for (NodeCandidate candidate : candidates) candidateNodes.add(candidate.node);
    for (AccessibilityNodeInfo node : visitedHandles) if (!candidateNodes.contains(node)) node.recycle();
    if (SystemClock.elapsedRealtime() - traversalStarted >= SNAPSHOT_BUDGET_MS) {
      for (NodeCandidate candidate : candidates) recycleCandidate(candidate);
      throw new CommandFailure("CAPTURE_TIMEOUT", "Screen inspection exceeded its time limit.");
    }
    if (!activeRootFound) {
      for (NodeCandidate candidate : candidates) recycleCandidate(candidate);
      throw new CommandFailure("APP_BLOCKED", "Phone control is unavailable on this screen.");
    }
    if (!selectedWindowFound) {
      for (NodeCandidate candidate : candidates) recycleCandidate(candidate);
      throw new CommandFailure(rootScope == null ? "INVALID_PARAMS" : "STALE_SNAPSHOT",
          rootScope == null ? "The requested window is no longer available." : "Observe the phone again before acting.");
    }
    truncated |= selectCandidates(candidates);
    clearLastNodes();
    lastSnapshot = null;
    lastNodeWindowIds.clear();
    String snapshotId = UUID.randomUUID().toString();
    HashMap<NodeCandidate, String> ids = new HashMap<>();
    for (int i = 0; i < candidates.size(); i++) ids.put(candidates.get(i), Integer.toString(i));
    try {
      for (int i = 0; i < candidates.size(); i++) {
        if (SystemClock.elapsedRealtime() - traversalStarted >= SNAPSHOT_BUDGET_MS)
          throw new CommandFailure("CAPTURE_TIMEOUT", "Screen inspection exceeded its time limit.");
        NodeCandidate c = candidates.get(i);
        AccessibilityNodeInfo node = c.node;
        JSONObject item = new JSONObject().put("id", Integer.toString(i)).put("windowId", c.windowId);
        NodeCandidate ancestor = c.parent;
        while (ancestor != null && (!ids.containsKey(ancestor) || ancestor.windowId != c.windowId)) ancestor = ancestor.parent;
        if (ancestor != null) item.put("parentId", ids.get(ancestor));
        putBounded(item, "text", node.isPassword() ? null : node.getText());
        if (!node.isPassword()) putBounded(item, "description", node.getContentDescription());
        putBounded(item, "viewId", node.getViewIdResourceName());
        putBounded(item, "className", node.getClassName());
        item.put("bounds", boundsJson(c.bounds));
        item.put("clickable", node.isClickable()).put("editable", node.isEditable() && !node.isPassword())
            .put("scrollable", node.isScrollable()).put("enabled", node.isEnabled());
        item.put("actions", actionsJson(node));
        AccessibilityNodeInfo.CollectionInfo collection = node.getCollectionInfo();
        if (collection != null) item.put("collection", new JSONObject().put("rows", Math.max(0, collection.getRowCount())).put("columns", Math.max(0, collection.getColumnCount())));
        nodes.put(item);
        lastNodes.add(AccessibilityNodeInfo.obtain(node));
        lastNodeWindows.add(c.packageName);
        lastNodeWindowIds.add(c.windowId);
      }
      try {
        enforceLocalGuards();
        if (SystemClock.elapsedRealtime() - traversalStarted >= SNAPSHOT_BUDGET_MS)
          throw new CommandFailure("CAPTURE_TIMEOUT", "Screen inspection exceeded its time limit.");
        if (startGeneration != generation)
          throw new CommandFailure("STALE_SNAPSHOT", "The screen changed during observation. Observe again.");
      } catch (CommandFailure failure) {
        clearLastNodes();
        lastSnapshot = null;
        throw failure;
      }
      lastSnapshot = new JSONObject().put("snapshotId", snapshotId).put("packageName", packageName)
          .put("screen", new JSONObject().put("width", metrics.widthPixels).put("height", metrics.heightPixels))
          .put("windows", windowJson).put("nodes", nodes).put("truncated", truncated);
      snapshotGeneration = generation;
      return new JSONObject(lastSnapshot.toString());
    } catch (Exception failure) {
      clearLastNodes();
      lastSnapshot = null;
      throw failure;
    } finally {
      for (NodeCandidate candidate : candidates) recycleCandidate(candidate);
    }
  }

  /** Reserves bounded window/container context without allowing it to crowd out useful controls. */
  private static boolean selectCandidates(ArrayList<NodeCandidate> candidates) {
    if (candidates.size() <= NODE_LIMIT) return false;
    Set<NodeCandidate> selected = new java.util.LinkedHashSet<>();
    // Every traversed window/root scope retains its root for further scoped observations.
    for (NodeCandidate candidate : candidates)
      if (candidate.parent == null && selected.size() < 64) selected.add(candidate);
    for (NodeCandidate candidate : candidates)
      if (selected.size() < 64 && candidate.hasChildren) selected.add(candidate);
    candidates.sort(Comparator.comparingInt((NodeCandidate c) -> c.score).reversed().thenComparingInt(c -> c.order));
    for (NodeCandidate candidate : candidates) {
      if (selected.size() >= NODE_LIMIT) break;
      selected.add(candidate);
    }
    for (NodeCandidate candidate : candidates) if (!selected.contains(candidate)) recycleCandidate(candidate);
    candidates.clear();
    candidates.addAll(selected);
    return true;
  }

  /** Formats a screen or window rectangle in physical display pixels. */
  private static JSONObject boundsJson(Rect bounds) throws Exception {
    return new JSONObject().put("left", bounds.left).put("top", bounds.top).put("right", bounds.right).put("bottom", bounds.bottom);
  }

  /** Releases an owned candidate handle at most once, including partial serialization failures. */
  private static void recycleCandidate(NodeCandidate candidate) {
    if (candidate.ownsNode) {
      candidate.ownsNode = false;
      candidate.node.recycle();
    }
  }

  /** Lists only semantic actions supported by this exact node. */
  private static JSONArray actionsJson(AccessibilityNodeInfo node) throws Exception {
    JSONArray actions = new JSONArray();
    if (node.isClickable() && node.isEnabled() && hasAction(node, AccessibilityNodeInfo.ACTION_CLICK)) actions.put("click");
    if (node.isEditable() && !node.isPassword() && node.isEnabled()
        && hasAction(node, AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_TEXT.getId())) actions.put("set_text");
    if (node.isScrollable()) {
      for (AccessibilityNodeInfo.AccessibilityAction action : node.getActionList()) {
        int id = action.getId();
        if (id == AccessibilityNodeInfo.ACTION_SCROLL_FORWARD) actions.put("scroll_forward");
        else if (id == AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD) actions.put("scroll_backward");
        else if (id == AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.getId()) actions.put("scroll_up");
        else if (id == AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.getId()) actions.put("scroll_down");
        else if (id == AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.getId()) actions.put("scroll_left");
        else if (id == AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.getId()) actions.put("scroll_right");
      }
    }
    return actions;
  }

  /** Checks an exact framework action id without inferring support from node flags. */
  private static boolean hasAction(AccessibilityNodeInfo node, int actionId) {
    for (AccessibilityNodeInfo.AccessibilityAction action : node.getActionList())
      if (action.getId() == actionId) return true;
    return false;
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
  private JSONObject screenshot(JSONObject params) throws Exception {
    long now = SystemClock.elapsedRealtime();
    if (now - lastScreenshotAt < 1000)
      throw new CommandFailure(
          "RATE_LIMITED", "Wait briefly before requesting another screenshot.");
    lastScreenshotAt = now;
    CountDownLatch latch = new CountDownLatch(1);
    Object callbackLock = new Object();
    boolean[] abandoned = new boolean[1];
    final android.accessibilityservice.AccessibilityService.ScreenshotResult[] result =
        new android.accessibilityservice.AccessibilityService.ScreenshotResult[1];
    final Throwable[] failure = new Throwable[1];
    takeScreenshot(
        Display.DEFAULT_DISPLAY,
        getMainExecutor(),
        new TakeScreenshotCallback() {
          @Override
          public void onSuccess(ScreenshotResult screenshot) {
            synchronized (callbackLock) {
              if (abandoned[0]) {
                HardwareBuffer lateBuffer = screenshot.getHardwareBuffer();
                if (lateBuffer != null) lateBuffer.close();
              }
              else result[0] = screenshot;
              latch.countDown();
            }
          }

          @Override
          public void onFailure(int errorCode) {
            failure[0] = new IllegalStateException("Screenshot capture failed (" + errorCode + ")");
            latch.countDown();
          }
        });
    boolean received = false;
    try {
      received = latch.await(5, TimeUnit.SECONDS);
    } finally {
      // Interrupted workers also abandon the callback and release any already-arrived buffer.
      if (!received) {
        synchronized (callbackLock) {
          abandoned[0] = true;
          if (result[0] != null && result[0].getHardwareBuffer() != null)
            result[0].getHardwareBuffer().close();
        }
      }
    }
    if (!received) throw new CommandFailure("CAPTURE_TIMEOUT", "Screen capture timed out.");
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
      int maxDimension = params.has("maxDimension") ? integer(params, "maxDimension", true) : 1440;
      float scale = Math.min(1f, maxDimension / (float) longest);
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
          .put("height", outH)
          .put("screen", new JSONObject().put("width", width).put("height", height));
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
    lastNodeWindowIds.clear();
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
    if (!node.isEnabled() || !node.isClickable() || !hasAction(node, AccessibilityNodeInfo.ACTION_CLICK))
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
    if (!node.isEnabled() || !node.isEditable() || node.isPassword()
        || !hasAction(node, AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_TEXT.getId()))
      throw new CommandFailure("ACTION_FAILED", "This field cannot accept remote text.");
    BundleCompat bundle = new BundleCompat(text);
    if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle.bundle))
      throw new CommandFailure("ACTION_FAILED", "The field did not accept the text.");
    return new JSONObject().put("performed", true);
  }

  /** Performs one advertised directional accessibility scroll action on a current node. */
  private JSONObject scroll(JSONObject p) throws Exception {
    String direction = p.getString("direction");
    AccessibilityNodeInfo node = staleCheckedNode(p);
    int actionId;
    switch (direction) {
      case "forward": actionId = AccessibilityNodeInfo.ACTION_SCROLL_FORWARD; break;
      case "backward": actionId = AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD; break;
      case "up": actionId = AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.getId(); break;
      case "down": actionId = AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.getId(); break;
      case "left": actionId = AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.getId(); break;
      case "right": actionId = AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.getId(); break;
      default: throw invalid("Scroll direction is unsupported.");
    }
    boolean advertised = false;
    for (AccessibilityNodeInfo.AccessibilityAction action : node.getActionList())
      if (action.getId() == actionId) advertised = true;
    if (!node.isEnabled() || !node.isScrollable() || !advertised)
      throw new CommandFailure("ACTION_FAILED", "This item does not support that scroll action.");
    if (!node.performAction(actionId))
      throw new CommandFailure("ACTION_FAILED", "The item did not accept the scroll action.");
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
    if (!node.refresh() || !node.isVisibleToUser() || !matchesSnapshotNode(node, index))
      throw new CommandFailure("STALE_SNAPSHOT", "Observe the phone again before acting.");
    AccessibilityWindowInfo nodeWindow = node.getWindow();
    try {
      if (nodeWindow == null || nodeWindow.getId() != lastNodeWindowIds.get(index))
        throw new CommandFailure("STALE_SNAPSHOT", "Observe the phone again before acting.");
    } finally { if (nodeWindow != null) nodeWindow.recycle(); }
    boolean windowExists = false;
    List<AccessibilityWindowInfo> windows = getWindows();
    if (windows != null) {
      try {
        for (AccessibilityWindowInfo window : windows) {
          if (window.getId() != lastNodeWindowIds.get(index)) continue;
          AccessibilityNodeInfo root = window.getRoot();
          try {
            CharSequence pkg = root == null ? null : root.getPackageName();
            windowExists = pkg != null && lastNodeWindows.get(index).equals(pkg.toString());
          } finally { if (root != null) root.recycle(); }
        }
      } finally { for (AccessibilityWindowInfo window : windows) if (window != null) window.recycle(); }
    }
    if (!windowExists) throw new CommandFailure("STALE_SNAPSHOT", "Observe the phone again before acting.");
    CharSequence current = node.getPackageName();
    if (current == null || !lastNodeWindows.get(index).equals(current.toString()))
      throw new CommandFailure("STALE_SNAPSHOT", "Observe the phone again before acting.");
    return node;
  }

  /** Rejects changed target content or geometry even when its accessibility event is still queued. */
  private boolean matchesSnapshotNode(AccessibilityNodeInfo node, int index) throws Exception {
    JSONObject expected = lastSnapshot.getJSONArray("nodes").getJSONObject(index);
    JSONObject current = new JSONObject();
    putBounded(current, "text", node.isPassword() ? null : node.getText());
    putBounded(current, "description", node.isPassword() ? null : node.getContentDescription());
    putBounded(current, "viewId", node.getViewIdResourceName());
    putBounded(current, "className", node.getClassName());
    for (String field : List.of("text", "description", "viewId", "className"))
      if (!expected.optString(field, "").equals(current.optString(field, ""))) return false;
    Rect actual = new Rect();
    node.getBoundsInScreen(actual);
    JSONObject display = lastSnapshot.getJSONObject("screen");
    if (!actual.intersect(0, 0, display.getInt("width"), display.getInt("height"))) return false;
    JSONObject bounds = expected.getJSONObject("bounds");
    return actual.left == bounds.getInt("left") && actual.top == bounds.getInt("top")
        && actual.right == bounds.getInt("right") && actual.bottom == bounds.getInt("bottom")
        && expected.getBoolean("clickable") == node.isClickable()
        && expected.getBoolean("editable") == (node.isEditable() && !node.isPassword())
        && expected.getBoolean("scrollable") == node.isScrollable()
        && expected.getBoolean("enabled") == node.isEnabled();
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
        allowed.add("windowId"); allowed.add("root");
        if (p.has("windowId") && p.has("root")) throw invalid("Choose either a window or a node root.");
        if (p.has("windowId") && integer(p, "windowId", true) < 0) throw invalid("Window id must be nonnegative.");
        if (p.has("root")) {
          JSONObject root = p.optJSONObject("root");
          if (root == null) throw invalid("Snapshot root is invalid.");
          rejectUnknown(root, Set.of("snapshotId", "nodeId"));
          try { UUID.fromString(requiredString(root, "snapshotId")); }
          catch (IllegalArgumentException e) { throw invalid("Snapshot id is invalid."); }
          requiredString(root, "nodeId");
        }
        break;
      case "screenshot":
        allowed.add("maxDimension");
        if (p.has("maxDimension")) {
          int dimension = integer(p, "maxDimension", true);
          if (dimension < 320 || dimension > 1440) throw invalid("Screenshot maxDimension must be from 320 to 1440.");
        }
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
      case "scroll":
        allowed.add("snapshotId"); allowed.add("nodeId"); allowed.add("direction");
        break;
      case "observe_action":
        allowed.add("action"); allowed.add("quietMs"); allowed.add("maxWaitMs");
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
      case "scroll":
        requiredString(p, "snapshotId"); requiredString(p, "nodeId");
        if (!Set.of("forward", "backward", "up", "down", "left", "right").contains(requiredString(p, "direction")))
          throw invalid("Scroll direction is unsupported.");
        break;
      case "observe_action":
        JSONObject nested = p.optJSONObject("action");
        if (nested == null) throw invalid("Observed action is invalid.");
        rejectUnknown(nested, Set.of("method", "params"));
        String nestedMethod = requiredString(nested, "method");
        if (!(nested.opt("params") instanceof JSONObject)) throw invalid("Observed action parameters are invalid.");
        if (Set.of("observe_action", "snapshot", "screenshot").contains(nestedMethod))
          throw invalid("The observed action must change or navigate the screen.");
        validateProperties(nestedMethod, nested.getJSONObject("params"));
        if (p.has("quietMs")) integer(p, "quietMs", true);
        if (p.has("maxWaitMs")) integer(p, "maxWaitMs", true);
        break;
      case "global_action":
        requiredString(p, "action");
        break;
      case "snapshot":
      case "screenshot":
        break;
    }
  }

  /** Rejects unexpected keys in nested protocol objects. */
  private static void rejectUnknown(JSONObject object, Set<String> allowed) throws Exception {
    JSONArray names = object.names();
    if (names != null) for (int i = 0; i < names.length(); i++)
      if (!allowed.contains(names.getString(i))) throw invalid("Command contains an unknown parameter.");
  }

  /** Creates a typed parameter validation error. */
  private static CommandFailure invalid(String message) {
    return new CommandFailure("INVALID_PARAMS", message);
  }

  /** Stops work whose local monotonic execution budget expired while queueing or executing. */
  private static void checkDeadline(long deadline) throws CommandFailure {
    if (deadline <= SystemClock.elapsedRealtime())
      throw new CommandFailure("COMMAND_EXPIRED", "This command has expired.");
  }

  /** One queued accessibility handle plus the nearest included ancestor. */
  private static final class QueuedNode {
    final AccessibilityNodeInfo node;
    final NodeCandidate parent;
    final int windowId;
    final String packageName;
    QueuedNode(AccessibilityNodeInfo node, NodeCandidate parent, int windowId, String packageName) {
      this.node = node; this.parent = parent; this.windowId = windowId; this.packageName = packageName;
    }
  }

  /** A visible node retained until the most useful 500 entries have been selected. */
  private static final class NodeCandidate {
    final AccessibilityNodeInfo node;
    final NodeCandidate parent;
    final int windowId, order;
    final String packageName;
    final Rect bounds;
    final boolean hasChildren;
    int score;
    boolean ownsNode = true;
    NodeCandidate(AccessibilityNodeInfo node, NodeCandidate parent, int windowId, String packageName, Rect bounds, int order, boolean hasChildren) {
      this.node = node; this.parent = parent; this.windowId = windowId; this.packageName = packageName;
      this.bounds = new Rect(bounds); this.order = order; this.hasChildren = hasChildren;
    }
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
