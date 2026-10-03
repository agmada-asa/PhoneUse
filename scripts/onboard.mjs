#!/usr/bin/env node
/** Bootstraps desktop dependencies, prepares the Android APK, and hands off a running local console. */
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, open, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Checkout-based paths work when an installed skill invokes onboarding from another directory. */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Resolves explicit host and APK choices before doing any installation or starting a listener. */
export function parseOnboardingOptions(args) {
  const options = { codex: false, skill: false, acceptAndroidLicenses: false, help: false };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--codex') {
      options.codex = true;
    } else if (argument === '--skill') {
      options.skill = true;
    } else if (argument === '--accept-android-licenses') {
      options.acceptAndroidLicenses = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--apk' || argument === '--skill-dir') {
      const value = args[++index];

      if (!value || value.startsWith('--')) {
        throw new Error(`Provide a path after ${argument}.`);
      }

      options[argument === '--apk' ? 'apk' : 'skillDir'] = resolve(value);
    } else {
      throw new Error(`Unknown onboarding option: ${argument}`);
    }
  }

  if (options.codex && options.skill) {
    throw new Error('Choose --codex or --skill for the MCP host setup.');
  }

  // A host-neutral run installs operating guidance and prints the MCP configuration for its agent.
  if (!options.codex) {
    options.skill = true;
  }

  return options;
}

/** Runs a bounded prerequisite/build command without a shell or dumping potentially private buffers. */
function run(command, args, env, timeoutMs = 600_000) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env,
    stdio: 'inherit',
    timeout: timeoutMs,
  });

  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.slice(0, 2).join(' ')} did not finish successfully. Resolve the error above and run onboarding again.`,
    );
  }
}

/** Accepts only a bounded ZIP package containing the standard APK manifest; it never extracts supplied files. */
export async function validateApk(path) {
  const info = await stat(path);

  if (!info.isFile() || info.size < 4 || info.size > 100 * 1024 * 1024) {
    throw new Error('The APK must be a file between 4 bytes and 100 MiB.');
  }

  const file = await open(path, 'r');

  try {
    const signature = Buffer.alloc(4);
    await file.read(signature, 0, 4, 0);

    if (!signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      throw new Error('The supplied file is not an APK ZIP archive.');
    }
  } finally {
    await file.close();
  }

  const listing = spawnSync('unzip', ['-Z1', path], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (listing.error?.code === 'ENOENT') {
    throw new Error('Install unzip so onboarding can verify the Android APK.');
  }

  if (listing.status !== 0 || !listing.stdout?.split(/\r?\n/).includes('AndroidManifest.xml')) {
    throw new Error('The APK could not be read or does not contain an Android manifest.');
  }
}

/** Starts a detached bridge and waits for authenticated readiness; failure only stops the newly spawned child. */
export function startOnboardingBridge(root, env, agentConfigured) {
  return new Promise((resolve, reject) => {
    const args = [join(root, 'bridge/dist/src/onboarding-bridge.js')];

    if (agentConfigured) {
      args.push('--agent-configured');
    }

    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errorOutput = '';
    let settled = false;

    /** Releases the setup process's pipe handles only after readiness or failure. */
    const cleanup = () => {
      clearTimeout(timer);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onInterrupt);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };

    /** Bounds startup and preserves any existing bridge which the child might have reused. */
    const fail = (message) => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill('SIGTERM');
      cleanup();
      reject(new Error(message));
    };

    /** Interrupting setup before readiness cancels only its own pending bridge startup. */
    const onInterrupt = () => fail('Onboarding was interrupted before the console was ready.');
    const timer = setTimeout(
      () =>
        fail(
          'The PhoneUse console did not start within 15 seconds. Check for a port conflict and run onboarding again.',
        ),
      15_000,
    );
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    child.once('error', () => fail('Could not start the PhoneUse bridge process.'));
    child.stderr.on('data', (data) => {
      errorOutput = (errorOutput + data.toString()).slice(-4096);
    });
    child.stdout.on('data', (data) => {
      output += data.toString();

      if (output.length > 4096) {
        fail('The PhoneUse bridge returned an invalid readiness record.');
      }
    });
    child.stdout.once('end', () => {
      if (settled) {
        return;
      }

      try {
        const ready = JSON.parse(output);
        const url = new URL(ready.consoleUrl);

        if (
          url.protocol !== 'http:' ||
          url.hostname !== '127.0.0.1' ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash ||
          typeof ready.bridgeStarted !== 'boolean'
        ) {
          throw new Error('Invalid console address');
        }

        settled = true;
        cleanup();
        resolve(ready);
      } catch {
        fail(errorOutput.trim() || 'PhoneUse did not provide a valid console address.');
      }
    });
    child.once('exit', (code) => {
      if (!settled && code !== 0) {
        fail(errorOutput.trim() || 'The PhoneUse bridge exited before it was ready.');
      }
    });
  });
}

/** Creates the APK and runtime, installs the requested host integration, and prints the user's next steps. */
export async function onboard(args = process.argv.slice(2)) {
  const options = parseOnboardingOptions(args);

  if (options.help) {
    console.log(
      `PhoneUse onboarding\n\n  npm run onboard -- --codex                 Prepare APK, skill, MCP, and console\n  npm run onboard -- --skill                 Prepare APK and console for another MCP host\n  npm run onboard -- --codex --apk PATH      Use a trusted local APK instead of building\n  npm run onboard -- --accept-android-licenses  Accept SDK licenses after reviewing their terms\n\nOptional --skill-dir DIR chooses the parent skill directory.\nRequires Node 22+, npm, OpenSSL, unzip, tar, and bash. Missing Android build tools are installed locally.\nNo phone app is installed and no phone control is enabled automatically.`,
    );
    return;
  }

  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('Install Node 22 or later, then run PhoneUse onboarding again.');
  }

  await rm(join(repositoryRoot, 'artifacts/onboarding.json'), { force: true });
  const { preflightSetup } = await import('./setup.mjs');
  const { plan } = await preflightSetup(options);

  if (process.platform === 'win32') {
    throw new Error(
      'Run PhoneUse onboarding in WSL on Windows. Native Windows onboarding is not supported.',
    );
  }

  for (const [command, args] of [
    ['openssl', ['version']],
    ['unzip', ['-v']],
    ['tar', ['--version']],
    ['bash', ['--version']],
  ]) {
    const check = spawnSync(command, args, { stdio: 'ignore', timeout: 10_000 });

    if (check.error || check.status !== 0) {
      throw new Error(`Install ${command}, then run PhoneUse onboarding again.`);
    }
  }

  if (options.apk) {
    await validateApk(options.apk);
  }

  console.log('Preparing the desktop tools.');
  run('npm', ['ci'], process.env);
  run('npm', ['run', 'build'], process.env);
  const apkPath = join(repositoryRoot, 'artifacts/PhoneUse-debug.apk');
  await mkdir(dirname(apkPath), { recursive: true });

  if (options.apk) {
    const existingPath = await realpath(apkPath).catch(() => undefined);

    if ((await realpath(options.apk)) !== existingPath) {
      await cp(options.apk, apkPath);
    }
  } else {
    console.log('Preparing the Android app.');
    const { prepareAndroid } = await import('./prepare-android.mjs');
    const androidEnv = await prepareAndroid({
      repositoryRoot,
      acceptAndroidLicenses: options.acceptAndroidLicenses,
      print: console.log,
    });
    run(
      'bash',
      [join(repositoryRoot, 'scripts/build-android.sh')],
      { ...process.env, ...androidEnv },
      1_200_000,
    );
    await validateApk(apkPath);
  }

  const setupArgs = [
    join(repositoryRoot, 'scripts/setup.mjs'),
    options.codex ? '--codex' : '--skill',
  ];

  if (options.skillDir) {
    setupArgs.push('--skill-dir', options.skillDir);
  }

  run(process.execPath, setupArgs, process.env, 30_000);
  const ready = await startOnboardingBridge(repositoryRoot, process.env, options.codex);
  const result = { apkPath, ...ready, mcpServers: plan.mcpServers };
  await writeFile(
    join(repositoryRoot, 'artifacts/onboarding.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(
    `\nAPK ready: ${apkPath}\nConsole ready: ${ready.consoleUrl}\n\nInstall the APK on your Android phone, then use the console to pair.\nOn the phone, enable accessibility, choose protected apps, and allow control.\nOpen a new agent session to load the phone tools.\nStop the desktop bridge with npm run stop.`,
  );

  if (plan.mcpServers.phoneuse.env) {
    console.log(
      'Use the same PHONEUSE_* environment overrides when running npm run stop. They are saved in the MCP configuration.',
    );
  }

  if (!ready.bridgeStarted) {
    console.log(
      'Reused the running bridge. Its lifetime remains controlled by the terminal, onboarding command, or MCP session that started it.',
    );
  }

  if (!options.codex) {
    console.log(
      `\nMCP configuration for your agent:\n${JSON.stringify({ mcpServers: result.mcpServers }, null, 2)}`,
    );
  }

  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  onboard().catch((error) => {
    console.error(error instanceof Error ? error.message : 'PhoneUse onboarding failed.');
    process.exitCode = 1;
  });
}
