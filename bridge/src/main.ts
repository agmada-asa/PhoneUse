/** Starts the LAN bridge and provides local setup, diagnostics, and manual commands. */
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createBridge } from './bridge.js';
import { requestLocal } from './local-client.js';

/** Repository root stays stable when Codex starts this executable from another directory. */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
/** Secrets and TLS files are local, ignored, and never printed by normal startup. */
const stateDir = process.env.PHONEUSE_STATE_DIR ?? resolve(repositoryRoot, '.phoneuse');

/** Chooses a private IPv4 LAN address, preferring a Mac's primary interface. */
function lanAddress(): string {
  const interfaces = networkInterfaces();
  const names = Object.keys(interfaces).sort((a, b) => Number(b === 'en0') - Number(a === 'en0'));
  for (const name of names) {
    for (const item of interfaces[name] ?? []) {
      if (!item.internal && item.family === 'IPv4' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)) return item.address;
    }
  }
  return '127.0.0.1';
}

/** Reads a flag's value and rejects missing values instead of guessing. */
function flag(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Provide a value for ${name}.`);
  return value;
}

/** Validates a TCP port used by the command-line server. */
function port(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error('Port must be an integer between 1 and 65535.');
  return parsed;
}

/** Runs read-only checks without generating secrets or changing the phone. */
async function doctor(): Promise<void> {
  console.log(`Node ${process.version} ${Number(process.versions.node.split('.')[0]) >= 22 ? 'OK' : 'requires 22 or later'}`);
  try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); console.log('OpenSSL OK'); }
  catch { console.log('OpenSSL missing. Install it before starting the bridge.'); }
  const address = process.env.PHONEUSE_ADVERTISE_HOST ?? lanAddress();
  console.log(`LAN address: ${address}${address === '127.0.0.1' ? ' (connect to Wi-Fi or set PHONEUSE_ADVERTISE_HOST)' : ''}`);
  try { await access(resolve(repositoryRoot, 'artifacts/PhoneUse-debug.apk'), constants.R_OK); console.log('Android APK ready in artifacts/PhoneUse-debug.apk'); }
  catch { console.log('Android APK not built. Run npm run android:build.'); }
  try { const status = await requestLocal('/api/status', undefined, { stateDir, timeoutMs: 1500 }); console.log(`Bridge running: ${JSON.stringify(status)}`); }
  catch { console.log('Bridge not running. Run npm start.'); }
}

/** Dispatches CLI commands, keeping screenshot payloads out of terminal logs. */
async function main(): Promise<void> {
  const [command = 'start', ...args] = process.argv.slice(2);
  if (command === 'start') {
    const allowed = new Set(['--host', '--advertise', '--phone-port', '--admin-port']);
    for (let index = 0; index < args.length; index += 2) {
      if (!allowed.has(args[index] ?? '')) throw new Error(`Unknown start option: ${args[index]}`);
      if (!args[index + 1]) throw new Error(`Missing value for ${args[index]}`);
    }
    const phonePort = port(flag(args, '--phone-port', process.env.PHONEUSE_PHONE_PORT ?? '8765'));
    const adminPort = port(flag(args, '--admin-port', process.env.PHONEUSE_ADMIN_PORT ?? '8766'));
    const advertisedHost = flag(args, '--advertise', process.env.PHONEUSE_ADVERTISE_HOST ?? lanAddress());
    const server = await createBridge({ stateDir, host: flag(args, '--host', '0.0.0.0'), advertisedHost, phonePort, adminPort, publicDir: resolve(repositoryRoot, 'bridge/public') });
    console.log(`PhoneUse console: http://127.0.0.1:${adminPort}`);
    console.log(`Phone connection: wss://${advertisedHost}:${phonePort}/phone`);
    console.log('Open the console to show your private pairing QR code. Press Ctrl+C to stop.');
    if (advertisedHost === '127.0.0.1') console.log('No LAN address found. Restart with --advertise <computer Wi-Fi IP>.');
    let stopping = false;
    /** Closes both servers once and returns control to the terminal. */
    const stop = async (): Promise<void> => { if (stopping) return; stopping = true; await server.close(); };
    process.once('SIGINT', () => { void stop(); });
    process.once('SIGTERM', () => { void stop(); });
    return;
  }
  if (command === 'doctor') { await doctor(); return; }
  if (command === 'status') { console.log(JSON.stringify(await requestLocal('/api/status', undefined, { stateDir }), null, 2)); return; }
  if (command === 'pair') {
    const result = await requestLocal('/api/pairing', undefined, { stateDir }) as { code: string };
    console.log('Private pairing code. Only paste this into your PhoneUse companion:');
    console.log(result.code);
    return;
  }
  if (command === 'disconnect') { console.log(JSON.stringify(await requestLocal('/api/disconnect', {}, { stateDir }), null, 2)); return; }
  if (command === 'command') {
    const [method, json = '{}'] = args;
    if (!method || args.length > 2) throw new Error('Usage: npm run command -- <method> \'{"parameter":"value"}\'');
    const envelope = await requestLocal('/api/command', { method, params: JSON.parse(json) }, { stateDir }) as { result: Record<string, unknown> };
    const result = envelope.result;
    if (method === 'screenshot' && typeof result.data === 'string') {
      await mkdir(resolve(repositoryRoot, 'artifacts'), { recursive: true });
      const output = resolve(repositoryRoot, 'artifacts/screenshot.png');
      await writeFile(output, Buffer.from(result.data, 'base64'));
      console.log(`Screenshot saved to ${output}`);
    } else console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error('Commands: start, doctor, pair, status, command, disconnect.');
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'PhoneUse failed.'); process.exitCode = 1; });
