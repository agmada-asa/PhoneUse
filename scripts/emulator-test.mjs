/** Exercises real Android actions and guardrails on the disposable PhoneUse_Test emulator only. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../bridge/dist/src/bridge.js';
import { requestLocal } from '../bridge/dist/src/local-client.js';
import { PNG } from 'pngjs';

/** Fixed isolated serial and AVD prevent this harness from operating a personal device. */
const serial = 'emulator-5560';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adbPath = resolve(
  process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`,
  'platform-tools/adb',
);
const execute = promisify(execFile);
const stateDir = resolve(root, 'artifacts/emulator-state');
let bridge;
let checks = 0;

/** Runs ADB without echoing command arguments, which can include a private pairing code. */
async function adb(...args) {
  try {
    return (
      await execute(adbPath, ['-s', serial, ...args], {
        maxBuffer: 5 * 1024 * 1024,
        timeout: 20000,
      })
    ).stdout;
  } catch {
    throw new Error(`ADB test operation failed: ${args[0]}`);
  }
}

/** Allows Android accessibility events and transitions to settle before verification. */
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads UI bounds internally; pairing material is never emitted into test output. */
async function uiNodes() {
  await adb('shell', 'uiautomator', 'dump', '/sdcard/phoneuse-test.xml');
  const xml = await adb('exec-out', 'cat', '/sdcard/phoneuse-test.xml');
  return [...xml.matchAll(/<node\s+([^>]+)>?/g)].map((match) => {
    const attrs = Object.fromEntries(
      [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((item) => [
        item[1],
        item[2].replaceAll('&amp;', '&').replaceAll('&quot;', '"'),
      ]),
    );
    const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attrs.bounds ?? '');
    return {
      ...attrs,
      center: bounds
        ? [
            Math.round((Number(bounds[1]) + Number(bounds[3])) / 2),
            Math.round((Number(bounds[2]) + Number(bounds[4])) / 2),
          ]
        : null,
    };
  });
}

/** Finds and taps a local setup control, scrolling only within the test app when needed. */
async function localTap(text) {
  if (/mInputShown=true/.test(await adb('shell', 'dumpsys', 'input_method'))) {
    await adb('shell', 'input', 'keyevent', '4');
    await settle();
  }
  for (let attempt = 0; attempt < 7; attempt++) {
    // This harness fixes the display at 1080x1920. Scroll controls above the navigation bar
    // before tapping; UiAutomation also reports clipped nodes underneath that bar.
    const node = (await uiNodes()).find(
      (item) => item.text?.toLocaleLowerCase('en') === text.toLocaleLowerCase('en') && item.center,
    );
    if (node && node.center[1] > 100 && node.center[1] < 1720) {
      // UiAutomation can briefly unbind accessibility; let it restore before the user's consent tap.
      await settle(1200);
      await adb('shell', 'input', 'tap', String(node.center[0]), String(node.center[1]));
      await settle();
      return;
    }
    if (node && node.center[1] <= 100)
      await adb('shell', 'input', 'swipe', '500', '500', '500', '1600', '250');
    else await adb('shell', 'input', 'swipe', '500', '1600', '500', '500', '250');
    await settle();
  }
  throw new Error(`Setup control unavailable: ${text}`);
}

/** Polls connection state until it reaches a specific, bounded readiness condition. */
async function waitStatus(predicate) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const value = await requestLocal('/api/status', undefined, { stateDir, adminPort: 18766 });
    if (predicate(value)) return value;
    await settle(250);
  }
  throw new Error('The test phone did not reach the expected connection state.');
}

/** Sends one command through the same authenticated API used by the MCP process. */
async function command(method, params = {}) {
  const value = await requestLocal(
    '/api/command',
    { method, params },
    { stateDir, adminPort: 18766 },
  );
  return value.result;
}

/** Records behavior assertions without retaining phone contents in logs. */
function passed(label) {
  checks++;
  console.log(`PASS ${label}`);
}

/** Requests an expected policy failure and checks its machine-readable code. */
async function denied(method, params, code) {
  await assert.rejects(command(method, params), (error) => error.code === code);
}

/** Opens the harmless fixture using ADB only as the local emulator operator. */
async function fixture() {
  await adb('shell', 'am', 'start', '-n', 'dev.phoneuse.fixture/.FixtureActivity');
  await settle(3000);
}

/** Waits for window ownership to settle after navigation without retrying the input action. */
async function settledSnapshot() {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await command('snapshot');
    } catch (error) {
      if (error.code !== 'APP_BLOCKED') throw error;
      await settle(400);
    }
  }
  throw new Error('Window ownership did not settle after navigation.');
}

/** Reobserves only after a stale-ID rejection that guarantees the semantic action did not occur. */
async function fixtureNodeAction(find, method, params = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const screen = await settledSnapshot();
    const node = screen.nodes.find(find);
    assert.ok(node, 'Fixture control exists');
    try {
      await command(method, { snapshotId: screen.snapshotId, nodeId: node.id, ...params });
      return { screen, node };
    } catch (error) {
      if (error.code !== 'STALE_SNAPSHOT') throw error;
      await settle(600);
    }
  }
  throw new Error('Fixture transition did not settle before the semantic action.');
}

/** Observes one fixture node action, retrying only stale rejections that precede execution. */
async function fixtureObserveNodeAction(find, method, params = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const screen = await settledSnapshot();
    const node = screen.nodes.find(find);
    assert.ok(node, 'Fixture control exists');
    if (method === 'click')
      assert.ok(node.actions?.includes('click'), 'Fixture control advertises semantic click');
    if (method === 'scroll') {
      assert.ok(
        node.actions?.includes(`scroll_${params.direction}`),
        'Fixture control advertises the requested scroll',
      );
    }
    try {
      const result = await command('observe_action', {
        action: { method, params: { snapshotId: screen.snapshotId, nodeId: node.id, ...params } },
      });
      return { screen, node, result };
    } catch (error) {
      if (error.code !== 'STALE_SNAPSHOT') throw error;
      await settle(600);
    }
  }
  throw new Error('Fixture transition did not settle before the observed action.');
}

/** Observes one fixture button click without repeating a completed action. */
async function fixtureObserveClick(text) {
  return fixtureObserveNodeAction((node) => node.text === text, 'click');
}

/** Clicks a fresh fixture button after any launch transition has settled. */
async function fixtureClick(text) {
  return fixtureNodeAction((node) => node.text === text, 'click');
}

/** Reobserves a subtree when a delayed accessibility event invalidates its prior snapshot. */
async function fixtureScopedSnapshot(find) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const screen = await settledSnapshot();
    const node = screen.nodes.find(find);
    assert.ok(node, 'Fixture subtree remains addressable');
    try {
      return await command('snapshot', {
        root: { snapshotId: screen.snapshotId, nodeId: node.id },
      });
    } catch (error) {
      if (error.code !== 'STALE_SNAPSHOT') throw error;
      await settle(600);
    }
  }
  throw new Error('Fixture subtree did not settle before inspection.');
}

/** Confirms the secure fixture's central content is concealed when Android returns a masked image. */
function assertSecurePixelsHidden(screenshot) {
  const image = PNG.sync.read(Buffer.from(screenshot.data, 'base64'));
  for (let y = Math.floor(image.height * 0.2); y < image.height * 0.8; y += 8) {
    for (let x = Math.floor(image.width * 0.2); x < image.width * 0.8; x += 8) {
      const offset = (image.width * y + x) * 4;
      assert.ok(
        image.data[offset] < 8 && image.data[offset + 1] < 8 && image.data[offset + 2] < 8,
        'Secure fixture content must be masked',
      );
    }
  }
}

/** Performs deterministic setup and verifies real observation, input, and device-local denial. */
async function main() {
  assert.match(await adb('emu', 'avd', 'name'), /^PhoneUse_Test\r?\n/);
  await adb('shell', 'wm', 'size', '1080x1920');
  await adb('shell', 'wm', 'density', '420');
  await adb('install', '-r', resolve(root, 'artifacts/PhoneUse-debug.apk'));
  await adb(
    'install',
    '-r',
    resolve(root, 'android/fixture/build/outputs/apk/debug/fixture-debug.apk'),
  );
  await adb('shell', 'pm', 'clear', 'dev.phoneuse.app');
  await adb('shell', 'pm', 'clear', 'dev.phoneuse.fixture');
  await adb('shell', 'pm', 'grant', 'dev.phoneuse.app', 'android.permission.POST_NOTIFICATIONS');
  await adb(
    'shell',
    'settings',
    'put',
    'secure',
    'enabled_accessibility_services',
    'dev.phoneuse.app/dev.phoneuse.app.PhoneAccessibilityService',
  );
  await adb('shell', 'settings', 'put', 'secure', 'accessibility_enabled', '1');
  bridge = await createBridge({
    stateDir,
    host: '0.0.0.0',
    advertisedHost: '10.0.2.2',
    phonePort: 18765,
    adminPort: 18766,
    commandTimeoutMs: 12000,
  });
  await adb('shell', 'am', 'start', '-n', 'dev.phoneuse.app/.MainActivity');
  await settle(1200);
  await localTap('Paste a code instead');
  const editor = (await uiNodes()).find((item) => item.class === 'android.widget.EditText');
  assert.ok(editor?.center, 'Pairing editor exists');
  await adb('shell', 'input', 'tap', ...editor.center.map(String));
  await settle(1000); // Let the keyboard and form scroll settle before injecting the full code.
  const { code } = await requestLocal('/api/pairing', undefined, { stateDir, adminPort: 18766 });
  // The software keyboard can drop a long burst of injected key events on a busy emulator.
  for (const chunk of code.match(/.{1,16}/g) ?? []) {
    await adb('shell', 'input', 'text', chunk);
    await settle(100);
  }
  await adb('shell', 'input', 'keyevent', '4');
  await settle();
  await localTap('Save pairing code');
  // Saving a valid pairing connects immediately; consent remains off until the local switch.
  await waitStatus((value) => value.connected);
  passed('manual pairing saves credentials and connects');
  await denied('snapshot', {}, 'CONTROL_DISABLED');
  passed('control disabled refuses observation');
  await localTap('Allow this computer to control the phone');
  await waitStatus((value) => value.status?.controlEnabled);
  await denied('snapshot', {}, 'APP_BLOCKED');
  passed('Phone Use settings cannot be read remotely');
  await fixture();
  let screen = await settledSnapshot();
  assert.equal(screen.packageName, 'dev.phoneuse.fixture');
  assert.ok(screen.nodes.length > 5);
  assert.ok(screen.screen.width > 0);
  passed('snapshot returns actual fixture nodes and display dimensions');
  assert.ok(
    Array.isArray(screen.windows) && screen.windows.length > 0,
    'Snapshot reports accessible windows',
  );
  assert.ok(
    screen.nodes.every((node) => Number.isInteger(node.windowId)),
    'Every node identifies its owning window',
  );
  assert.ok(
    screen.nodes.some(
      (node) => node.parentId && screen.nodes.some((parent) => parent.id === node.parentId),
    ),
    'Hierarchy exposes parent relationships',
  );
  const fixtureScroller = screen.nodes.find((node) => node.scrollable);
  assert.ok(
    fixtureScroller?.actions?.includes('scroll_forward'),
    'Scrollable fixture advertises forward scrolling at its top',
  );
  const fixtureInput = screen.nodes.find((node) => node.viewId?.endsWith('/input'));
  assert.ok(fixtureInput?.actions?.includes('set_text'), 'Editable fixture advertises text entry');
  const fixtureButton = screen.nodes.find((node) => node.text === 'Increment counter');
  assert.ok(fixtureButton?.actions?.includes('click'), 'Button advertises semantic click');
  passed('snapshot exposes a compact, actionable hierarchy with window and parent metadata');

  await fixtureClick('Open scope dialog');
  await settle(400);
  const windowed = await command('snapshot');
  assert.ok(
    windowed.windows.length >= 2,
    'Opening a native dialog exposes a second accessible window',
  );
  const dialogWindowId = windowed.nodes.find((node) => node.text === 'Scoped dialog')?.windowId;
  assert.ok(Number.isInteger(dialogWindowId));
  const dialogSnapshot = await command('snapshot', { windowId: dialogWindowId });
  assert.ok(
    dialogSnapshot.nodes.length > 0 &&
      dialogSnapshot.nodes.every((node) => node.windowId === dialogWindowId),
    'Window scope contains only the selected window',
  );
  const dialogClose = dialogSnapshot.nodes.find((node) => node.viewId?.endsWith('button1'));
  assert.ok(dialogClose?.actions?.includes('click'));
  const closeAction = await fixtureObserveNodeAction(
    (node) => node.viewId?.endsWith('button1'),
    'click',
  );
  assert.equal(closeAction.result.performed, true);
  assert.equal(
    closeAction.result.observation.ok,
    true,
    `Dialog observation: ${closeAction.result.observation.error?.code ?? 'missing'}`,
  );
  assert.equal(closeAction.result.observation.settled, true);
  screen = closeAction.result.observation.snapshot;
  const sectionScroll = await fixtureObserveNodeAction(
    (node) => node.scrollable && node.actions?.includes('scroll_forward'),
    'scroll',
    { direction: 'forward' },
  );
  assert.equal(sectionScroll.result.performed, true);
  assert.equal(
    sectionScroll.result.observation.ok,
    true,
    `Scroll observation: ${sectionScroll.result.observation.error?.code ?? 'missing'}`,
  );
  assert.equal(sectionScroll.result.observation.settled, true);
  screen = sectionScroll.result.observation.snapshot;
  const hierarchyRoot = screen.nodes.find((node) => node.viewId?.endsWith('/scroll_section'));
  assert.ok(hierarchyRoot, 'Fixture has a stable subtree root');
  const rootSnapshot = await command('snapshot', {
    root: { snapshotId: screen.snapshotId, nodeId: hierarchyRoot.id },
  });
  const scopedRoot = rootSnapshot.nodes.find((node) => node.viewId?.endsWith('/scroll_section'));
  assert.ok(scopedRoot, 'Scoped hierarchy retains its requested root');
  const visibleListItems = screen.nodes.filter((node) => /^List item \d+$/.test(node.text ?? ''));
  assert.ok(visibleListItems.length > 0, 'A list item is visible in the settled section viewport');
  for (const item of visibleListItems) {
    assert.ok(
      rootSnapshot.nodes.some((node) => node.text === item.text),
      `Scoped hierarchy includes visible ${item.text}`,
    );
  }
  const scopedNodesById = new Map(rootSnapshot.nodes.map((node) => [node.id, node]));
  for (const node of rootSnapshot.nodes) {
    let current = node;
    const visited = new Set();
    while (current.id !== scopedRoot.id) {
      assert.ok(
        current.parentId && scopedNodesById.has(current.parentId),
        'Every scoped node retains its in-scope parent',
      );
      assert.ok(!visited.has(current.id), 'Scoped ancestry contains no cycle');
      visited.add(current.id);
      current = scopedNodesById.get(current.parentId);
    }
  }
  assert.ok(
    !rootSnapshot.nodes.some((node) => node.text === 'Increment counter'),
    'Subtree scope excludes unrelated fixture controls',
  );
  assert.ok(
    rootSnapshot.nodes.length < screen.nodes.length,
    'Root scope excludes unrelated fixture controls',
  );
  await assert.rejects(
    command('snapshot', {
      windowId: dialogWindowId,
      root: { snapshotId: screen.snapshotId, nodeId: hierarchyRoot.id },
    }),
  );
  const sectionBackscroll = await fixtureObserveNodeAction(
    (node) => node.scrollable && node.actions?.includes('scroll_backward'),
    'scroll',
    { direction: 'backward' },
  );
  assert.equal(sectionBackscroll.result.performed, true);
  assert.equal(sectionBackscroll.result.observation.ok, true);
  assert.equal(sectionBackscroll.result.observation.settled, true);
  screen = sectionBackscroll.result.observation.snapshot;
  passed('snapshot supports mutually exclusive window and subtree scopes');

  let input = screen.nodes.find((node) => node.viewId?.endsWith('/input'));
  assert.ok(input?.editable);
  const target = await fixtureNodeAction((node) => node.viewId?.endsWith('/input'), 'set_text', {
    text: 'Phone Use verified',
  });
  const beforeText = target.screen;
  input = target.node;
  await settle(600);
  screen = await command('snapshot');
  assert.ok(screen.nodes.some((node) => node.text === 'Phone Use verified'));
  passed('semantic text entry changes the actual field');
  await denied(
    'set_text',
    { snapshotId: beforeText.snapshotId, nodeId: input.id, text: 'wrong' },
    'STALE_SNAPSHOT',
  );
  passed('stale snapshot cannot change a field');
  const password = screen.nodes.find((node) => node.viewId?.endsWith('/password'));
  assert.ok(password && !password.editable && !password.text);
  assert.ok(
    !JSON.stringify(screen).includes('fixture-only-secret'),
    'Fixture password content is absent from every snapshot field',
  );
  await denied(
    'set_text',
    { snapshotId: screen.snapshotId, nodeId: password.id, text: 'never' },
    'ACTION_FAILED',
  );
  passed('password fields are redacted and refuse remote text');
  let button = screen.nodes.find((node) => node.text === 'Increment counter');
  assert.ok(button);
  await fixtureClick('Increment counter');
  await settle();
  screen = await command('snapshot');
  assert.ok(screen.nodes.some((node) => node.text === 'Button presses: 1'));
  passed('semantic click increments exactly once');
  button = screen.nodes.find((node) => node.text === 'Increment counter');
  await command('tap', {
    x: Math.round((button.bounds.left + button.bounds.right) / 2),
    y: Math.round((button.bounds.top + button.bounds.bottom) / 2),
  });
  await settle();
  screen = await command('snapshot');
  assert.ok(screen.nodes.some((node) => node.text === 'Button presses: 2'));
  passed('coordinate tap uses the requested point');
  button = screen.nodes.find((node) => node.text === 'Increment counter');
  const observedClick = await command('observe_action', {
    action: { method: 'click', params: { snapshotId: screen.snapshotId, nodeId: button.id } },
  });
  assert.equal(observedClick.performed, true);
  assert.equal(observedClick.observation.ok, true);
  assert.equal(observedClick.observation.settled, true);
  screen = observedClick.observation.snapshot;
  assert.ok(screen.nodes.some((node) => node.text === 'Button presses: 3'));
  passed('observe_action performs one semantic click and returns its settled result');
  const screenshot = await command('screenshot');
  assert.equal(screenshot.mimeType, 'image/png');
  assert.equal(Buffer.from(screenshot.data, 'base64').subarray(1, 4).toString(), 'PNG');
  assert.ok(screenshot.width <= 1440 && screenshot.height <= 1440);
  assert.deepEqual(
    screenshot.screen,
    { width: screen.screen.width, height: screen.screen.height },
    'Screenshot reports physical display dimensions',
  );
  await settle(1100); // The phone intentionally rate-limits screenshot capture.
  const smallerScreenshot = await command('screenshot', { maxDimension: 480 });
  assert.ok(
    smallerScreenshot.width <= 480 && smallerScreenshot.height <= 480,
    'Requested screenshot dimension is honored',
  );
  await mkdir(resolve(root, 'artifacts'), { recursive: true });
  await writeFile(
    resolve(root, 'artifacts/emulator-fixture.png'),
    Buffer.from(screenshot.data, 'base64'),
  );
  passed('screenshot is a real bounded PNG');
  const { width, height } = screen.screen;
  await command('swipe', {
    startX: Math.round(width / 2),
    startY: Math.round(height * 0.8),
    endX: Math.round(width / 2),
    endY: Math.round(height * 0.35),
    durationMs: 300,
  });
  await settle();
  const scrolled = await command('snapshot');
  assert.notEqual(
    JSON.stringify(scrolled.nodes.map((node) => node.bounds)),
    JSON.stringify(screen.nodes.map((node) => node.bounds)),
  );
  passed('swipe changes the scroll position');
  const forwardScroll = await fixtureObserveNodeAction(
    (node) => node.scrollable && node.actions?.includes('scroll_forward'),
    'scroll',
    { direction: 'forward' },
  );
  assert.equal(forwardScroll.result.performed, true);
  assert.equal(forwardScroll.result.observation.ok, true);
  assert.equal(forwardScroll.result.observation.settled, true);
  const semanticScrolled = forwardScroll.result.observation.snapshot;
  assert.notEqual(
    JSON.stringify(semanticScrolled.nodes.map((node) => node.bounds)),
    JSON.stringify(forwardScroll.screen.nodes.map((node) => node.bounds)),
    'Semantic scroll changes the position from its fresh pre-action snapshot',
  );
  const backwardScroll = await fixtureObserveNodeAction(
    (node) => node.scrollable && node.actions?.includes('scroll_backward'),
    'scroll',
    { direction: 'backward' },
  );
  assert.equal(backwardScroll.result.performed, true);
  assert.equal(backwardScroll.result.observation.ok, true);
  assert.equal(backwardScroll.result.observation.settled, true);
  const returnedBySemanticScroll = backwardScroll.result.observation.snapshot;
  assert.notEqual(
    JSON.stringify(returnedBySemanticScroll.nodes.map((node) => node.bounds)),
    JSON.stringify(backwardScroll.screen.nodes.map((node) => node.bounds)),
    'Backward semantic scroll changes the position from its fresh pre-action snapshot',
  );
  await command('swipe', {
    startX: Math.round(width / 2),
    startY: Math.round(height * 0.2),
    endX: Math.round(width / 2),
    endY: Math.round(height * 0.9),
    durationMs: 300,
  });
  await settle();
  await settledSnapshot();
  passed('semantic scrolling follows the node advertised capability');

  const blockedAction = await fixtureObserveClick('Open Phone Use settings');
  const blockedObservation = blockedAction.result;
  assert.equal(
    blockedObservation.performed,
    true,
    'Action remains successful when follow-up observation is blocked',
  );
  assert.equal(blockedObservation.observation.ok, false);
  assert.equal(blockedObservation.observation.error.code, 'APP_BLOCKED');
  passed('observe_action separates successful input from a newly blocked observation');
  await fixture();
  screen = await settledSnapshot();
  const passwordNode = screen.nodes.find((node) => node.viewId?.endsWith('/password'));
  assert.ok(passwordNode);
  await denied(
    'scroll',
    { snapshotId: screen.snapshotId, nodeId: passwordNode.id, direction: 'down' },
    'ACTION_FAILED',
  );
  passed('semantic scroll refuses directions the target does not advertise');

  await fixtureClick('Open large hierarchy');
  await settle(500);
  const largeStartedAt = Date.now();
  const largeScreen = await settledSnapshot();
  const largeElapsed = Date.now() - largeStartedAt;
  assert.ok(largeElapsed < 10000, `Large hierarchy snapshot stays bounded (${largeElapsed} ms)`);
  assert.ok(
    largeScreen.nodes.length <= 500,
    'Large hierarchy result respects the protocol node ceiling',
  );
  assert.ok(
    largeScreen.nodes.some((node) => node.editable && node.actions?.includes('set_text')),
    'Traversal prioritizes the useful editor beyond the broad decorative list',
  );
  assert.ok(
    largeScreen.nodes.some(
      (node) =>
        node.clickable && node.text === 'Priority action' && node.actions?.includes('click'),
    ),
    'Traversal preserves a useful late-branch action',
  );
  passed('broad fixture traversal preserves useful late controls within the visit budget');
  await fixtureClick('Open bounded traversal');
  await settle(500);
  const boundedStartedAt = Date.now();
  const boundedScreen = await settledSnapshot();
  const boundedElapsed = Date.now() - boundedStartedAt;
  assert.ok(
    boundedElapsed < 10000,
    `Over-budget hierarchy snapshot stays bounded (${boundedElapsed} ms)`,
  );
  assert.ok(
    boundedScreen.nodes.length <= 500,
    'Over-budget hierarchy result respects the protocol node ceiling',
  );
  assert.equal(boundedScreen.truncated, true, 'Traversal reports omitted nodes explicitly');
  const deepRoot = boundedScreen.nodes.find((node) => node.viewId?.endsWith('/deep_section'));
  assert.ok(deepRoot, 'The useful early branch remains addressable in the bounded snapshot');
  const deepScoped = await fixtureScopedSnapshot((node) => node.viewId?.endsWith('/deep_section'));
  assert.ok(
    deepScoped.nodes.some((node) => node.text === 'Deep scoped target'),
    'A scoped traversal reaches the deep branch target',
  );
  assert.ok(deepScoped.nodes.length < 100, 'The scoped result stays local to the selected subtree');
  for (let repeat = 0; repeat < 3; repeat++) {
    const repeated = await settledSnapshot();
    assert.ok(
      repeated.truncated && repeated.nodes.length <= 500,
      'Repeated broad snapshots retain their bounds',
    );
  }
  passed('over-budget breadth is bounded, marked truncated, and deep content remains scopeable');
  await command('global_action', { action: 'back' });
  await settle(500);
  await fixture();
  screen = await settledSnapshot();
  await command('global_action', { action: 'home' });
  await settle();
  assert.notEqual((await settledSnapshot()).packageName, 'dev.phoneuse.fixture');
  passed('Home changes the foreground app');
  await command('global_action', { action: 'recents' });
  await settle(1500);
  await command('global_action', { action: 'back' });
  await settle(1500);
  passed('Recent apps and Back execute');
  await adb('shell', 'am', 'force-stop', 'dev.phoneuse.fixture');
  await fixture();
  await fixtureClick('Open secure screen');
  await settle(1000);
  try {
    const protectedImage = await command('screenshot');
    assertSecurePixelsHidden(protectedImage);
  } catch (error) {
    // Unknown window ownership can also deny capture before Android's secure-image check.
    assert.ok(
      ['CAPTURE_FAILED', 'CAPTURE_SECURE', 'CAPTURE_UNAVAILABLE', 'APP_BLOCKED'].includes(
        error.code,
      ),
      'Secure capture must fail or conceal pixels',
    );
  }
  passed('secure screen refuses capture or masks protected pixels');
  await adb('shell', 'am', 'force-stop', 'dev.phoneuse.fixture');
  await fixture();
  const started = Date.now();
  const interrupted = command('swipe', {
    startX: Math.round(width / 2),
    startY: Math.round(height * 0.8),
    endX: Math.round(width / 2),
    endY: Math.round(height * 0.35),
    durationMs: 3000,
  }).then(
    () => null,
    (error) => error,
  );
  await settle(200);
  await adb('shell', 'am', 'start', '-n', 'dev.phoneuse.app/.MainActivity');
  await settle();
  assert.equal((await interrupted)?.code, 'APP_BLOCKED');
  assert.ok(
    Date.now() - started < 2000,
    'A protected window must interrupt a long swipe before its planned end',
  );
  passed('opening a protected app interrupts an in-flight long swipe');
  assert.equal(
    (await waitStatus((value) => value.connected)).status.controlEnabled,
    true,
    'Interrupted swipe preserves local consent',
  );
  await localTap('Choose apps');
  // Filter the picker so the fixture row is on screen without scrolling the list.
  await localTap('Search apps');
  await adb('shell', 'input', 'text', 'dev.phoneuse.fixture');
  await settle();
  await localTap('Phone Use test screen');
  await localTap('Save');
  // uiautomator dump temporarily suppresses accessibility services. Restore consent locally after setup.
  await localTap('Allow this computer to control the phone');
  await waitStatus((value) => value.status?.controlEnabled && value.status?.accessibilityEnabled);
  await fixture();
  for (const [method, params] of [
    ['snapshot', {}],
    ['screenshot', {}],
    ['tap', { x: 300, y: 300 }],
    ['swipe', { startX: 300, startY: 800, endX: 300, endY: 400, durationMs: 200 }],
    ['global_action', { action: 'home' }],
    ['click', { snapshotId: screen.snapshotId, nodeId: '1' }],
    ['set_text', { snapshotId: screen.snapshotId, nodeId: '1', text: 'blocked' }],
    ['scroll', { snapshotId: screen.snapshotId, nodeId: '1', direction: 'forward' }],
    ['observe_action', { action: { method: 'tap', params: { x: 300, y: 300 } } }],
  ])
    await denied(method, params, 'APP_BLOCKED');
  passed('blocklist denies all observation and input methods');
  await requestLocal('/api/disconnect', {}, { stateDir, adminPort: 18766 });
  await settle(2000);
  assert.equal(
    (await requestLocal('/api/status', undefined, { stateDir, adminPort: 18766 })).connected,
    false,
  );
  passed('explicit desktop disconnect does not reconnect');
  console.log(`Android end-to-end checks passed: ${checks}`);
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error
      ? `${error.message}${error.code ? ` (${error.code})` : ''}`
      : 'Emulator verification failed.',
  );
  process.exitCode = 1;
} finally {
  if (bridge) {
    await bridge.close();
    await adb('shell', 'rm', '-f', '/sdcard/phoneuse-test.xml').catch(() => {});
  }
}
