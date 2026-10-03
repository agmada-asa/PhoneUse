/** Runs MCP with a bridge owned by this session when no authenticated bridge is already available. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPhoneMcpServer } from "./mcp.js";
import { startManagedBridge, type ManagedBridge } from "./managed-bridge.js";
import { environmentPort, lanAddress, repositoryRoot, stateDir } from "./runtime.js";

/** Keeps stdout exclusively for MCP and tears down owned listeners on EOF or termination. */
export async function runManagedMcpServer(): Promise<void> {
  if (process.argv.length > 2) {
    throw new Error(
      "The MCP launcher accepts no arguments. Configure PHONEUSE_* environment variables instead.",
    );
  }

  const controller = new AbortController();
  const server = createPhoneMcpServer();
  let bridge: ManagedBridge | undefined;
  let stopping: Promise<void> | undefined;

  /** Aborts startup and closes MCP plus only the listeners created by this session. */
  const stop = (): Promise<void> => {
    controller.abort();

    stopping ??= Promise.resolve().then(async () => {
      await server.close();
      await bridge?.close();
      process.stdin.pause();
    });

    return stopping;
  };

  /** Signal and EOF handlers report cleanup failures without exposing phone content. */
  const onStop = (): void => {
    void stop().catch(() => {
      process.stderr.write("PhoneUse could not close its managed bridge cleanly.\n");
      process.exitCode = 1;
    });
  };

  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);
  process.stdin.once("end", onStop);
  process.stdin.once("close", onStop);

  try {
    bridge = await startManagedBridge(
      {
        stateDir,
        host: "0.0.0.0",
        advertisedHost: process.env.PHONEUSE_ADVERTISE_HOST ?? lanAddress(),
        phonePort: environmentPort(process.env.PHONEUSE_PHONE_PORT, 8765),
        adminPort: environmentPort(process.env.PHONEUSE_ADMIN_PORT, 8766),
        publicDir: resolve(repositoryRoot, "bridge/public"),
        mcpEntry: resolve(repositoryRoot, "bridge/dist/src/mcp-launcher.js"),
        apkPath: resolve(repositoryRoot, "artifacts/PhoneUse-debug.apk"),
        onShutdown: onStop,
      },
      controller.signal,
    );
    controller.signal.throwIfAborted();
    process.stderr.write(
      `PhoneUse ${bridge.owned ? "started" : "reused"} bridge. Console: ${bridge.consoleUrl}\n`,
    );
    server.server.onclose = onStop;
    await server.connect(new StdioServerTransport());
  } catch (error) {
    const canceled = controller.signal.aborted;
    await bridge?.close();
    await stop();
    process.removeListener("SIGINT", onStop);
    process.removeListener("SIGTERM", onStop);
    process.stdin.removeListener("end", onStop);
    process.stdin.removeListener("close", onStop);

    if (!canceled) {
      throw error;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runManagedMcpServer().catch((error: unknown) => {
    process.stderr.write(
      `PhoneUse MCP could not start: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  });
}
