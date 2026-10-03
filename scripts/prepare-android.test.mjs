/** Checks Android bootstrap reuse, consent, metadata parsing and network bounds using fixtures. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareAndroid } from './prepare-android.mjs';

/** Create a fixture directory structure that represents installed SDK 36 packages. */
async function createSdk(sdkHome) {
  await mkdir(join(sdkHome, 'platforms/android-36'), { recursive: true });
  await mkdir(join(sdkHome, 'build-tools/36.0.0'), { recursive: true });
  await mkdir(join(sdkHome, 'platform-tools'), { recursive: true });
  await writeFile(join(sdkHome, 'platforms/android-36/android.jar'), 'fixture');
  await writeFile(join(sdkHome, 'platform-tools/adb'), 'fixture');
}

/** Create a fake Java executable path detected by the host bootstrap. */
async function createJdk(jdkHome) {
  const javaPath = join(jdkHome, 'bin/java');
  await mkdir(join(jdkHome, 'bin'), { recursive: true });
  await writeFile(javaPath, 'fixture');

  return javaPath;
}

/** Run setup with temporary environment values, then restore the caller's environment. */
async function withEnvironment(values, action) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));

  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }

  try {
    return await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** Return a valid Adoptium API fixture using the binary.package metadata shape. */
function adoptiumResponse() {
  return new Response(
    JSON.stringify([
      {
        binary: {
          architecture: 'x64',
          package: {
            checksum: '0'.repeat(64),
            link: 'https://github.com/adoptium/temurin17-binaries/releases/download/test/jdk.tar.gz',
            name: 'jdk.tar.gz',
          },
        },
      },
    ]),
    { status: 200 },
  );
}

test('reuses a valid configured JDK 17 and complete Android SDK 36', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phoneuse-android-reuse-'));
  const jdkHome = join(root, 'jdk');
  const sdkHome = join(root, 'sdk');
  const javaPath = await createJdk(jdkHome);
  const commands = [];

  await createSdk(sdkHome);

  try {
    await withEnvironment({ JAVA_HOME: jdkHome, ANDROID_HOME: sdkHome }, async () => {
      const result = await prepareAndroid({
        repositoryRoot: root,
        platform: 'linux',
        arch: 'x64',
        run: async (command, args) => {
          commands.push({ command, args });

          return { output: 'openjdk version "17.0.12"', status: 0 };
        },
        fetchImpl: async () => {
          throw new Error('Network should not be used when existing tools are valid.');
        },
      });

      assert.deepEqual(result, { JAVA_HOME: jdkHome, ANDROID_HOME: sdkHome });
      assert.deepEqual(commands, [{ command: javaPath, args: ['-version'] }]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('requires Android SDK license approval without sending automatic yes answers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phoneuse android license-'));
  const jdkHome = join(root, 'jdk');
  const javaPath = await createJdk(jdkHome);
  const sdkHome = join(root, 'artifacts/toolchain/android-sdk');
  const sdkmanager = join(sdkHome, 'cmdline-tools/latest/bin/sdkmanager');
  const calls = [];

  await mkdir(join(sdkHome, 'cmdline-tools/latest/bin'), { recursive: true });
  await writeFile(sdkmanager, 'fixture');

  try {
    await withEnvironment({ JAVA_HOME: jdkHome, ANDROID_HOME: sdkHome }, async () => {
      const recoveryCommand =
        `JAVA_HOME='${jdkHome}' '${sdkmanager}' ` + `--sdk_root='${sdkHome}' --licenses`;

      await assert.rejects(
        prepareAndroid({
          repositoryRoot: root,
          platform: 'linux',
          arch: 'x64',
          run: async (command, args, options = {}) => {
            calls.push({ command, args, input: options.input });

            if (command === javaPath) {
              return { output: 'openjdk version "17.0.12"', status: 0 };
            }

            const error = new Error('sdkmanager could not continue.');
            error.output = 'License for package Android SDK Platform 36 not accepted.';
            throw error;
          },
          fetchImpl: async () => {
            throw new Error('No downloads should be needed with local sdkmanager.');
          },
        }),
        (error) =>
          error.code === 'ANDROID_LICENSE_REQUIRED' &&
          error.sdkmanager === sdkmanager &&
          error.recoveryCommand === recoveryCommand &&
          error.message.includes(recoveryCommand),
      );
    });

    const sdkCalls = calls.filter(({ command }) => command === sdkmanager);
    assert.equal(sdkCalls.length, 1);
    assert.ok(sdkCalls[0].args.includes('--install'));
    assert.equal(sdkCalls[0].args.includes('--licenses'), false);
    assert.equal(sdkCalls[0].input, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts Android SDK licenses only when explicitly requested', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phoneuse-android-license-optin-'));
  const jdkHome = join(root, 'jdk');
  const javaPath = await createJdk(jdkHome);
  const sdkHome = join(root, 'artifacts/toolchain/android-sdk');
  const sdkmanager = join(sdkHome, 'cmdline-tools/latest/bin/sdkmanager');
  const sdkCalls = [];

  await mkdir(join(sdkHome, 'cmdline-tools/latest/bin'), { recursive: true });
  await writeFile(sdkmanager, 'fixture');

  try {
    await withEnvironment({ JAVA_HOME: jdkHome, ANDROID_HOME: sdkHome }, async () => {
      const result = await prepareAndroid({
        repositoryRoot: root,
        platform: 'linux',
        arch: 'x64',
        acceptAndroidLicenses: true,
        run: async (command, args, options = {}) => {
          if (command === javaPath) {
            return { output: 'openjdk version "17.0.12"', status: 0 };
          }

          sdkCalls.push({ args, input: options.input });

          if (args.includes('--install')) {
            await createSdk(sdkHome);
          }

          return { output: '', status: 0 };
        },
        fetchImpl: async () => {
          throw new Error('No downloads should be needed with local sdkmanager.');
        },
      });

      assert.deepEqual(result, { JAVA_HOME: jdkHome, ANDROID_HOME: sdkHome });
    });

    assert.equal(sdkCalls.length, 2);
    assert.ok(sdkCalls[0].args.includes('--licenses'));
    assert.equal(sdkCalls[0].input, 'y\n'.repeat(20));
    assert.ok(sdkCalls[1].args.includes('--install'));
    assert.equal(sdkCalls[1].input, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an Adoptium archive redirect to an unapproved host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phoneuse-android-host-'));
  const sdkHome = join(root, 'sdk');
  const calls = [];

  await createSdk(sdkHome);

  try {
    await withEnvironment(
      { JAVA_HOME: join(root, 'missing-jdk'), ANDROID_HOME: sdkHome },
      async () => {
        await assert.rejects(
          prepareAndroid({
            repositoryRoot: root,
            platform: 'linux',
            arch: 'x64',
            run: async () => {
              throw new Error('No existing JDK should validate.');
            },
            fetchImpl: async (url) => {
              calls.push(url.hostname);

              return url.hostname === 'api.adoptium.net'
                ? adoptiumResponse()
                : new Response(null, {
                    status: 302,
                    headers: { location: 'https://example.invalid/jdk.tar.gz' },
                  });
            },
          }),
          { code: 'ANDROID_UNTRUSTED_SOURCE' },
        );
      },
    );

    assert.deepEqual(calls, ['api.adoptium.net', 'github.com']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('caps Android tool metadata reads even when content-length is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phoneuse-android-metadata-limit-'));
  const sdkHome = join(root, 'sdk');
  const oversized = new Uint8Array(12 * 1024 * 1024 + 1);

  await createSdk(sdkHome);

  try {
    await withEnvironment(
      { JAVA_HOME: join(root, 'missing-jdk'), ANDROID_HOME: sdkHome },
      async () => {
        await assert.rejects(
          prepareAndroid({
            repositoryRoot: root,
            platform: 'linux',
            arch: 'x64',
            run: async () => {
              throw new Error('No existing JDK should validate.');
            },
            fetchImpl: async () => new Response(oversized),
          }),
          { code: 'ANDROID_METADATA_TOO_LARGE' },
        );
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('limits metadata redirects to five hops', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phoneuse-android-redirect-limit-'));
  const sdkHome = join(root, 'sdk');
  const calls = [];

  await createSdk(sdkHome);

  try {
    await withEnvironment(
      { JAVA_HOME: join(root, 'missing-jdk'), ANDROID_HOME: sdkHome },
      async () => {
        await assert.rejects(
          prepareAndroid({
            repositoryRoot: root,
            platform: 'linux',
            arch: 'x64',
            run: async () => {
              throw new Error('No existing JDK should validate.');
            },
            fetchImpl: async (url) => {
              calls.push(url.hostname);

              return new Response(null, {
                status: 302,
                headers: { location: 'https://api.adoptium.net/next' },
              });
            },
          }),
          { code: 'ANDROID_TOO_MANY_REDIRECTS' },
        );
      },
    );

    assert.equal(calls.length, 6);
    assert.ok(calls.every((host) => host === 'api.adoptium.net'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('removes an Adoptium archive whose SHA-256 does not match its metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phoneuse-android-checksum-'));
  const sdkHome = join(root, 'sdk');
  const calls = [];

  await createSdk(sdkHome);

  try {
    await withEnvironment(
      { JAVA_HOME: join(root, 'missing-jdk'), ANDROID_HOME: sdkHome },
      async () => {
        await assert.rejects(
          prepareAndroid({
            repositoryRoot: root,
            platform: 'linux',
            arch: 'x64',
            run: async () => {
              throw new Error('No existing JDK should validate.');
            },
            fetchImpl: async (url) => {
              calls.push(url.hostname);

              return url.hostname === 'api.adoptium.net'
                ? adoptiumResponse()
                : new Response(new Uint8Array([1, 2, 3]), { status: 200 });
            },
          }),
          { code: 'ANDROID_CHECKSUM_MISMATCH' },
        );
      },
    );

    assert.deepEqual(calls, ['api.adoptium.net', 'github.com']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolves the official macOS ARM tools checksum and archive from Google metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phoneuse-android-arm-metadata-'));
  const jdkHome = join(root, 'jdk');
  const javaPath = await createJdk(jdkHome);
  const sdkHome = join(root, 'artifacts/toolchain/android-sdk');
  const archive = new Uint8Array([1, 2, 3]);
  const archiveHash = createHash('sha256').update(archive).digest('hex');
  const archiveName = 'commandlinetools-mac_arm64-99999999_latest.zip';
  const page = `<table><tr><td>Mac (ARM)</td><td>${archiveName}</td><td>1 MB</td><td>${archiveHash}</td></tr></table>`;
  const calls = [];

  try {
    await withEnvironment({ HOME: root, JAVA_HOME: jdkHome, ANDROID_HOME: sdkHome }, async () => {
      const result = await prepareAndroid({
        repositoryRoot: root,
        platform: 'darwin',
        arch: 'arm64',
        acceptAndroidLicenses: true,
        run: async (command, args, options = {}) => {
          if (command === '/usr/libexec/java_home') {
            return { output: jdkHome, status: 0 };
          }

          if (command === javaPath) {
            return { output: 'openjdk version "17.0.12"', status: 0 };
          }

          if (command === 'unzip') {
            const outputDirectory = args[args.indexOf('-d') + 1];
            const fakeManager = join(outputDirectory, 'cmdline-tools/bin/sdkmanager');
            await mkdir(join(fakeManager, '..'), { recursive: true });
            await writeFile(fakeManager, 'fixture');

            return { output: '', status: 0 };
          }

          if (args.includes('--install')) {
            await createSdk(sdkHome);
          }

          return { output: '', status: 0, input: options.input };
        },
        fetchImpl: async (url) => {
          calls.push(url.href);

          if (url.hostname === 'dl.google.com' && url.pathname.endsWith('repository2-1.xml')) {
            return new Response(
              '<repository><remotePackage path="cmdline-tools;23.0"><channelRef ref="channel-0"/><archive><complete><size>3</size><checksum>0123456789012345678901234567890123456789</checksum><url>commandlinetools-mac_x86_64-99999999_latest.zip</url></complete><host-os>macosx</host-os><host-bits>64</host-bits></archive></remotePackage></repository>',
            );
          }

          if (url.hostname === 'developer.android.com') {
            return new Response(page);
          }

          return new Response(archive, { status: 200 });
        },
      });

      assert.deepEqual(result, { JAVA_HOME: jdkHome, ANDROID_HOME: sdkHome });
    });

    assert.ok(calls.includes('https://developer.android.com/studio?hl=en'));
    assert.ok(calls.includes(`https://dl.google.com/android/repository/${archiveName}`));
    assert.equal(
      calls.some((url) => url.includes('mac_x86_64-99999999')),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explains that Windows toolchain setup is unsupported', async () => {
  await assert.rejects(
    prepareAndroid({ repositoryRoot: '/tmp/phoneuse', platform: 'win32', arch: 'x64' }),
    { code: 'ANDROID_HOST_UNSUPPORTED' },
  );
});
