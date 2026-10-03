# Navigation and connectivity review

This file records the 3 October 2026 review of PhoneUse's Android accessibility actions, bridge command lifecycle, and MCP tools, followed by implementation of the seven main findings. Navigation speed gains have not been measured. The original findings below describe the earlier code; their line references are historical.

## Implementation status

| Finding                               | Implemented behavior                                                                                                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Large screenshots disconnect          | Linear canonical base64 validation accepts valid large PNG payloads without overflowing the JavaScript stack.                                                                                                              |
| Abandoned commands still execute      | HTTP and MCP cancellation removes queued commands. Canceling dispatched input closes the session and reports uncertainty, without replay.                                                                                  |
| Traversal enumeration exceeds bounds  | Root/child-query admissions are capped at 5,000, output at 500 nodes, and traversal checks elapsed budgets. Partial results report truncation.                                                                             |
| Separate action and observation turns | `phone_act_and_observe` performs one action and returns a bounded observation with separate success/failure. Temporary unavailable windows can settle without further input.                                               |
| Flat, incomplete navigation context   | Snapshots include window identities, compact ancestry, supported actions, and collection sizes. Current window/root scopes and semantic scroll are available. Useful controls receive priority.                            |
| Slow or misleading reconnection       | Suitable network transitions wake the single retry, stale callbacks cannot replace a newer session, and authentication/certificate/address failures stop retries with local recovery instructions. Consent resets on loss. |
| Clock-dependent deadlines             | Wire v2 carries a remaining execution budget. Bridge queueing and heartbeat use monotonic time; Android derives its own monotonic deadline before queueing.                                                                |

Screenshots also accept a bounded size and include physical display dimensions. Snapshot traversal reuses its initially validated roots while retaining a final all-window policy check. Optional aggregate timing counters remain future work. Scope inspection can revisit returned branches; it does not paginate every omitted sibling. Individual Android framework calls cannot be interrupted by traversal time checks.

Update the bridge and Android APK together and restart the agent's MCP session. Existing version 1 pairing identities remain compatible; the wire protocol is version 2.

Verification after implementation: bridge typecheck/build and all 14 integration tests passed. Android debug build, three retry-policy unit tests, and lint passed. The isolated API 36 emulator passed 25 navigation/safety checks and 16 connection-recovery checks, including dense/deep trees, temporary dialog-window transitions, blocked observations after successful actions, two abrupt reconnects, HTTP 403 denial, and a changed pinned certificate. The companion's connection error screen was visually inspected. Physical Wi-Fi handover, recovery during maximum backoff, vendor accessibility behavior, and large real-app trees remain device checks; no measured speedup is claimed.

## Fix first

### 1. Valid large screenshots disconnect the phone

Reproduced on Node 24.14.0. The screenshot base64 regex in `bridge/src/protocol.ts:70` raises `RangeError: Maximum call stack size exceeded` for some valid payloads below the supported limit.

A generated 810 by 1440 PNG contained 3,991,394 bytes, or 5,321,860 base64 characters. This fits Android's 5 MiB PNG ceiling in `PhoneAccessibilityService.java:417` and the bridge's message and string limits. Sending it through an isolated bridge with a simulated phone returned HTTP 502, `PROTOCOL_ERROR`, and `connected:false`. The catch in `bridge/src/bridge.ts:218` turns the validator failure into a session teardown. Existing screenshot tests use a tiny payload and miss this case.

Replace the repeated-group regex with a bounded linear base64 check. Keep alphabet, padding, and length validation. Add a valid large PNG integration case and malformed padding cases. This removes a demonstrated disconnection path on image-heavy screens.

### 2. Canceled queued requests can still act on the phone

Reproduced with an isolated bridge and simulated phone. While one tap was active, a second tap was queued, then its HTTP caller aborted. After the first tap completed, the bridge dispatched the abandoned second tap.

`bridge/src/bridge.ts:293` awaits `execute()` without linking the HTTP response lifecycle to the queue item. The item remains eligible until its deadline. MCP callbacks in `bridge/src/mcp.ts:25` also do not propagate cancellation to `requestLocal`. The default 35-second local timeout exceeds the default 30-second bridge deadline, so the stock timer alone does not create this mismatch. Custom bridge timeouts above 35 seconds do.

Remove undispatched commands when their caller disconnects. Propagate MCP cancellation through the HTTP client. Treat an already dispatched action as uncertain unless the phone confirms cancellation. Preserve the current short-segment swipe release and never replay an uncertain input. Test cancellation before dispatch, during dispatch, and immediately after completion.

### 3. Traversal limits do not bound child enumeration

Code-confirmed limit gap. `PhoneAccessibilityService.java:291` caps dequeued visits at 5,000 and returned nodes at 500, but the child loop at line 327 checks `visited` without incrementing it. A single broad node can therefore enqueue many more than 5,000 children before the outer limit applies. This runs on the Android main thread. The loop also has no elapsed-time or command-deadline check.

Bound total admitted nodes, queue size, children examined, and elapsed traversal time. Check session consent and the deadline within traversal. Return an explicit incomplete observation when a bound is reached. Add broad-tree and deep-tree fixtures, plus a repeated-snapshot stress check. The present fixture establishes basic behavior, not worst-case traversal cost.

## Improve agent navigation

### 4. Return a settled observation with an action

Code-based improvement opportunity. `bridge/src/mcp.ts:43` through line 50 return only `{performed:true}` for input actions. The agent must make another tool call to discover the result. Android's click, text, and global action methods acknowledge framework acceptance without waiting for the resulting UI to settle. Content and window events invalidate snapshot IDs in `PhoneAccessibilityService.java:72`.

The emulator harness already compensates with fixed waits and fresh-observation retries in `scripts/emulator-test.mjs:89` through line 107. That supports adding a proper bounded readiness mechanism, but does not establish a production stale-error rate.

Add an optional action-and-observe tool that executes exactly one action, waits for a short bounded quiet period, rechecks consent and every visible window's policy, then returns a fresh snapshot. Distinguish action success from observation failure so an agent cannot repeat a successful action because observation failed. Keep existing single-action tools. This can remove one agent/tool turn per navigation step without batching speculative inputs.

### 5. Give snapshots enough structure to navigate complex screens

Code-based improvement opportunity. `PhoneAccessibilityService.java:300` includes every visible node, including empty containers, until the 500-node result cap. `snapshot()` reads only the active window. `bridge/src/protocol.ts:62` provides a flat list without parent relationships, window identity, supported actions, or collection position. The service reports `scrollable`, but the protocol and MCP have no semantic scroll command.

Prioritize actionable nodes and useful labels within bounded traversal. Include compact parent/window relationships and supported actions so agents can associate a label with its clickable ancestor and distinguish scroll regions. Provide a bounded way to inspect omitted regions rather than repeatedly returning the same truncated prefix. Consider allowed visible application windows for split-screen and keyboard workflows, while retaining the all-window blocklist check.

Add a stale-checked semantic scroll tool using only actions the node advertises. Android documents [directional and forward scroll actions](https://developer.android.com/reference/android/view/accessibility/AccessibilityNodeInfo.AccessibilityAction). This avoids having the agent guess gesture coordinates and duration for standard lists. Test nested scroll regions, repeated labels, a keyboard, and large trees.

## Improve connection recovery

### 6. React to restored networks and explain permanent failures

Code-based improvement opportunity. `ConnectionService.java:195` schedules retries with exponential delay up to 60 seconds. It has no network-availability callback to advance a pending retry when Wi-Fi returns. Every `onFailure` at line 364 gets the same reconnect treatment, including authentication or certificate failures that a retry cannot repair.

Use a lifecycle-owned [Android network callback](https://developer.android.com/reference/android/net/ConnectivityManager.NetworkCallback) to trigger a bounded connection attempt when a suitable network becomes available. Track and replace pending retries so callbacks cannot create retry bursts. Classify authentication and pin failures into actionable local states instead of indefinite generic reconnecting. Preserve explicit disconnect and keep control disabled after a lost connection. Test network recovery during maximum backoff, repeated flaps, authentication denial, and a changed certificate.

### 7. Avoid cross-device wall-clock deadlines

Code-confirmed conditional fragility. `bridge/src/bridge.ts:177` creates an epoch deadline using desktop `Date.now()`. Android compares it to its own `System.currentTimeMillis()` in `ConnectionService.java:400` and `PhoneAccessibilityService.java:744`. A phone clock ahead of the desktop by more than the remaining budget rejects a fresh command. A phone clock behind the desktop extends the phone's local budget beyond the bridge's intended expiry.

Define a bounded remaining execution budget at dispatch, with transport expiry handled by the bridge, and translate it into a local monotonic deadline on Android. Android recommends [elapsedRealtime for interval timing](https://developer.android.com/reference/android/os/SystemClock). This requires a coordinated protocol change and tests for clock skew, clock changes, queue delay, and disconnect during execution. Retain session teardown for uncertain action timeouts.

## Smaller optimizations

- Reuse the validated active root within a single snapshot operation. Guards fetch all window roots at `PhoneAccessibilityService.java:236`, then `snapshot()` fetches windows and the active root again at line 270. Measure the gain before changing ownership or caching policy results across commands.
- Offer bounded screenshot resolution options and return physical display dimensions with the image. Android currently makes a full bitmap copy, scales to at most 1440 pixels, encodes PNG, and base64-serializes it at lines 401 through 424. Agents then need snapshot dimensions to map image coordinates. Profile encoding time and payload size before choosing another format.
- Add opt-in timing counters for queue wait, snapshot traversal, gesture completion, screenshot capture/encoding, and reconnect delay. Record aggregate durations and error codes only, without screen text, screenshots, typed text, or credentials.

## Original review verification

The bridge typecheck, build, and all six existing integration tests passed. Android debug APK and lint passed. All 16 existing behavior checks passed on the isolated API 36 `PhoneUse_Test` emulator, including snapshots, screenshot, text entry, semantic click, tap, swipe, global actions, stale nodes, denied control, protected apps, secure content, interrupted swipe, and explicit disconnect.

Separate synthetic reproductions established the large-PNG validation failure and abandoned queued-tap dispatch. They used isolated bridge instances and temporary credentials, not a personal phone.

Physical Wi-Fi recovery, vendor accessibility behavior, and large real application trees still need device testing. No measured navigation speedup is claimed. Suggested implementation order is screenshot validation and cancellation, then bounded traversal and connection recovery, followed by richer observations and action-and-observe tools.
