/** Covers transport and traversal regressions that can stall or mislead phone navigation. */
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { PNG } from "pngjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBridge } from "../src/bridge.js";
import { createPhoneMcpServer } from "../src/mcp.js";
import { requestLocal } from "../src/local-client.js";
import { HelloSchema, isBase64, parseCommand, validateCommandResult } from "../src/protocol.js";
import { ensureState } from "../src/state.js";

test("bridge accepts a valid PNG over four megabytes encoded without ending the phone session", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "phoneuse-large-shot-"));
  const bridge = await createBridge({
    stateDir,
    host: "127.0.0.1",
    phonePort: 0,
    adminPort: 0,
    advertisedHost: "127.0.0.1",
  });
  const phone = await connect(bridge.phoneAddress.url, bridge.state.phoneToken);
  try {
    phone.send(JSON.stringify(hello(true)));
    const png = new PNG({ width: 1440, height: 700 });
    for (let i = 0; i < png.data.length; i++) png.data[i] = (i * 73 + (i >>> 8) * 19) & 255;
    const bytes = PNG.sync.write(png, { deflateLevel: 0 });
    const data = bytes.toString("base64");
    assert.ok(bytes.length >= 3_000_000, "fixture should exercise a large but valid screenshot");
    assert.ok(data.length >= 4_000_000, "base64 screenshot should exceed four megabytes");
    const responsePromise = fetch(`${bridge.adminAddress.url}/api/command`, {
      method: "POST",
      headers: adminHeaders(bridge.state.adminToken),
      body: JSON.stringify({ method: "screenshot", params: {} }),
    });
    const command = await nextPhoneMessage(phone);
    assert.equal(Number.isInteger(command.timeoutMs), true);
    assert.ok(Number(command.timeoutMs) >= 100 && Number(command.timeoutMs) <= 120_000);
    assert.equal(
      "deadline" in command,
      false,
      "wire deadlines must not depend on the desktop clock",
    );
    phone.send(
      JSON.stringify({
        type: "result",
        id: command.id,
        ok: true,
        result: {
          mimeType: "image/png",
          data,
          width: 1440,
          height: 700,
          screen: { width: 1440, height: 700 },
        },
      }),
    );
    const response = await responsePromise;
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { ok: boolean; result: { data: string } };
    assert.equal(payload.ok, true);
    assert.equal(payload.result.data, data);
    assert.equal(phone.readyState, WebSocket.OPEN);
  } finally {
    phone.terminate();
    await bridge.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("queued HTTP cancellation removes the abandoned tap while a later command still dispatches", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "phoneuse-queued-cancel-"));
  const bridge = await createBridge({
    stateDir,
    host: "127.0.0.1",
    phonePort: 0,
    adminPort: 0,
    advertisedHost: "127.0.0.1",
  });
  const phone = await connect(bridge.phoneAddress.url, bridge.state.phoneToken);
  try {
    phone.send(JSON.stringify(hello(true)));
    const first = postCommand(bridge.adminAddress.url, bridge.state.adminToken, {
      method: "tap",
      params: { x: 1, y: 1 },
    });
    const firstMessage = await nextPhoneMessage(phone);
    const abandoned = postCommand(bridge.adminAddress.url, bridge.state.adminToken, {
      method: "tap",
      params: { x: 2, y: 2 },
    });
    void abandoned.response.catch(() => undefined);
    await abandoned.sent;
    // Allow Node's loopback HTTP parser to finish dispatching the request body.
    await new Promise((resolve) => setTimeout(resolve, 80));
    abandoned.abort();
    // A subsequent authenticated request confirms the loopback server has processed
    // the caller's socket close before the active command is released.
    const status = await fetch(`${bridge.adminAddress.url}/api/status`, {
      headers: { authorization: `Bearer ${bridge.state.adminToken}` },
    });
    assert.equal(status.status, 200);
    const later = fetch(`${bridge.adminAddress.url}/api/command`, {
      method: "POST",
      headers: adminHeaders(bridge.state.adminToken),
      body: JSON.stringify({ method: "tap", params: { x: 3, y: 3 } }),
    });
    phone.send(
      JSON.stringify({
        type: "result",
        id: firstMessage.id,
        ok: true,
        result: { performed: true },
      }),
    );
    const laterMessage = await nextPhoneMessage(phone);
    assert.deepEqual(laterMessage.params, { x: 3, y: 3 });
    phone.send(
      JSON.stringify({
        type: "result",
        id: laterMessage.id,
        ok: true,
        result: { performed: true },
      }),
    );
    assert.equal((await first.response).status, 200);
    assert.equal((await later).status, 200);
    assert.equal(await noPhoneMessage(phone), true);
  } finally {
    phone.terminate();
    await bridge.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("canceling an active HTTP action closes the phone session and never dispatches queued input", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "phoneuse-active-cancel-"));
  const bridge = await createBridge({
    stateDir,
    host: "127.0.0.1",
    phonePort: 0,
    adminPort: 0,
    advertisedHost: "127.0.0.1",
  });
  const phone = await connect(bridge.phoneAddress.url, bridge.state.phoneToken);
  try {
    phone.send(JSON.stringify(hello(true)));
    const active = postCommand(bridge.adminAddress.url, bridge.state.adminToken, {
      method: "tap",
      params: { x: 4, y: 5 },
    });
    void active.response.catch(() => undefined);
    await nextPhoneMessage(phone);
    const queued = postCommand(bridge.adminAddress.url, bridge.state.adminToken, {
      method: "tap",
      params: { x: 6, y: 7 },
    });
    await queued.sent;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const closed = new Promise<number>((resolve) => phone.once("close", (code) => resolve(code)));
    active.abort();
    assert.equal(await bounded(closed), 1008);
    const queuedResponse = await bounded(queued.response);
    assert.equal(queuedResponse.status, 503);
    assert.equal(await noPhoneMessage(phone), true);
  } finally {
    phone.terminate();
    await bridge.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("action observation keeps action success separate from snapshot failure and rejects nested actions", () => {
  const result = validateCommandResult("observe_action", {
    performed: true,
    observation: {
      ok: false,
      error: { code: "SNAPSHOT_FAILED", message: "The screen changed during observation." },
    },
  });
  assert.deepEqual(result, {
    performed: true,
    observation: {
      ok: false,
      error: { code: "SNAPSHOT_FAILED", message: "The screen changed during observation." },
    },
  });
  assert.throws(() =>
    parseCommand({
      method: "observe_action",
      params: {
        action: {
          method: "observe_action",
          params: { action: { method: "global_action", params: { action: "home" } } },
        },
      },
    }),
  );
  assert.throws(() =>
    parseCommand({
      method: "observe_action",
      params: {
        action: { method: "global_action", params: { action: "unlock" } },
      },
    }),
  );
  assert.throws(() => HelloSchema.parse({ ...(hello(true) as object), version: 1 }), /version/);
  assert.equal(isBase64("Zg=="), true);
  assert.equal(isBase64("Zh=="), false, "nonzero canonical padding bits must be rejected");
  assert.equal(isBase64("Zm9="), false, "nonzero canonical padding bits must be rejected");
  for (const method of ["__proto__", "constructor", "toString"])
    assert.throws(() => parseCommand({ method, params: {} }), /Unknown command method/);
  const node = {
    id: "0",
    windowId: 1,
    bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    clickable: false,
    editable: false,
    scrollable: false,
    enabled: true,
    actions: [],
  };
  const hierarchy = {
    ...emptySnapshot(),
    nodes: [node, { ...node, id: "1", parentId: "0" }],
    windows: [{ id: 1, type: 1, active: true, focused: true, bounds: node.bounds }],
  };
  assert.doesNotThrow(() => validateCommandResult("snapshot", hierarchy));
  assert.throws(
    () =>
      validateCommandResult("snapshot", {
        ...hierarchy,
        nodes: [
          { ...node, parentId: "1" },
          { ...node, id: "1", parentId: "0" },
        ],
      }),
    /ancestry/,
  );
  assert.throws(
    () =>
      validateCommandResult("snapshot", {
        ...hierarchy,
        nodes: [{ ...node, windowId: 2 }],
      }),
    /window/,
  );
});

test("local client propagates abort signals, avoids fetch for pre-aborted calls, and reports uncertain command outcomes", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "phoneuse-local-client-"));
  await ensureState(stateDir);
  try {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    let fetchCount = 0;
    await assert.rejects(
      requestLocal(
        "/api/command",
        {},
        {
          stateDir,
          signal: alreadyAborted.signal,
          fetchImpl: (async () => {
            fetchCount++;
            throw new Error("must not fetch");
          }) as typeof fetch,
        },
      ),
      (error: unknown) =>
        hasCode(error, "REQUEST_CANCELLED") &&
        error instanceof Error &&
        /may have executed/.test(error.message),
    );
    assert.equal(fetchCount, 0);

    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const pendingFetch = requestLocal(
      "/api/command",
      { method: "tap" },
      {
        stateDir,
        signal: controller.signal,
        fetchImpl: (async (_input, init) => {
          observedSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            observedSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        }) as typeof fetch,
      },
    );
    await waitFor(() => observedSignal !== undefined);
    controller.abort();
    await assert.rejects(
      pendingFetch,
      (error: unknown) =>
        hasCode(error, "REQUEST_CANCELLED") &&
        error instanceof Error &&
        /Never retry automatically/.test(error.message),
    );
    assert.equal(observedSignal?.aborted, true);

    await assert.rejects(
      requestLocal(
        "/api/command",
        {},
        {
          stateDir,
          timeoutMs: 100,
          fetchImpl: (async (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            })) as typeof fetch,
        },
      ),
      (error: unknown) =>
        hasCode(error, "LOCAL_TIMEOUT") &&
        error instanceof Error &&
        /may have executed/.test(error.message),
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("MCP exposes semantic navigation tools, forwards scope and screenshot size, and preserves observation failures", async () => {
  const calls: Array<{ path: string; body?: unknown; signal?: AbortSignal }> = [];
  const server = createPhoneMcpServer(async (path, body, options) => {
    calls.push({ path, body, signal: options?.signal });
    if (path !== "/api/command") return { connected: true };
    const command = body as { method: string; params: Record<string, unknown> };
    if (command.method === "snapshot")
      return {
        type: "result",
        id: "0021a84e-3f91-4a28-9fd9-09215790c14b",
        ok: true,
        result: emptySnapshot(),
      };
    if (command.method === "observe_action")
      return {
        type: "result",
        id: "0021a84e-3f91-4a28-9fd9-09215790c14b",
        ok: true,
        result: {
          performed: true,
          observation: {
            ok: false,
            error: { code: "SNAPSHOT_FAILED", message: "The screen changed during observation." },
          },
        },
      };
    if (command.method === "screenshot")
      return {
        type: "result",
        id: "0021a84e-3f91-4a28-9fd9-09215790c14b",
        ok: true,
        result: {
          mimeType: "image/png",
          data: Buffer.from("png").toString("base64"),
          width: 320,
          height: 640,
          screen: { width: 1080, height: 2400 },
        },
      };
    return {
      type: "result",
      id: "0021a84e-3f91-4a28-9fd9-09215790c14b",
      ok: true,
      result: { performed: true },
    };
  });
  const client = new Client({ name: "phoneuse-navigation-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    for (const name of [
      "phone_snapshot",
      "phone_screenshot",
      "phone_scroll",
      "phone_act_and_observe",
    ]) {
      assert.equal(
        listed.tools.some((tool) => tool.name === name),
        true,
        `${name} should be available to agents`,
      );
    }
    const snapshot = await client.callTool({
      name: "phone_snapshot",
      arguments: {
        root: { snapshotId: "0021a84e-3f91-4a28-9fd9-09215790c14b", nodeId: "root" },
      },
    });
    assert.equal(snapshot.isError, undefined);
    assert.deepEqual(calls.at(-1)?.body, {
      method: "snapshot",
      params: { root: { snapshotId: "0021a84e-3f91-4a28-9fd9-09215790c14b", nodeId: "root" } },
    });
    const screenshot = await client.callTool({
      name: "phone_screenshot",
      arguments: { maxDimension: 640 },
    });
    assert.equal(screenshot.isError, undefined);
    assert.deepEqual(calls.at(-1)?.body, { method: "screenshot", params: { maxDimension: 640 } });
    const observation = await client.callTool({
      name: "phone_act_and_observe",
      arguments: {
        action: { method: "tap", params: { x: 10, y: 20 } },
      },
    });
    assert.equal(
      observation.isError,
      undefined,
      "observation failure does not undo a performed action",
    );
    assert.match(
      (observation.content as Array<{ text?: string }>)[0]?.text ?? "",
      /"performed":true/,
    );
    assert.match((observation.content as Array<{ text?: string }>)[0]?.text ?? "", /"ok":false/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP tool cancellation reaches the local request signal", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let observedSignal: AbortSignal | undefined;
  const server = createPhoneMcpServer(async (_path, _body, options) => {
    const signal = options?.signal;
    assert.ok(signal);
    observedSignal = signal;
    resolveStarted();
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("request canceled")), { once: true });
    });
  });
  const client = new Client({ name: "phoneuse-cancel-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const controller = new AbortController();
    const call = client.callTool({ name: "phone_tap", arguments: { x: 1, y: 1 } }, undefined, {
      signal: controller.signal,
    });
    await waitFor(() => observedSignal !== undefined);
    await started;
    controller.abort();
    await assert.rejects(call);
    assert.equal(observedSignal?.aborted, true);
  } finally {
    await client.close();
    await server.close();
  }
});

function hello(enabled: boolean): unknown {
  return {
    type: "hello",
    version: 2,
    device: { id: "0021a84e-3f91-4a28-9fd9-09215790c14b", name: "Test phone", sdk: 35 },
    status: { accessibilityEnabled: enabled, controlEnabled: enabled },
  };
}

function adminHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function emptySnapshot(): Record<string, unknown> {
  return {
    snapshotId: "0021a84e-3f91-4a28-9fd9-09215790c14b",
    packageName: "dev.example.app",
    screen: { width: 1080, height: 2400 },
    nodes: [],
    truncated: false,
    windows: [],
  };
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the request to start.");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function connect(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      rejectUnauthorized: false,
      headers: { authorization: `Bearer ${token}` },
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextPhoneMessage(socket: WebSocket): Promise<Record<string, unknown> & { id: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for a phone command."));
    }, 3000);
    const onMessage = (data: WebSocket.RawData) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown> & { id: string });
      } catch (error) {
        reject(error);
      }
    };
    socket.once("message", onMessage);
  });
}

function postCommand(
  url: string,
  token: string,
  body: unknown,
): { sent: Promise<void>; response: Promise<Response>; abort: () => void } {
  let resolveSent!: () => void;
  let rejectSent!: (error: Error) => void;
  let resolveResponse!: (response: Response) => void;
  let rejectResponse!: (error: Error) => void;
  const sent = new Promise<void>((resolve, reject) => {
    resolveSent = resolve;
    rejectSent = reject;
  });
  const response = new Promise<Response>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const target = new URL(url);
  const request = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      path: "/api/command",
      method: "POST",
      headers: adminHeaders(token),
    },
    (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("end", () =>
        resolveResponse(new Response(Buffer.concat(chunks), { status: incoming.statusCode })),
      );
    },
  );
  request.once("finish", resolveSent);
  request.once("error", (error) => {
    rejectSent(error);
    rejectResponse(error);
  });
  request.end(JSON.stringify(body));
  return { sent, response, abort: () => request.destroy() };
}

async function noPhoneMessage(socket: WebSocket): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", unexpected);
      resolve(true);
    }, 40);
    const unexpected = (data: WebSocket.RawData) => {
      clearTimeout(timer);
      reject(new Error(`Unexpected command reached the phone: ${data.toString().slice(0, 300)}`));
    };
    socket.once("message", unexpected);
  });
}

function bounded<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for cancellation cleanup.")), 3000),
    ),
  ]);
}
