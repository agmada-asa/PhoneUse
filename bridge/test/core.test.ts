/** Exercises bridge authentication, origin checks, strict payload validation, serialized dispatch, disconnect, and timeout behavior. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { PNG } from "pngjs";
import jsQR from "jsqr";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBridge } from "../src/bridge.js";
import { createPhoneMcpServer } from "../src/mcp.js";
import { parseCommand, validateCommandResult } from "../src/protocol.js";
import { ensureState } from "../src/state.js";

test("state uses private credentials and fingerprints the certificate DER", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "phoneuse-state-"));
  try {
    const state = await ensureState(stateDir);
    const stateStats = await stat(state.statePath);
    assert.equal(stateStats.mode & 0o777, 0o600);
    assert.match(state.phoneToken, /^[a-f0-9]{64}$/);
    assert.match(state.adminToken, /^[a-f0-9]{64}$/);
    assert.match(state.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal((await readFile(state.certPath, "utf8")).includes("BEGIN CERTIFICATE"), true);
    assert.equal((await ensureState(stateDir)).phoneToken, state.phoneToken);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("snapshot accepts signed partial rectangles while commands require integer pixels", () => {
  const snapshot = {
    snapshotId: "0021a84e-3f91-4a28-9fd9-09215790c14b",
    packageName: "dev.example.app",
    screen: { width: 1080, height: 2400 },
    nodes: [
      {
        id: "node-1",
        bounds: { left: -12, top: -4, right: 80, bottom: 100 },
        clickable: true,
        editable: false,
        scrollable: false,
        enabled: true,
        windowId: 1,
        actions: ["click"],
      },
    ],
    windows: [
      {
        id: 1,
        type: 1,
        active: true,
        focused: true,
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
      },
    ],
    truncated: false,
  };
  assert.deepEqual(validateCommandResult("snapshot", snapshot), snapshot);
  assert.throws(() =>
    validateCommandResult("snapshot", {
      ...snapshot,
      nodes: [{ ...snapshot.nodes[0], bounds: { left: 20, top: 0, right: 19, bottom: 1 } }],
    }),
  );
  assert.throws(() => parseCommand({ method: "tap", params: { x: 1.5, y: 4 } }));
});

test("loopback API authenticates, validates, serializes commands and disconnects the phone", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "phoneuse-bridge-"));
  const bridge = await createBridge({
    stateDir,
    host: "127.0.0.1",
    phonePort: 0,
    adminPort: 0,
    advertisedHost: "127.0.0.1",
    commandTimeoutMs: 1500,
  });
  const api = bridge.adminAddress.url;
  const adminHeaders = {
    authorization: `Bearer ${bridge.state.adminToken}`,
    "content-type": "application/json",
  };
  let phone: WebSocket | undefined;
  try {
    const denied = await fetch(`${api}/api/status`);
    assert.equal(denied.status, 401);
    const foreign = await fetch(`${api}/api/status`, {
      headers: { origin: "https://attacker.example" },
    });
    assert.equal(foreign.status, 403);
    const noCsrfPairing = await fetch(`${api}/api/pairing`, { headers: { origin: api } });
    assert.equal(noCsrfPairing.status, 403);
    const unauthenticatedPairing = await fetch(`${api}/api/pairing`);
    assert.equal(unauthenticatedPairing.status, 401);
    const foreignPairing = await fetch(`${api}/api/pairing`, {
      headers: { origin: "https://attacker.example", "x-phoneuse-csrf": bridge.state.csrfToken },
    });
    assert.equal(foreignPairing.status, 403);
    const pairing = await fetch(`${api}/api/pairing`, {
      headers: { origin: api, "x-phoneuse-csrf": bridge.state.csrfToken },
    });
    assert.equal(pairing.status, 200);
    assert.equal(pairing.headers.get("cache-control"), "no-store");
    const pairingData = (await pairing.json()) as {
      url: string;
      fingerprint: string;
      code: string;
      qrDataUrl: string;
    };
    assert.match(pairingData.code, /^phoneuse:/);
    assert.equal(pairingData.url, bridge.phoneAddress.url);
    assert.match(pairingData.qrDataUrl, /^data:image\/png;base64,/);
    const qrImage = PNG.sync.read(Buffer.from(pairingData.qrDataUrl.split(",")[1]!, "base64"));
    const decodedQr = jsQR.default(
      new Uint8ClampedArray(qrImage.data),
      qrImage.width,
      qrImage.height,
    );
    assert.ok(decodedQr, "Pairing image must decode as a QR code");
    assert.equal(decodedQr.data, pairingData.code);
    const qrCredentials = JSON.parse(
      Buffer.from(decodedQr.data.slice(9), "base64url").toString("utf8"),
    );
    assert.deepEqual(qrCredentials, {
      v: 1,
      url: bridge.phoneAddress.url,
      token: bridge.state.phoneToken,
      fingerprint: bridge.state.fingerprint,
    });

    const malformed = await fetch(`${api}/api/command`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ method: "tap", params: { x: 1, y: 2, surprise: true } }),
    });
    assert.equal(malformed.status, 400);
    const gated = await fetch(`${api}/api/command`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ method: "snapshot", params: {} }),
    });
    assert.equal(gated.status, 503);

    await assert.rejects(connect(bridge.phoneAddress.url, "0".repeat(64)));
    phone = await connect(bridge.phoneAddress.url, bridge.state.phoneToken);
    phone.send(JSON.stringify(hello(false)));
    const disabled = await fetch(`${api}/api/command`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ method: "tap", params: { x: 4, y: 8 } }),
    });
    assert.equal(disabled.status, 403);
    phone.send(JSON.stringify(hello(true)));

    const firstResponse = fetch(`${api}/api/command`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ method: "tap", params: { x: 4, y: 8 } }),
    });
    const firstMessage = await nextPhoneMessage(phone);
    const secondResponse = fetch(`${api}/api/command`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        method: "swipe",
        params: { startX: 0, startY: 0, endX: 20, endY: 20, durationMs: 100 },
      }),
    });
    let premature = false;
    const observePremature = () => {
      premature = true;
    };
    phone.on("message", observePremature);
    await new Promise((resolve) => setTimeout(resolve, 120));
    phone.off("message", observePremature);
    assert.equal(premature, false); // The second command remains in the bridge queue.
    phone.send(
      JSON.stringify({
        type: "result",
        id: firstMessage.id,
        ok: true,
        result: { performed: true },
      }),
    );
    const secondMessage = await nextPhoneMessage(phone);
    phone.send(
      JSON.stringify({
        type: "result",
        id: secondMessage.id,
        ok: true,
        result: { performed: true },
      }),
    );
    assert.equal((await firstResponse).status, 200);
    assert.equal((await secondResponse).status, 200);

    const deliberateClose = new Promise<number>((resolve) =>
      phone!.once("close", (code) => resolve(code)),
    );
    const disconnected = await fetch(`${api}/api/disconnect`, {
      method: "POST",
      headers: adminHeaders,
      body: "{}",
    });
    assert.equal(disconnected.status, 200);
    assert.equal(((await disconnected.json()) as { disconnected: boolean }).disconnected, true);
    assert.equal(await deliberateClose, 1000);
    const status = await fetch(`${api}/api/status`, { headers: adminHeaders });
    assert.equal(((await status.json()) as { connected: boolean }).connected, false);
  } finally {
    if (phone && phone.readyState !== WebSocket.CLOSED) phone.terminate();
    await bridge.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("console serves its fonts, the agent command, and the phone address, but no other public files", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "phoneuse-console-"));
  const publicDir = join(import.meta.dirname, "../../public");
  const bridge = await createBridge({
    stateDir,
    host: "127.0.0.1",
    phonePort: 0,
    adminPort: 0,
    advertisedHost: "192.168.1.20",
    publicDir,
    mcpEntry: "/opt/phone<use>/mcp.js",
  });
  const api = bridge.adminAddress.url;
  try {
    const page = await fetch(api);
    const html = await page.text();
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.ok(
      html.includes("node /opt/phone&lt;use&gt;/mcp.js"),
      "MCP entry is HTML-escaped into the page",
    );
    assert.ok(!html.includes("{{"), "Every template placeholder is filled");
    const font = await fetch(`${api}/fonts/instrument-sans.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("content-type"), "font/woff2");
    for (const path of ["/fonts/OFL.txt", "/fonts/bbh-bartle.woff", "/fonts/other.woff2"])
      assert.equal((await fetch(`${api}${path}`)).status, 404, path);
    const status = await fetch(`${api}/api/status`, {
      headers: { authorization: `Bearer ${bridge.state.adminToken}` },
    });
    assert.equal(((await status.json()) as { phoneUrl: string }).phoneUrl, bridge.phoneAddress.url);
  } finally {
    await bridge.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("active command timeout reports uncertain execution and closes the phone session", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "phoneuse-timeout-"));
  const bridge = await createBridge({
    stateDir,
    host: "127.0.0.1",
    phonePort: 0,
    adminPort: 0,
    advertisedHost: "127.0.0.1",
    commandTimeoutMs: 120,
  });
  const phone = await connect(bridge.phoneAddress.url, bridge.state.phoneToken);
  try {
    phone.send(JSON.stringify(hello(true)));
    const request = fetch(`${bridge.adminAddress.url}/api/command`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.state.adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "tap", params: { x: 3, y: 5 } }),
    });
    await nextPhoneMessage(phone);
    const response = await request;
    assert.equal(response.status, 504);
    const data = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(data.error.code, "COMMAND_TIMEOUT");
    assert.match(data.error.message, /may have executed/);
    const status = await fetch(`${bridge.adminAddress.url}/api/status`, {
      headers: { authorization: `Bearer ${bridge.state.adminToken}` },
    });
    assert.equal(((await status.json()) as { connected: boolean }).connected, false);
  } finally {
    phone.terminate();
    await bridge.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("malformed phone results fail the active call with a safe protocol error", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "phoneuse-protocol-error-"));
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
    const request = fetch(`${bridge.adminAddress.url}/api/command`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.state.adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "snapshot", params: {} }),
    });
    const command = await nextPhoneMessage(phone);
    phone.send(
      JSON.stringify({
        type: "result",
        id: command.id,
        ok: true,
        result: { unexpected: "sensitive phone content" },
      }),
    );
    const response = await request;
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "PROTOCOL_ERROR");
    assert.equal(body.error.message.includes("sensitive phone content"), false);
  } finally {
    phone.terminate();
    await bridge.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("MCP tools proxy commands and preserve screenshots as image content", async () => {
  const requests: Array<{ path: string; body?: unknown }> = [];
  const server = createPhoneMcpServer(async (path, body) => {
    requests.push({ path, body });
    if (path === "/api/status") return { connected: true };
    const command = body as { method: string };
    if (command.method === "global_action")
      throw Object.assign(new Error("This action was blocked by the phone."), {
        code: "APP_BLOCKED",
      });
    const result =
      command.method === "screenshot"
        ? {
            mimeType: "image/png",
            data: Buffer.from("png").toString("base64"),
            width: 320,
            height: 640,
            screen: { width: 1080, height: 2160 },
          }
        : { performed: true };
    return { type: "result", id: "0021a84e-3f91-4a28-9fd9-09215790c14b", ok: true, result };
  });
  const client = new Client({ name: "phoneuse-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    assert.equal(
      listed.tools.some((tool) => tool.name === "phone_screenshot"),
      true,
    );
    assert.equal(
      listed.tools.some((tool) => tool.name === "phone_disconnect"),
      true,
    );
    const tap = await client.callTool({ name: "phone_tap", arguments: { x: 12, y: 18 } });
    assert.equal(tap.isError, undefined);
    assert.deepEqual(requests[0]?.body, { method: "tap", params: { x: 12, y: 18 } });
    const screenshot = await client.callTool({ name: "phone_screenshot", arguments: {} });
    assert.equal(screenshot.isError, undefined);
    const content = screenshot.content as Array<{ type: string; mimeType?: string; text?: string }>;
    assert.equal(
      content.some((item) => item.type === "image" && item.mimeType === "image/png"),
      true,
    );
    assert.equal(
      content.some((item) => item.type === "text" && item.text?.includes("320×640")),
      true,
    );
    const blocked = await client.callTool({ name: "phone_back", arguments: {} });
    assert.equal(blocked.isError, true);
    assert.equal(
      (blocked.content as Array<{ type: string; text?: string }>).some((item) =>
        item.text?.includes("APP_BLOCKED"),
      ),
      true,
    );
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
    const onError = (error: Error) => {
      socket.off("message", onMessage);
      reject(error);
    };
    const onMessage = (data: WebSocket.RawData) => {
      socket.off("error", onError);
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown> & { id: string });
      } catch (error) {
        reject(error);
      }
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
  });
}
