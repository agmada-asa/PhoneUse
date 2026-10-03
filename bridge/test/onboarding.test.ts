/** Checks APK download and bridge shutdown authentication independently of phone control consent. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createBridge } from "../src/bridge.js";

test("APK downloads require local authentication, remain bounded and reveal no other files", async () => {
  const root = await mkdtemp(join(tmpdir(), "phoneuse-apk-api-"));
  const apkPath = join(root, "prepared.apk");
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  await writeFile(apkPath, bytes);
  const bridge = await createBridge({
    stateDir: join(root, "state"),
    phonePort: 0,
    adminPort: 0,
    host: "127.0.0.1",
    apkPath,
    agentConfigured: true,
  });
  const url = bridge.adminAddress.url;
  const csrf = { "x-phoneuse-csrf": bridge.state.csrfToken };
  const bearer = { authorization: `Bearer ${bridge.state.adminToken}` };

  try {
    assert.equal((await fetch(`${url}/api/apk`)).status, 401);
    assert.equal((await fetch(`${url}/api/apk`, { headers: { origin: url } })).status, 403);
    assert.equal(
      (await fetch(`${url}/api/apk`, { headers: { origin: "https://foreign.example", ...csrf } }))
        .status,
      403,
    );
    assert.equal(
      (await fetch(`${url}/api/apk`, { headers: { "sec-fetch-site": "cross-site", ...csrf } }))
        .status,
      403,
    );
    const download = await fetch(`${url}/api/apk`, { headers: { origin: url, ...csrf } });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/vnd.android.package-archive");
    assert.equal(download.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal((await fetch(`${url}/api/apk`, { headers: bearer })).status, 200);
    const status = (await fetch(`${url}/api/status`, { headers: bearer }).then((response) =>
      response.json(),
    )) as Record<string, unknown>;
    assert.equal(status.apkAvailable, true);
    assert.equal(status.agentConfigured, true);
    assert.equal(status.connected, false);
    assert.equal((await fetch(`${url}/api/apk?file=state.json`, { headers: bearer })).status, 404);
    await rm(apkPath);
    assert.equal((await fetch(`${url}/api/apk`, { headers: bearer })).status, 404);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stop rejects foreign, unauthenticated and malformed requests before invoking the lifecycle hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "phoneuse-stop-api-"));
  let stops = 0;
  const bridge = await createBridge({
    stateDir: root,
    phonePort: 0,
    adminPort: 0,
    host: "127.0.0.1",
    onShutdown: () => {
      stops += 1;
    },
  });
  const url = `${bridge.adminAddress.url}/api/stop`;
  const headers = {
    authorization: `Bearer ${bridge.state.adminToken}`,
    "content-type": "application/json",
  };

  try {
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { ...headers, origin: "https://foreign.example" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(url, { method: "POST", headers, body: '{"unexpected":true}' })).status,
      400,
    );
    assert.equal((await fetch(url, { method: "POST", headers, body: "invalid" })).status, 400);
    await delay(10);
    assert.equal(stops, 0);
    assert.equal((await fetch(url, { method: "POST", headers, body: "{}" })).status, 200);
    await delay(10);
    assert.equal(stops, 1);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
