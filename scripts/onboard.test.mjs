/** Verifies onboarding choices, APK validation, and a persistent console using isolated identities and ports. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { parseOnboardingOptions, startOnboardingBridge, validateApk } from './onboard.mjs';

/** Checkout used only for its built executable, never for its normal identity or phone connection. */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Holds both available ports until selected so the phone and admin ports cannot be identical. */
async function ports() {
  const listeners = [createServer(), createServer()];
  await Promise.all(
    listeners.map((listener) => new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))),
  );
  const result = listeners.map((listener) => listener.address().port);
  await Promise.all(listeners.map((listener) => new Promise((resolve) => listener.close(resolve))));
  return result;
}

test('onboarding validates host and APK choices before work; help does not install anything', () => {
  assert.equal(parseOnboardingOptions([]).skill, true);
  assert.equal(parseOnboardingOptions(['--codex']).codex, true);
  assert.equal(parseOnboardingOptions(['--accept-android-licenses']).acceptAndroidLicenses, true);
  assert.throws(() => parseOnboardingOptions(['--codex', '--skill']), /Choose/);
  assert.throws(() => parseOnboardingOptions(['--apk']), /Provide a path/);
  const help = spawnSync(
    process.execPath,
    [join(repositoryRoot, 'scripts/onboard.mjs'), '--help'],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
  assert.equal(help.status, 0);
  assert.match(help.stdout, /npm run onboard/);
});

test('APK validation accepts a manifest archive, rejects plain files and unrelated ZIP files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phoneuse-apk-validation-'));

  try {
    await writeFile(join(root, 'AndroidManifest.xml'), 'fixture manifest');
    const apk = join(root, 'test.apk');
    assert.equal(spawnSync('zip', ['-q', apk, 'AndroidManifest.xml'], { cwd: root }).status, 0);
    await validateApk(apk);
    await writeFile(join(root, 'plain.apk'), 'plain file');
    await assert.rejects(validateApk(join(root, 'plain.apk')), /not an APK ZIP archive/);
    const other = join(root, 'other.apk');
    assert.equal(spawnSync('zip', ['-q', other, 'plain.apk'], { cwd: root }).status, 0);
    await assert.rejects(validateApk(other), /does not contain an Android manifest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'onboarding returns a live persistent console, reuses it, and supports authenticated stop',
  { timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'phoneuse-persistent-console-'));
    const stateDir = join(root, 'private state');
    const [phonePort, adminPort] = await ports();
    const env = {
      ...process.env,
      PHONEUSE_STATE_DIR: stateDir,
      PHONEUSE_PHONE_PORT: String(phonePort),
      PHONEUSE_ADMIN_PORT: String(adminPort),
      PHONEUSE_ADVERTISE_HOST: '127.0.0.1',
    };
    let consoleUrl;
    let token;

    try {
      const first = await startOnboardingBridge(repositoryRoot, env, true);
      consoleUrl = first.consoleUrl;
      assert.equal(first.bridgeStarted, true);
      token = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')).adminToken;
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const status = await fetch(`${consoleUrl}/api/status`, { headers }).then((response) =>
        response.json(),
      );
      assert.equal(status.agentConfigured, true);
      assert.equal(status.connected, false);
      const second = await startOnboardingBridge(repositoryRoot, env, true);
      assert.equal(second.bridgeStarted, false);
      assert.equal(second.consoleUrl, consoleUrl);
      assert.equal((await fetch(`${consoleUrl}/api/status`, { headers })).status, 200);
      assert.equal(
        (await fetch(`${consoleUrl}/api/stop`, { method: 'POST', headers, body: '{}' })).status,
        200,
      );
      let stopped = false;

      for (let attempt = 0; attempt < 30; attempt += 1) {
        await delay(100);

        try {
          await fetch(`${consoleUrl}/api/status`, { headers, signal: AbortSignal.timeout(500) });
        } catch {
          stopped = true;
          break;
        }
      }

      assert.equal(stopped, true);
    } finally {
      if (consoleUrl && token) {
        await fetch(`${consoleUrl}/api/stop`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(1000),
        }).catch(() => undefined);
      }

      await rm(root, { recursive: true, force: true });
    }
  },
);
