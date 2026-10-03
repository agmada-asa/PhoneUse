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
const adbPath = resolve(process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`, 'platform-tools/adb');
const execute = promisify(execFile);
const stateDir = resolve(root, 'artifacts/emulator-state');
let bridge;
let checks = 0;

/** Runs ADB without echoing command arguments, which can include a private pairing code. */
async function adb(...args) {
  try { return (await execute(adbPath, ['-s', serial, ...args], { maxBuffer: 5 * 1024 * 1024, timeout: 20000 })).stdout; }
  catch { throw new Error(`ADB test operation failed: ${args[0]}`); }
}

/** Allows Android accessibility events and transitions to settle before verification. */
const settle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));

/** Reads UI bounds internally; pairing material is never emitted into test output. */
async function uiNodes() {
  await adb('shell', 'uiautomator', 'dump', '/sdcard/phoneuse-test.xml');
  const xml = await adb('exec-out', 'cat', '/sdcard/phoneuse-test.xml');
  return [...xml.matchAll(/<node\s+([^>]+)>?/g)].map(match => {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(item => [item[1], item[2].replaceAll('&amp;', '&').replaceAll('&quot;', '"')]));
    const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attrs.bounds ?? '');
    return { ...attrs, center: bounds ? [Math.round((Number(bounds[1]) + Number(bounds[3])) / 2), Math.round((Number(bounds[2]) + Number(bounds[4])) / 2)] : null };
  });
}

/** Finds and taps a local setup control, scrolling only within the test app when needed. */
async function localTap(text) {
  if (/mInputShown=true/.test(await adb('shell', 'dumpsys', 'input_method'))) {
    await adb('shell', 'input', 'keyevent', '4'); await settle();
  }
  for (let attempt = 0; attempt < 7; attempt++) {
    const node = (await uiNodes()).find(item => item.text?.toLocaleLowerCase('en') === text.toLocaleLowerCase('en') && item.center);
    if (node) {
      // UiAutomation can briefly unbind accessibility; let it restore before the user's consent tap.
      await settle(1200);
      await adb('shell', 'input', 'tap', String(node.center[0]), String(node.center[1])); await settle(); return;
    }
    await adb('shell', 'input', 'swipe', '500', '1600', '500', '500', '250'); await settle();
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
  const value = await requestLocal('/api/command', { method, params }, { stateDir, adminPort: 18766 });
  return value.result;
}

/** Records behavior assertions without retaining phone contents in logs. */
function passed(label) { checks++; console.log(`PASS ${label}`); }

/** Requests an expected policy failure and checks its machine-readable code. */
async function denied(method, params, code) {
  await assert.rejects(command(method, params), error => error.code === code);
}

/** Opens the harmless fixture using ADB only as the local emulator operator. */
async function fixture() { await adb('shell', 'am', 'start', '-n', 'dev.phoneuse.fixture/.FixtureActivity'); await settle(800); }

/** Reobserves only after a stale-ID rejection that guarantees the semantic action did not occur. */
async function fixtureNodeAction(find, method, params = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const screen = await command('snapshot');
    const node = screen.nodes.find(find);
    assert.ok(node, 'Fixture control exists');
    try { await command(method, { snapshotId: screen.snapshotId, nodeId: node.id, ...params }); return { screen, node }; }
    catch (error) { if (error.code !== 'STALE_SNAPSHOT') throw error; await settle(600); }
  }
  throw new Error('Fixture transition did not settle before the semantic action.');
}

/** Clicks a fresh fixture button after any launch transition has settled. */
async function fixtureClick(text) { return fixtureNodeAction(node => node.text === text, 'click'); }

/** Confirms the secure fixture's central content is concealed when Android returns a masked image. */
function assertSecurePixelsHidden(screenshot) {
  const image = PNG.sync.read(Buffer.from(screenshot.data, 'base64'));
  for (let y = Math.floor(image.height * .2); y < image.height * .8; y += 8) {
    for (let x = Math.floor(image.width * .2); x < image.width * .8; x += 8) {
      const offset = (image.width * y + x) * 4;
      assert.ok(image.data[offset] < 8 && image.data[offset + 1] < 8 && image.data[offset + 2] < 8, 'Secure fixture content must be masked');
    }
  }
}

/** Performs deterministic setup and verifies real observation, input, and device-local denial. */
async function main() {
  assert.match(await adb('emu', 'avd', 'name'), /^PhoneUse_Test\r?\n/);
  await adb('shell', 'wm', 'size', '1080x1920');
  await adb('shell', 'wm', 'density', '420');
  await adb('install', '-r', resolve(root, 'artifacts/PhoneUse-debug.apk'));
  await adb('install', '-r', resolve(root, 'android/fixture/build/outputs/apk/debug/fixture-debug.apk'));
  await adb('shell', 'pm', 'clear', 'dev.phoneuse.app');
  await adb('shell', 'pm', 'clear', 'dev.phoneuse.fixture');
  await adb('shell', 'pm', 'grant', 'dev.phoneuse.app', 'android.permission.POST_NOTIFICATIONS');
  await adb('shell', 'settings', 'put', 'secure', 'enabled_accessibility_services', 'dev.phoneuse.app/dev.phoneuse.app.PhoneAccessibilityService');
  await adb('shell', 'settings', 'put', 'secure', 'accessibility_enabled', '1');
  bridge = await createBridge({ stateDir, host: '0.0.0.0', advertisedHost: '10.0.2.2', phonePort: 18765, adminPort: 18766, commandTimeoutMs: 12000 });
  await adb('shell', 'am', 'start', '-n', 'dev.phoneuse.app/.MainActivity'); await settle(1200);
  const editor = (await uiNodes()).find(item => item.class === 'android.widget.EditText');
  assert.ok(editor?.center, 'Pairing editor exists');
  await adb('shell', 'input', 'tap', ...editor.center.map(String));
  const { code } = await requestLocal('/api/pairing', undefined, { stateDir, adminPort: 18766 });
  await adb('shell', 'input', 'text', code);
  await adb('shell', 'input', 'keyevent', '4'); await settle();
  await localTap('Save pairing code'); await localTap('OK');
  await localTap('Connect');
  await waitStatus(value => value.connected);
  await denied('snapshot', {}, 'CONTROL_DISABLED'); passed('control disabled refuses observation');
  await localTap('Allow this computer to control the phone');
  await waitStatus(value => value.status?.controlEnabled);
  await denied('snapshot', {}, 'APP_BLOCKED'); passed('PhoneUse settings cannot be read remotely');
  await fixture();
  let screen = await command('snapshot');
  assert.equal(screen.packageName, 'dev.phoneuse.fixture'); assert.ok(screen.nodes.length > 5); assert.ok(screen.screen.width > 0);
  passed('snapshot returns actual fixture nodes and display dimensions');
  let input = screen.nodes.find(node => node.viewId?.endsWith('/input'));
  assert.ok(input?.editable);
  const target = await fixtureNodeAction(node => node.viewId?.endsWith('/input'), 'set_text', { text: 'PhoneUse verified' });
  const beforeText = target.screen; input = target.node; await settle(600);
  screen = await command('snapshot');
  assert.ok(screen.nodes.some(node => node.text === 'PhoneUse verified')); passed('semantic text entry changes the actual field');
  await denied('set_text', { snapshotId: beforeText.snapshotId, nodeId: input.id, text: 'wrong' }, 'STALE_SNAPSHOT'); passed('stale snapshot cannot change a field');
  const password = screen.nodes.find(node => node.viewId?.endsWith('/password'));
  assert.ok(password && !password.editable && !password.text);
  assert.ok(!JSON.stringify(screen).includes('fixture-only-secret'), 'Fixture password content is absent from every snapshot field');
  await denied('set_text', { snapshotId: screen.snapshotId, nodeId: password.id, text: 'never' }, 'ACTION_FAILED'); passed('password fields are redacted and refuse remote text');
  let button = screen.nodes.find(node => node.text === 'Increment counter');
  assert.ok(button);
  await fixtureClick('Increment counter'); await settle();
  screen = await command('snapshot'); assert.ok(screen.nodes.some(node => node.text === 'Button presses: 1')); passed('semantic click increments exactly once');
  button = screen.nodes.find(node => node.text === 'Increment counter');
  await command('tap', { x: Math.round((button.bounds.left + button.bounds.right) / 2), y: Math.round((button.bounds.top + button.bounds.bottom) / 2) }); await settle();
  screen = await command('snapshot'); assert.ok(screen.nodes.some(node => node.text === 'Button presses: 2')); passed('coordinate tap uses the requested point');
  const screenshot = await command('screenshot');
  assert.equal(screenshot.mimeType, 'image/png'); assert.equal(Buffer.from(screenshot.data, 'base64').subarray(1, 4).toString(), 'PNG'); assert.ok(screenshot.width <= 1440 && screenshot.height <= 1440);
  await mkdir(resolve(root, 'artifacts'), { recursive: true }); await writeFile(resolve(root, 'artifacts/emulator-fixture.png'), Buffer.from(screenshot.data, 'base64')); passed('screenshot is a real bounded PNG');
  const { width, height } = screen.screen;
  await command('swipe', { startX: Math.round(width / 2), startY: Math.round(height * .8), endX: Math.round(width / 2), endY: Math.round(height * .35), durationMs: 300 }); await settle();
  const scrolled = await command('snapshot');
  assert.notEqual(JSON.stringify(scrolled.nodes.map(node => node.bounds)), JSON.stringify(screen.nodes.map(node => node.bounds))); passed('swipe changes the scroll position');
  await command('global_action', { action: 'home' }); await settle(); assert.notEqual((await command('snapshot')).packageName, 'dev.phoneuse.fixture'); passed('Home changes the foreground app');
  await command('global_action', { action: 'recents' }); await settle(); await command('global_action', { action: 'back' }); await settle(); passed('Recent apps and Back execute');
  await adb('shell', 'am', 'force-stop', 'dev.phoneuse.fixture'); await fixture();
  await fixtureClick('Open secure screen'); await settle(1000);
  try {
    const protectedImage = await command('screenshot');
    assertSecurePixelsHidden(protectedImage);
  } catch (error) {
    assert.ok(['CAPTURE_FAILED', 'CAPTURE_SECURE', 'CAPTURE_UNAVAILABLE'].includes(error.code), 'Secure capture must fail or conceal pixels');
  }
  passed('secure screen refuses capture or masks protected pixels');
  await adb('shell', 'am', 'force-stop', 'dev.phoneuse.fixture'); await fixture();
  const started = Date.now();
  const interrupted = command('swipe', { startX: Math.round(width / 2), startY: Math.round(height * .8), endX: Math.round(width / 2), endY: Math.round(height * .35), durationMs: 3000 }).then(() => null, error => error);
  await settle(200);
  await adb('shell', 'am', 'start', '-n', 'dev.phoneuse.app/.MainActivity'); await settle();
  assert.equal((await interrupted)?.code, 'APP_BLOCKED');
  assert.ok(Date.now() - started < 2000, 'A protected window must interrupt a long swipe before its planned end');
  passed('opening a protected app interrupts an in-flight long swipe');
  assert.equal((await waitStatus(value => value.connected)).status.controlEnabled, true, 'Interrupted swipe preserves local consent');
  await localTap('Choose apps to block'); await localTap('PhoneUse test screen  ·  dev.phoneuse.fixture'); await localTap('Save');
  // uiautomator dump temporarily suppresses accessibility services. Restore consent locally after setup.
  await localTap('Allow this computer to control the phone');
  await waitStatus(value => value.status?.controlEnabled && value.status?.accessibilityEnabled);
  await fixture();
  for (const [method, params] of [['snapshot', {}], ['screenshot', {}], ['tap', { x: 300, y: 300 }], ['swipe', { startX: 300, startY: 800, endX: 300, endY: 400, durationMs: 200 }], ['global_action', { action: 'home' }], ['click', { snapshotId: screen.snapshotId, nodeId: '1' }], ['set_text', { snapshotId: screen.snapshotId, nodeId: '1', text: 'blocked' }]]) await denied(method, params, 'APP_BLOCKED');
  passed('blocklist denies all observation and input methods');
  await requestLocal('/api/disconnect', {}, { stateDir, adminPort: 18766 }); await settle(2000);
  assert.equal((await requestLocal('/api/status', undefined, { stateDir, adminPort: 18766 })).connected, false); passed('explicit desktop disconnect does not reconnect');
  console.log(`Android end-to-end checks passed: ${checks}`);
}

try { await main(); }
catch (error) { console.error(error instanceof Error ? `${error.message}${error.code ? ` (${error.code})` : ''}` : 'Emulator verification failed.'); process.exitCode = 1; }
finally {
  if (bridge) {
    await bridge.close();
    await adb('shell', 'rm', '-f', '/sdcard/phoneuse-test.xml').catch(() => {});
  }
}
