/** Keeps the onboarding console available after setup exits, reusing an authenticated bridge when present. */
import { resolve } from "node:path";
import { startManagedBridge, type ManagedBridge } from "./managed-bridge.js";
import { environmentPort, lanAddress, repositoryRoot, stateDir } from "./runtime.js";

/** Starts persistent listeners and emits exactly one secret-free readiness record for the bootstrap script. */
async function serve(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.some((argument) => argument !== "--agent-configured") || args.length > 1) {
    throw new Error("Unknown onboarding bridge option.");
  }

  const controller = new AbortController();
  let bridge: ManagedBridge | undefined;

  /** Cancels startup or closes this process's listeners without stopping a reused bridge. */
  const stop = (): void => {
    controller.abort();
    void bridge?.close().catch(() => {
      process.exitCode = 1;
    });
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    bridge = await startManagedBridge(
      {
        stateDir,
        phonePort: environmentPort(process.env.PHONEUSE_PHONE_PORT, 8765),
        adminPort: environmentPort(process.env.PHONEUSE_ADMIN_PORT, 8766),
        advertisedHost: process.env.PHONEUSE_ADVERTISE_HOST ?? lanAddress(),
        publicDir: resolve(repositoryRoot, "bridge/public"),
        mcpEntry: resolve(repositoryRoot, "bridge/dist/src/mcp-launcher.js"),
        apkPath: resolve(repositoryRoot, "artifacts/PhoneUse-debug.apk"),
        agentConfigured: args.includes("--agent-configured"),
        onShutdown: stop,
      },
      controller.signal,
    );
    process.stdout.end(
      `${JSON.stringify({ consoleUrl: bridge.consoleUrl, bridgeStarted: bridge.owned })}\n`,
    );
    process.stderr.end();
  } catch (error) {
    await bridge?.close();

    if (!controller.signal.aborted) {
      throw error;
    }
  }
}

void serve().catch((error: unknown) => {
  process.stderr.write(
    `Phone Use onboarding bridge could not start: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
