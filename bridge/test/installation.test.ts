/** Verifies managed MCP startup, authenticated reuse, session shutdown, and failure cleanup with isolated state. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createBridge } from "../src/bridge.js";
import { startManagedBridge } from "../src/managed-bridge.js";
import { requestLocal } from "../src/local-client.js";
import { repositoryRoot } from "../src/runtime.js";

/** Reserves an available loopback port without using the operator's normal PhoneUse ports. */
async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

/** Gives each subprocess its own identity, ports, and unrelated working directory. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "phoneuse-mcp-install-"));
  const stateDir = join(root, "private state");
  const phonePort = await availablePort();
  let adminPort = await availablePort();

  while (adminPort === phonePort) {
    adminPort = await availablePort();
  }
  const env = {
    ...process.env,
    PHONEUSE_STATE_DIR: stateDir,
    PHONEUSE_PHONE_PORT: String(phonePort),
    PHONEUSE_ADMIN_PORT: String(adminPort),
    PHONEUSE_ADVERTISE_HOST: "127.0.0.1",
  } as Record<string, string>;

  return { root, stateDir, phonePort, adminPort, env };
}

/** Connects a real MCP stdio client and drains diagnostics so pipe buffers cannot block shutdown. */
async function connect(env: Record<string, string>, cwd: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(repositoryRoot, "bridge/dist/src/mcp-launcher.js")],
    env,
    cwd,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (data: Buffer) => {
    diagnostics += data.toString();
  });
  const client = new Client({ name: "phoneuse-install-test", version: "1.0.0" });

  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    throw error;
  }

  return { client, diagnostics: () => diagnostics };
}

/** Waits only for read-only health failures, never retrying a phone input action. */
async function waitForStopped(stateDir: string, adminPort: number): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    try {
      await requestLocal("/api/status", undefined, { stateDir, adminPort, timeoutMs: 500 });
    } catch {
      return;
    }

    await delay(100);
  }

  assert.fail("The managed bridge remained running after its session ended.");
}

test(
  "managed stdio starts from another cwd, exposes tools, reuses the bridge and closes only its owner",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    let first: Awaited<ReturnType<typeof connect>> | undefined;
    let second: Awaited<ReturnType<typeof connect>> | undefined;

    try {
      first = await connect(f.env, f.root);
      const tools = await first.client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === "phone_act_and_observe"));
      const status = await first.client.callTool({ name: "phone_status", arguments: {} });
      assert.equal(status.isError, undefined);
      assert.equal(
        JSON.parse((status.content as Array<{ text: string }>)[0]!.text).connected,
        false,
      );
      const denied = await first.client.callTool({ name: "phone_snapshot", arguments: {} });
      assert.equal(denied.isError, true);
      assert.equal((await stat(f.stateDir)).mode & 0o777, 0o700);
      assert.match(first.diagnostics(), /started bridge/);
      const initialState = await readFile(join(f.stateDir, "state.json"), "utf8");

      second = await connect(f.env, f.root);
      assert.match(second.diagnostics(), /reused bridge/);
      assert.equal(await readFile(join(f.stateDir, "state.json"), "utf8"), initialState);
      await second.client.close();
      second = undefined;
      await requestLocal("/api/status", undefined, {
        stateDir: f.stateDir,
        adminPort: f.adminPort,
      });
      await first.client.close();
      first = undefined;
      await waitForStopped(f.stateDir, f.adminPort);
      await assert.rejects(stat(join(f.stateDir, "mcp-start.lock")), { code: "ENOENT" });
    } finally {
      await second?.client.close();
      await first?.client.close();
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "concurrent first-time startup creates one identity and leaves a manual bridge running",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    const options = {
      stateDir: f.stateDir,
      phonePort: f.phonePort,
      adminPort: f.adminPort,
      host: "127.0.0.1",
    };
    const managed = await Promise.all([startManagedBridge(options), startManagedBridge(options)]);

    try {
      assert.equal(managed.filter((bridge) => bridge.owned).length, 1);
      await managed.find((bridge) => !bridge.owned)!.close();
      await requestLocal("/api/status", undefined, {
        stateDir: f.stateDir,
        adminPort: f.adminPort,
      });
      await managed.find((bridge) => bridge.owned)!.close();
      const manual = await createBridge(options);

      try {
        const reused = await startManagedBridge(options);
        assert.equal(reused.owned, false);
        await reused.close();
        await requestLocal("/api/status", undefined, {
          stateDir: f.stateDir,
          adminPort: f.adminPort,
        });
      } finally {
        await manual.close();
      }
    } finally {
      await Promise.all(managed.map((bridge) => bridge.close()));
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

/** Runs a launcher until exit, capturing MCP stdout separately from stderr diagnostics. */
function launchUntilExit(env: Record<string, string>, cwd: string, eof = false) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(repositoryRoot, "bridge/dist/src/mcp-launcher.js")],
      { env, cwd, stdio: "pipe" },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Launcher did not exit."));
    }, 10_000);
    child.on("error", reject);
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();

      if (eof) {
        child.stdin.end();
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    if (eof) {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "eof-test", version: "1" } } })}\n`,
      );
    }
  });
}

test(
  "stdin EOF closes the managed bridge and stdout contains only MCP JSON",
  { timeout: 15_000 },
  async () => {
    const f = await fixture();

    try {
      const result = await launchUntilExit(f.env, f.root, true);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout.trim()).jsonrpc, "2.0");
      assert.match(result.stderr, /started bridge/);
      await waitForStopped(f.stateDir, f.adminPort);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "invalid ports fail before pairing state exists and occupied ports leave no active listeners",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    const occupied = createServer();

    try {
      const invalid = await launchUntilExit({ ...f.env, PHONEUSE_ADMIN_PORT: "invalid" }, f.root);
      assert.equal(invalid.code, 1);
      assert.equal(invalid.stdout, "");
      await assert.rejects(stat(f.stateDir), { code: "ENOENT" });
      await new Promise<void>((resolve) => occupied.listen(f.phonePort, "0.0.0.0", resolve));
      const collision = await launchUntilExit(f.env, f.root);
      assert.equal(collision.code, 1);
      assert.equal(collision.stdout, "");
      assert.match(collision.stderr, /EADDRINUSE/);
      await assert.rejects(stat(join(f.stateDir, "mcp-start.lock")), { code: "ENOENT" });
      await waitForStopped(f.stateDir, f.adminPort);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test("invalid state is reported without changing credentials", async () => {
  const f = await fixture();

  try {
    // The fixture parent exists; point directly to it for this corrupt-state check.
    const invalid = '{"adminToken":"broken"}';
    await writeFile(join(f.root, "state.json"), invalid);
    await assert.rejects(
      startManagedBridge({ stateDir: f.root, adminPort: f.adminPort }),
      /state file is invalid/,
    );
    assert.equal(await readFile(join(f.root, "state.json"), "utf8"), invalid);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
