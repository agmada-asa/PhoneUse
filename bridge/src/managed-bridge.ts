/** Starts a session-owned bridge or reuses an authenticated one, serializing first-time identity creation. */
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBridge, type CreateBridgeOptions } from "./bridge.js";
import { requestLocal } from "./local-client.js";

/** Reused bridges remain running when this MCP session closes. */
export interface ManagedBridge {
  owned: boolean;
  consoleUrl: string;
  close(): Promise<void>;
}

/** Authenticates readiness without observing the phone or returning pairing material. */
async function isRunning(options: CreateBridgeOptions, signal?: AbortSignal): Promise<boolean> {
  try {
    const result = await requestLocal("/api/status", undefined, {
      stateDir: options.stateDir,
      adminPort: options.adminPort,
      timeoutMs: 1000,
      signal,
    });

    if (
      typeof result !== "object" ||
      result === null ||
      typeof (result as Record<string, unknown>).connected !== "boolean" ||
      typeof (result as Record<string, unknown>).phoneUrl !== "string"
    ) {
      throw new Error("The local listener did not return a Phone Use status.");
    }

    return true;
  } catch (error) {
    const value = error as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };

    if (value.code === "ENOENT" || value.cause?.code === "ECONNREFUSED") {
      return false;
    }

    throw error;
  }
}

/** Removes a startup lock only after its recorded process has exited. */
async function removeStaleLock(path: string): Promise<void> {
  try {
    const before = await stat(path);
    const contents = await readFile(path, "utf8");
    const pid = /^\d+\n?$/.test(contents) ? Number(contents.trim()) : 0;

    if (pid > 0) {
      try {
        process.kill(pid, 0);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    } else if (Date.now() - before.mtimeMs < 2000) {
      return;
    }

    const current = await stat(path);

    if (current.ino === before.ino && current.mtimeMs === before.mtimeMs) {
      await unlink(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/** Bounds lock wait, avoids concurrent certificate generation, and never grants phone consent. */
export async function startManagedBridge(
  options: CreateBridgeOptions,
  signal?: AbortSignal,
): Promise<ManagedBridge> {
  const adminPort = options.adminPort ?? 8766;

  if (!Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65535) {
    throw new Error("The managed bridge requires an admin port between 1 and 65535.");
  }

  const consoleUrl = `http://127.0.0.1:${adminPort}`;
  const reused: ManagedBridge = { owned: false, consoleUrl, async close() {} };
  const lockPath = join(options.stateDir, "mcp-start.lock");
  const deadline = performance.now() + 8000;

  while (performance.now() < deadline) {
    signal?.throwIfAborted();

    await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    let lock;

    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      await removeStaleLock(lockPath);
      await delay(100, undefined, { signal });
      continue;
    }

    try {
      await lock.writeFile(`${process.pid}\n`);
      signal?.throwIfAborted();

      if (await isRunning(options, signal)) {
        return reused;
      }

      const bridge = await createBridge(options);

      if (signal?.aborted) {
        await bridge.close();
        signal.throwIfAborted();
      }

      let closed = false;

      return {
        owned: true,
        consoleUrl: bridge.adminAddress.url,
        async close() {
          if (!closed) {
            closed = true;
            await bridge.close();
          }
        },
      };
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }

  throw new Error(
    "Another Phone Use process is still starting. Wait and reconnect the MCP session.",
  );
}
