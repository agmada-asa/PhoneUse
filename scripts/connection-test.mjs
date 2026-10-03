/** Verifies Android reconnection and consent reset against an authenticated TLS mock on PhoneUse_Test only. */
import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import { createServer as createTlsServer } from 'node:https';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { ensureState } from '../bridge/dist/src/state.js';

/** Fixed isolated emulator and ports shared with the disposable main emulator harness. */
const serial = 'emulator-5560';
const phonePort = 18765;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adbPath = resolve(
  process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`,
  'platform-tools/adb',
);
const stateDir = resolve(root, 'artifacts/emulator-state');
const statePath = resolve(stateDir, 'state.json');
const certPath = resolve(stateDir, 'phoneuse-cert.pem');
const keyPath = resolve(stateDir, 'phoneuse-key.pem');
const execute = promisify(execFile);
const activeSockets = new Set();
const acceptedConnections = [];
const violations = [];
let rejectionStatus = 0;
let rejectionCount = 0;
let handshakeCount = 0;
let server;
let wsServer;
let deviceVerified = false;
let xmlCreated = false;
let checks = 0;
let tlsFailures = 0;
let alternateStateDir;

/** Runs only against the fixed emulator after the AVD identity has been verified. */
async function adb(...args) {
  const identityCheck =
    args.length === 3 && args[0] === 'emu' && args[1] === 'avd' && args[2] === 'name';
  if (!deviceVerified && !identityCheck)
    throw new Error('Emulator identity check must run before ADB setup.');
  try {
    const stdout = (
      await execute(adbPath, ['-s', serial, ...args], {
        maxBuffer: 5 * 1024 * 1024,
        timeout: 20000,
      })
    ).stdout;
    if (identityCheck) {
      if (!/^PhoneUse_Test\r?\n(?:OK\r?\n)?$/.test(stdout))
        throw new Error('Refusing ADB access because the selected AVD is not PhoneUse_Test.');
      deviceVerified = true;
    }
    return stdout;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing ADB')) throw error;
    throw new Error('ADB test operation failed.');
  }
}

/** Waits briefly for Android UI and connection callbacks to settle. */
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

/** Checks one behavior and reports only the fixed test label. */
function passed(condition, label) {
  if (!condition) throw new Error(label);
  checks++;
  console.log(`PASS ${label}`);
}

/** Waits for an asynchronous service or mock-server state with a fixed bound. */
async function waitFor(predicate, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await settle(100);
  }
  throw new Error(label);
}

/** Reads current local UI nodes without printing or persisting their text. */
async function uiNodes() {
  await adb('shell', 'uiautomator', 'dump', '/sdcard/phoneuse-connection-test.xml');
  xmlCreated = true;
  const xml = await adb('exec-out', 'cat', '/sdcard/phoneuse-connection-test.xml');
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

/** Taps a visible PhoneUse control, scrolling within the local setup screen if needed. */
async function localTap(text) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const node = (await uiNodes()).find(
      (item) => item.text?.toLocaleLowerCase('en') === text.toLocaleLowerCase('en') && item.center,
    );
    if (node && node.center[1] > 100 && node.center[1] < 1720) {
      await settle(900);
      await adb('shell', 'input', 'tap', String(node.center[0]), String(node.center[1]));
      await settle(500);
      return;
    }
    if (node && node.center[1] <= 100)
      await adb('shell', 'input', 'swipe', '500', '500', '500', '1600', '250');
    else await adb('shell', 'input', 'swipe', '500', '1600', '500', '500', '250');
    await settle(250);
  }
  throw new Error('A required local PhoneUse control was unavailable.');
}

/** Opens the main activity and starts a paired foreground session using the phone UI. */
async function openPhoneConnection() {
  await adb('shell', 'am', 'start', '-n', 'dev.phoneuse.app/.MainActivity');
  await settle(1200);
  await localTap('Connect');
}

/** Enables control only through the on-device consent switch. */
async function enableLocalConsent() {
  await localTap('Allow this computer to control the phone');
}

/** Creates a WSS-only mock that uses the paired certificate and requires the saved bearer token. */
async function startMock(state) {
  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
  const actualFingerprint = createHash('sha256')
    .update(new X509Certificate(cert).raw)
    .digest('hex');
  if (!/^[a-f0-9]{64}$/.test(state.phoneToken) || !/^[a-f0-9]{64}$/.test(actualFingerprint))
    throw new Error('Saved emulator pairing state is invalid.');
  server = createTlsServer({ cert, key, minVersion: 'TLSv1.2' });
  server.on('tlsClientError', () => {
    tlsFailures++;
  });
  wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false,
  });
  server.on('upgrade', (request, socket, head) => {
    handshakeCount++;
    if (request.url !== '/phone') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const authorization = request.headers.authorization ?? '';
    const expected = Buffer.from(`Bearer ${state.phoneToken}`);
    const actual = Buffer.from(authorization);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      rejectionCount++;
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (rejectionStatus) {
      rejectionCount++;
      const message = rejectionStatus === 403 ? 'Forbidden' : 'Unauthorized';
      socket.write(`HTTP/1.1 ${rejectionStatus} ${message}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (ws) => wsServer.emit('connection', ws, request));
  });
  wsServer.on('connection', (socket) => {
    if (activeSockets.size) violations.push('overlapping socket generations');
    activeSockets.add(socket);
    const record = { socket, hellos: [] };
    acceptedConnections.push(record);
    socket.on('message', (raw, binary) => {
      if (binary) {
        violations.push('binary protocol frame');
        return;
      }
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        violations.push('invalid JSON frame');
        return;
      }
      if (
        frame?.type !== 'hello' ||
        frame.version !== 2 ||
        typeof frame.status?.controlEnabled !== 'boolean'
      ) {
        violations.push('invalid hello frame');
        return;
      }
      record.hellos.push(frame);
    });
    socket.on('error', () => {});
    socket.on('close', () => activeSockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', () =>
      reject(new Error('Could not start the isolated TLS mock on port 18765.')),
    );
    server.listen(phonePort, '0.0.0.0', resolve);
  });
  return actualFingerprint;
}

/** Waits for the next accepted socket to send its first valid hello frame. */
async function nextHello(afterIndex, timeoutMs = 10000) {
  await waitFor(
    () =>
      acceptedConnections.length > afterIndex && acceptedConnections[afterIndex]?.hellos.length > 0,
    timeoutMs,
    'PhoneUse did not reconnect to the authenticated mock within the expected window.',
  );
  return acceptedConnections[afterIndex];
}

/** Confirms no stale or replacement connection callback overlapped another socket generation. */
function assertNoOverlap() {
  passed(
    violations.length === 0 && activeSockets.size <= 1,
    'socket generations never overlap and protocol hellos stay valid',
  );
}

/** Captures a UI error assertion without printing other screen content. */
async function hasLocalPairingError() {
  const nodes = await uiNodes();
  return nodes.some((node) => node.text?.includes('Pairing authorization failed'));
}

/** Waits for fixed recovery guidance on the local companion screen. */
async function waitForLocalCertificateError() {
  for (let attempt = 0; attempt < 5; attempt++) {
    if ((await uiNodes()).some((node) => node.text?.includes('The paired certificate is invalid')))
      return;
    await settle(500);
  }
  throw new Error('The phone did not explain the changed certificate.');
}

/** Abruptly drops the current test peer while retaining the same authenticated mock server. */
async function flap(record) {
  const beforeIndex = acceptedConnections.length;
  const closed = new Promise((resolve) => record.socket.once('close', resolve));
  record.socket.terminate();
  await Promise.race([closed, settle(2000)]);
  const reconnected = await nextHello(beforeIndex);
  passed(
    reconnected.hellos[0].status.controlEnabled === false,
    'reconnected session requires fresh local consent',
  );
  assertNoOverlap();
  return reconnected;
}

/** Runs controlled transport-loss, local-disconnect, and terminal-authentication checks. */
async function main() {
  const avdName = await adb('emu', 'avd', 'name');
  if (!/^PhoneUse_Test\r?\n(?:OK\r?\n)?$/.test(avdName))
    throw new Error('Refusing to run unless emulator-5560 is PhoneUse_Test.');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const pin = await startMock(state);
  passed(pin.length === 64, 'mock WSS endpoint uses the paired certificate identity');

  await adb('install', '-r', resolve(root, 'artifacts/PhoneUse-debug.apk'));
  await adb('shell', 'wm', 'size', '1080x1920');
  await adb('shell', 'wm', 'density', '420');
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
  await openPhoneConnection();
  const first = await nextHello(0, 10000);
  passed(
    first.hellos[0].version === 2 && first.hellos[0].status.controlEnabled === false,
    'authenticated v2 connection starts with control disabled',
  );
  passed(
    handshakeCount === 1 && rejectionCount === 0,
    'mock accepts only the paired bearer credential',
  );
  assertNoOverlap();

  await enableLocalConsent();
  await waitFor(
    () => first.hellos.some((frame) => frame.status.controlEnabled),
    5000,
    'Local consent did not reach the connected mock.',
  );
  passed(true, 'local consent switch alone enables the mock session');

  let current = await flap(first);
  await enableLocalConsent();
  await waitFor(
    () => current.hellos.some((frame) => frame.status.controlEnabled),
    5000,
    'Consent did not enable the first recovered session.',
  );
  current = await flap(current);

  const acceptedBeforeDisconnect = acceptedConnections.length;
  const disconnected = new Promise((resolve) => current.socket.once('close', resolve));
  await localTap('Disconnect');
  await Promise.race([disconnected, settle(2000)]);
  await settle(2600);
  passed(
    acceptedConnections.length === acceptedBeforeDisconnect && activeSockets.size === 0,
    'explicit phone disconnect suppresses automatic reconnect',
  );

  const beforeConnect = acceptedConnections.length;
  await openPhoneConnection();
  current = await nextHello(beforeConnect, 10000);
  passed(
    current.hellos[0].status.controlEnabled === false,
    'a user-started connection also begins with consent off',
  );
  rejectionStatus = 403;
  const rejectionsBefore = rejectionCount;
  const acceptedBeforeDeniedAttempt = acceptedConnections.length;
  current.socket.terminate();
  await waitFor(
    () => rejectionCount === rejectionsBefore + 1,
    10000,
    'The configured authorization denial was not attempted.',
  );
  await settle(2600);
  passed(
    rejectionCount === rejectionsBefore + 1 &&
      acceptedConnections.length === acceptedBeforeDeniedAttempt &&
      activeSockets.size === 0,
    'HTTP 403 pairing failure stops automatic retries',
  );
  passed(await hasLocalPairingError(), 'phone UI explains how to repair denied pairing');
  const { stdout: screenshot } = await execute(
    adbPath,
    ['-s', serial, 'exec-out', 'screencap', '-p'],
    { encoding: 'buffer', maxBuffer: 5 * 1024 * 1024, timeout: 20000 },
  );
  await writeFile(resolve(root, 'artifacts/emulator-connection-error.png'), screenshot);

  alternateStateDir = await mkdtemp(resolve(tmpdir(), 'phoneuse-pin-test-'));
  const alternate = await ensureState(alternateStateDir);
  const [alternateCert, alternateKey] = await Promise.all([
    readFile(alternate.certPath),
    readFile(alternate.keyPath),
  ]);
  rejectionStatus = 0;
  server.setSecureContext({ cert: alternateCert, key: alternateKey });
  const tlsFailuresBefore = tlsFailures;
  const acceptedBeforePinMismatch = acceptedConnections.length;
  await openPhoneConnection();
  await waitForLocalCertificateError();
  passed(
    tlsFailures > tlsFailuresBefore && acceptedConnections.length === acceptedBeforePinMismatch,
    'changed desktop certificate is refused before authentication',
  );
  const failedHandshakes = tlsFailures;
  await settle(2600);
  passed(
    tlsFailures === failedHandshakes && activeSockets.size === 0,
    'certificate pin failure stops automatic retries and explains recovery',
  );
  assertNoOverlap();
  console.log(`Connection recovery checks passed: ${checks}`);
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Connection recovery verification failed.',
  );
  process.exitCode = 1;
} finally {
  rejectionStatus = 0;
  for (const socket of activeSockets) socket.terminate();
  if (wsServer) await new Promise((resolve) => wsServer.close(() => resolve()));
  if (server) await new Promise((resolve) => server.close(() => resolve()));
  if (alternateStateDir) await rm(alternateStateDir, { recursive: true, force: true });
  if (deviceVerified && xmlCreated)
    await adb('shell', 'rm', '-f', '/sdcard/phoneuse-connection-test.xml').catch(() => {});
}
