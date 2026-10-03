/** Owns private bridge state, credentials, and the self-signed TLS identity used to pin the phone connection. */
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

/** Persistent credentials and TLS paths used by the bridge and local clients. */
export interface BridgeState {
  stateDir: string;
  statePath: string;
  phoneToken: string;
  adminToken: string;
  csrfToken: string;
  certPath: string;
  keyPath: string;
  fingerprint: string;
}

interface StateFile {
  version: 1;
  phoneToken: string;
  adminToken: string;
  csrfToken: string;
}

/** Create or load credentials, certificate and fingerprint inside an explicit private state directory. */
export async function ensureState(stateDir: string): Promise<BridgeState> {
  const directory = join(stateDir);
  const statePath = join(directory, "state.json");
  const certPath = join(directory, "phoneuse-cert.pem");
  const keyPath = join(directory, "phoneuse-key.pem");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  let saved: StateFile;
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (!isStateFile(parsed)) throw new Error("Invalid PhoneUse state file");
    saved = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    saved = {
      version: 1,
      phoneToken: randomBytes(32).toString("hex"),
      adminToken: randomBytes(32).toString("hex"),
      csrfToken: randomBytes(32).toString("hex"),
    };
    await writeFile(statePath, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
  await chmod(statePath, 0o600);

  try {
    await Promise.all([readFile(certPath), readFile(keyPath)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await generateCertificate(certPath, keyPath);
  }
  await Promise.all([chmod(certPath, 0o600), chmod(keyPath, 0o600)]);
  const certPem = await readFile(certPath, "utf8");
  const der = pemCertificateToDer(certPem);
  const fingerprint = createHash("sha256").update(der).digest("hex");
  return { stateDir: directory, statePath, ...saved, certPath, keyPath, fingerprint };
}

/** Validate the small credential file before trusting it. */
function isStateFile(value: unknown): value is StateFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return state.version === 1 && ["phoneToken", "adminToken", "csrfToken"].every(
    (key) => typeof state[key] === "string" && /^[a-f0-9]{64}$/.test(state[key] as string),
  );
}

/** Generate a long-lived local identity; Android trusts it only by the paired SHA-256 fingerprint. */
function generateCertificate(certPath: string, keyPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-keyout", keyPath,
      "-out", certPath, "-days", "3650", "-subj", "/CN=PhoneUse Desktop Bridge"], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`openssl exited with status ${code ?? "unknown"}`)));
  });
}

/** Decode the leaf certificate PEM for the exact DER fingerprint Android pins. */
function pemCertificateToDer(pem: string): Buffer {
  const match = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
  if (!match) throw new Error("TLS certificate file does not contain a PEM certificate");
  return Buffer.from(match[1]!.replace(/\s/g, ""), "base64");
}
