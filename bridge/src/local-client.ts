/** Provides authenticated HTTP access for the CLI and MCP process without exposing phone credentials to callers. */
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Per-request overrides useful for embedding clients and integration tests. */
export interface LocalRequestOptions {
  stateDir?: string;
  adminPort?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Call the local bridge API with the admin token loaded from its private state file. */
export async function requestLocal(path: string, body?: unknown, options: LocalRequestOptions = {}): Promise<unknown> {
  if (!/^\/(?:api\/(?:status|pairing|command|disconnect))$/.test(path)) throw new Error("Unsupported local API path");
  const stateDir = options.stateDir ?? process.env.PHONEUSE_STATE_DIR ?? defaultStateDir();
  const port = options.adminPort ?? numberFromEnv(process.env.PHONEUSE_ADMIN_PORT, 8766);
  const timeoutMs = options.timeoutMs ?? 35_000;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error("Invalid local request options");
  const state: unknown = JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"));
  if (!isState(state)) throw new Error("PhoneUse state file is invalid; restart the bridge to repair it.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${state.adminToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const parsed: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : {};
      const result = new Error(typeof error.message === "string" ? error.message : `Local bridge returned HTTP ${response.status}`) as Error & { code?: string; status?: number };
      result.code = typeof error.code === "string" ? error.code : "LOCAL_API_ERROR";
      result.status = response.status;
      throw result;
    }
    return parsed;
  } catch (error) {
    if (controller.signal.aborted) throw Object.assign(new Error("Local bridge request timed out."), { code: "LOCAL_TIMEOUT" });
    throw error;
  } finally { clearTimeout(timer); }
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return Number.NaN;
  return Number(value);
}
/** Find the workspace state directory from this package's installed runtime location. */
function defaultStateDir(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (isObject(parsed) && parsed.name === "@phoneuse/bridge") return resolve(directory, "..", ".phoneuse");
    } catch { /* Continue toward the package parent; missing package metadata is expected. */ }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return resolve(process.cwd(), ".phoneuse");
}
/** Narrow unknown values before reading small state/API records. */
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isState(value: unknown): value is { adminToken: string } { return isObject(value) && typeof value.adminToken === "string" && /^[a-f0-9]{64}$/.test(value.adminToken); }
