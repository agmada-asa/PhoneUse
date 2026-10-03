/** Prepares a private JDK and Android SDK for PhoneUse's local APK build. */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

/** Keep each upstream metadata and archive transfer within two minutes total. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Allow sdkmanager up to ten minutes for installation on a slower connection. */
const SDK_MANAGER_TIMEOUT_MS = 600_000;

/** Bound captured child-process diagnostics to one mebibyte. */
const PROCESS_OUTPUT_LIMIT = 1024 * 1024;

/** Cap a downloaded JDK archive at 600 MiB. */
const MAX_JDK_DOWNLOAD = 600 * 1024 * 1024;

/** Cap Android command-line tools archives at 250 MiB. */
const MAX_ANDROID_TOOLS_DOWNLOAD = 250 * 1024 * 1024;

/** Bound upstream tool metadata at 12 MiB. */
const MAX_METADATA_BYTES = 12 * 1024 * 1024;

/** Limit upstream downloads to five redirects. */
const MAX_REDIRECT_HOPS = 5;

/** Only these official release hosts may serve checked tool archives and redirects. */
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'api.adoptium.net',
  'github.com',
  'github-releases.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'dl.google.com',
]);

/** Official APIs and documentation that publish archive URLs and verification checksums. */
const ALLOWED_METADATA_HOSTS = new Set([
  'api.adoptium.net',
  'dl.google.com',
  'developer.android.com',
]);

/** Raise a stable error code so callers can present actionable setup guidance. */
function setupError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);

  return error;
}

/** Quote a value for a single POSIX shell argument, including embedded apostrophes. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Check whether a file or directory exists without turning absence into a setup failure. */
async function pathExists(path) {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

/** Run a bounded child process and capture enough output for setup diagnostics. */
function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    let overflow = false;

    const finish = (error, result) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise(result);
      }
    };

    const append = (chunk) => {
      if (output.length + chunk.length > PROCESS_OUTPUT_LIMIT) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }

      output += chunk.toString();
    };

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => finish(error));
    child.on('close', (status) => {
      if (overflow) {
        finish(setupError('ANDROID_PROCESS_OUTPUT_LIMIT', `${command} produced too much output.`));
      } else if (status !== 0) {
        finish(
          setupError('ANDROID_COMMAND_FAILED', `${command} exited with status ${status}.`, {
            command,
            args,
            status,
            output,
          }),
        );
      } else {
        finish(undefined, { output, status });
      }
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(
        setupError('ANDROID_COMMAND_TIMEOUT', `${command} exceeded its time limit.`, {
          command,
          args,
          output,
        }),
      );
    }, options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);

    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

/** Fetch a response through a bounded chain of HTTPS redirects on approved hosts. */
async function fetchUpstream(url, allowedHosts, fetchImpl, signal) {
  let current = new URL(url);

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    if (current.protocol !== 'https:' || !allowedHosts.has(current.hostname)) {
      throw setupError(
        'ANDROID_UNTRUSTED_SOURCE',
        `Refusing unapproved source: ${current.hostname}.`,
      );
    }

    const response = await fetchImpl(current, { redirect: 'manual', signal });

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    if (hop === MAX_REDIRECT_HOPS) {
      throw setupError(
        'ANDROID_TOO_MANY_REDIRECTS',
        'The Android download exceeded five redirects.',
      );
    }

    const location = response.headers.get('location');

    if (!location) {
      throw setupError(
        'ANDROID_DOWNLOAD_REDIRECT_INVALID',
        'The Android download returned an empty redirect.',
      );
    }

    current = new URL(location, current);
  }

  throw setupError('ANDROID_TOO_MANY_REDIRECTS', 'The Android download exceeded five redirects.');
}

/** Read metadata incrementally and stop as soon as the byte limit is reached. */
async function readTextBounded(response, maxBytes) {
  if (!response.body) {
    throw setupError('ANDROID_METADATA_EMPTY', 'The Android tool metadata response was empty.');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let byteCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      byteCount += value.byteLength;

      if (byteCount > maxBytes) {
        await reader.cancel();
        throw setupError(
          'ANDROID_METADATA_TOO_LARGE',
          'Android tool metadata exceeded the size limit.',
        );
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteCount);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

/** Fetch bounded upstream metadata while rejecting unsafe URL hosts and redirects. */
async function fetchText(url, allowedHosts, fetchImpl) {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = await fetchUpstream(url, allowedHosts, fetchImpl, signal);

  if (!response.ok) {
    throw setupError(
      'ANDROID_DOWNLOAD_FAILED',
      `Metadata request returned HTTP ${response.status}.`,
    );
  }

  const contentLength = Number(response.headers.get('content-length') ?? '0');

  if (contentLength > MAX_METADATA_BYTES) {
    throw setupError(
      'ANDROID_METADATA_TOO_LARGE',
      'Android tool metadata exceeded the size limit.',
    );
  }

  return readTextBounded(response, MAX_METADATA_BYTES);
}

/** Download an upstream archive under a size/time cap and verify its SHA-256. */
async function downloadVerified(url, expectedSha256, destination, maxBytes, fetchImpl) {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = await fetchUpstream(url, ALLOWED_DOWNLOAD_HOSTS, fetchImpl, signal);

  if (!response.ok || !response.body) {
    throw setupError(
      'ANDROID_DOWNLOAD_FAILED',
      `Archive request returned HTTP ${response.status}.`,
    );
  }

  const announcedSize = Number(response.headers.get('content-length') ?? '0');

  if (announcedSize > maxBytes) {
    throw setupError(
      'ANDROID_DOWNLOAD_TOO_LARGE',
      'The Android tool archive exceeded the size limit.',
    );
  }

  const hash = createHash('sha256');
  let byteCount = 0;
  const meter = new TransformStream({
    transform(chunk, controller) {
      byteCount += chunk.byteLength;

      if (byteCount > maxBytes) {
        throw setupError(
          'ANDROID_DOWNLOAD_TOO_LARGE',
          'The Android tool archive exceeded the size limit.',
        );
      }

      hash.update(chunk);
      controller.enqueue(chunk);
    },
  });

  await pipeline(response.body, meter, createWriteStream(destination));

  if (hash.digest('hex') !== expectedSha256.toLowerCase()) {
    await rm(destination, { force: true });
    throw setupError(
      'ANDROID_CHECKSUM_MISMATCH',
      'The downloaded tool archive failed its SHA-256 check.',
    );
  }
}

/** Map supported Node host combinations to official JDK and Android archives. */
function hostPlatform(platform, arch) {
  if (platform === 'win32') {
    throw setupError(
      'ANDROID_HOST_UNSUPPORTED',
      'PhoneUse onboarding currently supports macOS and Linux. Windows setup is not available yet.',
    );
  }

  const osName = platform === 'darwin' ? 'mac' : platform === 'linux' ? 'linux' : undefined;
  const architecture = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x64' : undefined;

  if (!osName || !architecture) {
    throw setupError(
      'ANDROID_HOST_UNSUPPORTED',
      `Unsupported Android build host: ${platform}/${arch}.`,
    );
  }

  return { osName, architecture };
}

/** Retrieve the latest Eclipse Temurin 17 archive and its upstream SHA-256. */
async function getJdkArchive(host, fetchImpl) {
  const query = new URLSearchParams({
    architecture: host.architecture,
    heap_size: 'normal',
    image_type: 'jdk',
    jvm_impl: 'hotspot',
    os: host.osName,
    vendor: 'eclipse',
  });
  const metadata = await fetchText(
    `https://api.adoptium.net/v3/assets/latest/17/hotspot?${query}`,
    ALLOWED_METADATA_HOSTS,
    fetchImpl,
  );
  const [asset] = JSON.parse(metadata);
  const pkg = asset?.binary?.package;

  if (!pkg?.link || !/^[a-f\d]{64}$/i.test(pkg.checksum ?? '')) {
    throw setupError(
      'ANDROID_JDK_METADATA_INVALID',
      'Eclipse Temurin returned incomplete JDK metadata.',
    );
  }

  const source = new URL(pkg.link);

  if (!ALLOWED_DOWNLOAD_HOSTS.has(source.hostname)) {
    throw setupError('ANDROID_UNTRUSTED_SOURCE', `Refusing JDK source host ${source.hostname}.`);
  }

  return { url: pkg.link, sha256: pkg.checksum, name: pkg.name };
}

/** Read a named XML field from one Android SDK package block. */
function xmlField(block, field) {
  const match = block.match(new RegExp(`<${field}>([^<]+)</${field}>`));

  return match?.[1];
}

/** Find official command-line tool archive metadata for this host in Google's repository. */
async function getAndroidToolsArchive(host, fetchImpl) {
  const xml = await fetchText(
    'https://dl.google.com/android/repository/repository2-1.xml',
    ALLOWED_METADATA_HOSTS,
    fetchImpl,
  );
  const packages = [
    ...xml.matchAll(/<remotePackage path="cmdline-tools;([^"]+)">([\s\S]*?)<\/remotePackage>/g),
  ];
  const candidates = packages
    .filter(([, version, block]) => /^\d+(?:\.\d+)*$/.test(version) && block.includes('channel-0'))
    .sort((left, right) => right[1].localeCompare(left[1], undefined, { numeric: true }));

  for (const [, , block] of candidates) {
    for (const archiveBlock of block.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
      const archive = archiveBlock[1];
      const hostOs = xmlField(archive, 'host-os');
      const hostArch = xmlField(archive, 'host-arch');
      const url = xmlField(archive, 'url');
      const sha1 = xmlField(archive, 'checksum');
      const size = Number(xmlField(archive, 'size'));
      const expectedOs = host.osName === 'mac' ? 'macosx' : 'linux';
      const isX64Archive =
        host.architecture === 'x64' &&
        ((host.osName === 'linux' && url?.startsWith('commandlinetools-linux-')) ||
          (host.osName === 'mac' && url?.includes('mac_x86_64-')));

      if (hostOs === expectedOs && (hostArch === host.architecture || isX64Archive)) {
        if (!url || !/^[a-f\d]{40}$/i.test(sha1 ?? '') || size > MAX_ANDROID_TOOLS_DOWNLOAD) {
          continue;
        }

        return {
          url: `https://dl.google.com/android/repository/${url}`,
          sha1,
          size,
          fallback: false,
        };
      }
    }
  }

  if (host.osName === 'mac' && host.architecture === 'aarch64') {
    return getAndroidArmArchiveFromOfficialPage(fetchImpl);
  }

  throw setupError(
    'ANDROID_TOOLS_METADATA_MISSING',
    'Google SDK metadata has no archive for this host.',
  );
}

/** Resolve Google's macOS ARM archive and SHA-256 from the official Android downloads page. */
async function getAndroidArmArchiveFromOfficialPage(fetchImpl) {
  const page = await fetchText(
    'https://developer.android.com/studio?hl=en',
    ALLOWED_METADATA_HOSTS,
    fetchImpl,
  );
  const filename = page.match(/commandlinetools-mac_arm64-(\d+)_latest\.zip/)?.[0];

  if (!filename) {
    throw setupError(
      'ANDROID_TOOLS_METADATA_MISSING',
      'Google has no listed macOS ARM command-line archive.',
    );
  }

  const row = [...page.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].find((match) =>
    match[0].includes(filename),
  )?.[0];
  const checksum = row?.match(/\b([a-f\d]{64})\b/i)?.[1];

  if (!checksum) {
    throw setupError(
      'ANDROID_TOOLS_METADATA_INVALID',
      'Google did not publish an archive SHA-256 in its download page.',
    );
  }

  return {
    url: `https://dl.google.com/android/repository/${filename}`,
    sha256: checksum,
    fallback: true,
  };
}

/** Find a usable JDK 17 already installed on the machine. */
async function findExistingJdk(repositoryRoot, run, platform) {
  const candidates = [
    process.env.JAVA_HOME,
    '/usr/lib/jvm/java-17-openjdk',
    '/usr/lib/jvm/default-java',
    '/opt/java/openjdk',
  ].filter(Boolean);

  if (platform === 'darwin') {
    try {
      const result = await run('/usr/libexec/java_home', ['-v', '17'], { timeoutMs: 10_000 });
      candidates.unshift(result.output.trim());
    } catch {
      // The bundled JDK path below is used when macOS has no system JDK 17.
    }
  }

  candidates.push(join(repositoryRoot, 'artifacts/toolchain/jdk'));

  for (const candidate of [...new Set(candidates)]) {
    const executable = join(candidate, 'bin', platform === 'win32' ? 'java.exe' : 'java');

    try {
      await access(executable);
      const result = await run(executable, ['-version'], { timeoutMs: 10_000 });

      if (/version "17(?:[." ]|$)|openjdk 17(?:[ .]|$)/i.test(result.output)) {
        return resolve(candidate);
      }
    } catch {
      // Continue through common JDK locations, then install into the local toolchain.
    }
  }

  return undefined;
}

/** Prefer a complete SDK already configured by Android Studio or an existing environment. */
async function findExistingSdk(repositoryRoot, platform) {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    platform === 'darwin' ? join(homedir(), 'Library/Android/sdk') : undefined,
    platform === 'linux' ? join(homedir(), 'Android/Sdk') : undefined,
    join(repositoryRoot, 'artifacts/toolchain/android-sdk'),
  ].filter(Boolean);

  for (const candidate of [...new Set(candidates)]) {
    try {
      await Promise.all([
        access(join(candidate, 'platforms/android-36/android.jar')),
        access(join(candidate, 'build-tools/36.0.0')),
        access(join(candidate, 'platform-tools/adb')),
      ]);

      return resolve(candidate);
    } catch {
      // Incomplete SDKs are still candidates for package installation below.
    }
  }

  return undefined;
}

/** Safely unpack a checked upstream archive into a fresh destination directory. */
async function extractArchive(archivePath, targetDirectory, isZip, run) {
  await mkdir(targetDirectory, { recursive: true });
  const command = isZip ? 'unzip' : 'tar';
  const args = isZip
    ? ['-q', archivePath, '-d', targetDirectory]
    : ['-xzf', archivePath, '-C', targetDirectory, '--no-same-owner'];

  await run(command, args, { timeoutMs: 180_000 });
}

/** Install or reuse private build tools and return JAVA_HOME plus ANDROID_HOME. */
export async function prepareAndroid({
  repositoryRoot,
  print = () => {},
  acceptAndroidLicenses = false,
  run = runProcess,
  fetchImpl = fetch,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (!repositoryRoot) {
    throw new TypeError('repositoryRoot is required.');
  }

  const root = resolve(repositoryRoot);
  const host = hostPlatform(platform, arch);
  const toolchain = join(root, 'artifacts/toolchain');
  const jdkHome = join(toolchain, 'jdk');
  const sdkHome = join(toolchain, 'android-sdk');
  await mkdir(toolchain, { recursive: true });

  let javaHome = await findExistingJdk(root, run, platform);

  if (!javaHome) {
    print('Downloading Eclipse Temurin JDK 17 into artifacts/toolchain…');
    const asset = await getJdkArchive(host, fetchImpl);
    const archivePath = join(toolchain, basename(asset.name));
    const staging = await mkdtemp(join(toolchain, 'jdk-unpack-'));

    try {
      await downloadVerified(asset.url, asset.sha256, archivePath, MAX_JDK_DOWNLOAD, fetchImpl);
      await extractArchive(archivePath, staging, false, run);
      const extracted = await readdir(staging);
      const extractedRoot = extracted.length > 0 ? join(staging, extracted[0]) : undefined;
      const nestedMacHome = extractedRoot ? join(extractedRoot, 'Contents/Home') : undefined;
      const home =
        nestedMacHome && (await pathExists(join(nestedMacHome, 'bin/java')))
          ? nestedMacHome
          : extractedRoot;

      if (
        !home ||
        !(await stat(home)).isDirectory() ||
        !(await pathExists(join(home, 'bin/java')))
      ) {
        throw setupError(
          'ANDROID_JDK_ARCHIVE_INVALID',
          'The verified Temurin JDK archive has no root directory.',
        );
      }

      await rm(jdkHome, { recursive: true, force: true });
      await rename(home, jdkHome);
      javaHome = jdkHome;
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(archivePath, { force: true });
    }
  }

  let androidHome = await findExistingSdk(root, platform);

  if (!androidHome) {
    androidHome = sdkHome;
    const sdkmanagerPath = join(androidHome, 'cmdline-tools/latest/bin/sdkmanager');

    try {
      await access(sdkmanagerPath);
    } catch {
      print('Downloading Android SDK command-line tools into artifacts/toolchain…');
      const archive = await getAndroidToolsArchive(host, fetchImpl);
      const archivePath = join(toolchain, basename(archive.url));
      const staging = await mkdtemp(join(toolchain, 'sdk-unpack-'));

      try {
        if (archive.sha256) {
          await downloadVerified(
            archive.url,
            archive.sha256,
            archivePath,
            MAX_ANDROID_TOOLS_DOWNLOAD,
            fetchImpl,
          );
        } else {
          await downloadVerifiedSha1(
            archive.url,
            archive.sha1,
            archivePath,
            Math.min(archive.size ?? MAX_ANDROID_TOOLS_DOWNLOAD, MAX_ANDROID_TOOLS_DOWNLOAD),
            fetchImpl,
          );
        }

        await extractArchive(archivePath, staging, true, run);
        const extractedToolPath = join(staging, 'cmdline-tools');
        await access(join(extractedToolPath, 'bin/sdkmanager'));
        const latest = join(androidHome, 'cmdline-tools/latest');
        await mkdir(dirname(latest), { recursive: true });
        await rm(latest, { recursive: true, force: true });
        await rename(extractedToolPath, latest);
        await chmod(join(latest, 'bin/sdkmanager'), 0o755);
      } finally {
        await rm(staging, { recursive: true, force: true });
        await rm(archivePath, { force: true });
      }
    }

    await mkdir(androidHome, { recursive: true });
    const sdkmanager = join(androidHome, 'cmdline-tools/latest/bin/sdkmanager');
    const managerArgs = [`--sdk_root=${androidHome}`];
    const childEnv = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: androidHome };

    if (acceptAndroidLicenses) {
      print('Accepting the Android SDK licenses as explicitly requested…');

      try {
        await run(sdkmanager, [...managerArgs, '--licenses'], {
          env: childEnv,
          input: `${'y\n'.repeat(20)}`,
          timeoutMs: SDK_MANAGER_TIMEOUT_MS,
        });
      } catch (error) {
        throw setupError('ANDROID_LICENSE_ACCEPTANCE_FAILED', error.message, { cause: error });
      }
    }

    print('Installing Android SDK 36 and build tools…');

    try {
      await run(
        sdkmanager,
        [
          ...managerArgs,
          '--install',
          'platform-tools',
          'platforms;android-36',
          'build-tools;36.0.0',
        ],
        { env: childEnv, timeoutMs: SDK_MANAGER_TIMEOUT_MS },
      );
    } catch (error) {
      if (/licen[cs]e|not accepted|accept.*terms/i.test(error.output ?? error.message)) {
        const recoveryCommand =
          `JAVA_HOME=${shellQuote(javaHome)} ${shellQuote(sdkmanager)} ` +
          `--sdk_root=${shellQuote(androidHome)} --licenses`;
        throw setupError(
          'ANDROID_LICENSE_REQUIRED',
          `Android SDK licenses need your approval. Run: ${recoveryCommand}, then rerun onboarding.`,
          { sdkmanager, recoveryCommand, cause: error },
        );
      }

      throw error;
    }

    try {
      await Promise.all([
        access(join(androidHome, 'platforms/android-36/android.jar')),
        access(join(androidHome, 'build-tools/36.0.0')),
        access(join(androidHome, 'platform-tools/adb')),
      ]);
    } catch {
      throw setupError(
        'ANDROID_SDK_INSTALL_INCOMPLETE',
        'sdkmanager completed without all required SDK 36 packages.',
      );
    }
  }

  return { JAVA_HOME: javaHome, ANDROID_HOME: androidHome };
}

/** Download Google SDK tools while verifying the SHA-1 checksum published by its repository XML. */
async function downloadVerifiedSha1(url, expectedSha1, destination, maxBytes, fetchImpl) {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = await fetchUpstream(url, new Set(['dl.google.com']), fetchImpl, signal);

  if (!response.ok || !response.body) {
    throw setupError(
      'ANDROID_DOWNLOAD_FAILED',
      `Archive request returned HTTP ${response.status}.`,
    );
  }

  const announcedSize = Number(response.headers.get('content-length') ?? '0');

  if (announcedSize > maxBytes) {
    throw setupError(
      'ANDROID_DOWNLOAD_TOO_LARGE',
      'The Android tools archive exceeded the size limit.',
    );
  }

  const hash = createHash('sha1');
  let byteCount = 0;
  const meter = new TransformStream({
    transform(chunk, controller) {
      byteCount += chunk.byteLength;

      if (byteCount > maxBytes) {
        throw setupError(
          'ANDROID_DOWNLOAD_TOO_LARGE',
          'The Android tools archive exceeded the size limit.',
        );
      }

      hash.update(chunk);
      controller.enqueue(chunk);
    },
  });

  await pipeline(response.body, meter, createWriteStream(destination));

  if (hash.digest('hex') !== expectedSha1.toLowerCase()) {
    await rm(destination, { force: true });
    throw setupError(
      'ANDROID_CHECKSUM_MISMATCH',
      'The downloaded tools archive failed its upstream SHA-1 check.',
    );
  }
}

/** Run the bootstrap from the command line and emit only the environment paths as JSON. */
async function main() {
  const acceptAndroidLicenses = process.argv.includes('--accept-android-licenses');
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  try {
    const env = await prepareAndroid({
      repositoryRoot,
      acceptAndroidLicenses,
      print: (message) => process.stderr.write(`${message}\n`),
    });
    process.stdout.write(`${JSON.stringify(env)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: error.message, code: error.code ?? 'ANDROID_SETUP_FAILED' })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
