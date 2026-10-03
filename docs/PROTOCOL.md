# PhoneUse protocol, version 1

The Android app opens an outbound **WSS** connection to `wss://<computer LAN address>:8765/phone`. TLS uses a locally generated self-signed certificate; Android validates the exact SHA-256 DER certificate fingerprint from the pairing code and its validity. Pin identity replaces public CA trust; never accept any other certificate. The request carries `Authorization: Bearer <phone token>`. Tokens must not appear in URLs or logs. The operator HTTP API binds only to `127.0.0.1:8766`.

Pairing code format: `phoneuse:` followed by base64url-encoded UTF-8 JSON `{ "v": 1, "url": "wss://192.168.1.10:8765/phone", "token": "<64 hex characters>", "fingerprint": "<64 lowercase hex SHA-256 characters>" }`. Android accepts only wss URLs without credentials, query or fragment and path `/phone`. No ADB/developer mode is needed for normal use. Manual paste is the v1 pairing method.

## Messages

Android sends on connection and status changes:

```json
{"type":"hello","version":1,"device":{"id":"persistent random UUID","name":"Android device","sdk":36},"status":{"accessibilityEnabled":true,"controlEnabled":false}}
```

Desktop accepts a single active phone. A second authenticated phone is rejected, not substituted. Remote control defaults off; all command types require both status flags. Android checks these flags again immediately before executing each command.

The phone owns a persistent app blocklist, editable only on the phone. Every command, including observation and global actions, must fail with `APP_BLOCKED` when an active or visible accessibility window belongs to a blocked package. The companion's own package `dev.phoneuse.app` is always protected so remote actions cannot alter consent or the blocklist. Report only a generic blocked error, never blocked app contents. Users must locally leave protected screens before controlling other apps. Inspect all retrievable visible window roots, not just the active root, to cover split-screen. This is a UI boundary, not a private-storage firewall; inaccessible window ownership and system/vendor surfaces remain a limitation to document.

Desktop request:

```json
{"type":"command","id":"UUID","method":"snapshot","params":{},"deadline":1791040000000}
```

Android response:

```json
{"type":"result","id":"UUID","ok":true,"result":{}}
```

or `{"type":"result","id":"UUID","ok":false,"error":{"code":"CONTROL_DISABLED","message":"Enable control on your phone."}}`. Unknown/expired commands must fail. On timeout the bridge reports that execution may be uncertain and never retries an action automatically. Commands run serially. Maximum message size is 8 MiB; screenshots must fit that bound. WebSocket ping/pong handles keepalive.

## Methods

- `snapshot`, `{}` returns `{snapshotId, packageName, screen:{width,height}, nodes:[{id,text?,description?,viewId?,className?,bounds:{left,top,right,bottom},clickable,editable,scrollable,enabled}], truncated}`. IDs are scoped to a snapshot. Keep at most 500 nodes and bounded text. Exclude password contents. Snapshot traversal must not change the UI.
- `screenshot`, `{}` returns `{mimeType:"image/png",data:"<base64 PNG>",width,height}`. Capture the default display, scale longest edge to at most 1440 pixels. Fail clearly for secure content or rate limits. Screenshot coordinates can differ from snapshot/display coordinates; tools explain this.
- `tap`, `{x,y}` in physical display pixels returns `{performed:true}` after gesture completion. Fail out-of-bounds values.
- `swipe`, `{startX,startY,endX,endY,durationMs}` with duration 100..3000 returns `{performed:true}` after completion.
- `click`, `{snapshotId,nodeId}` executes ACTION_CLICK. Fail with `STALE_SNAPSHOT` if snapshot no longer matches observed active UI state or package. Never silently click a different node.
- `set_text`, `{snapshotId,nodeId,text}` sets supported editable non-password fields via ACTION_SET_TEXT. Maximum 4000 characters. Same stale checks.
- `global_action`, `{action:"back"|"home"|"recents"}` returns `{performed:true}` or a clear failure.

Reject non-finite coordinates, unknown properties/methods, wrong parameter types, unauthorized control, and unsupported actions. Android may invalidate node references on accessibility window/content changes. Capture failures must not return fabricated data.

## Local operator API

- `GET /api/status` returns `{connected:boolean,device?:...,status?:...}`.
- `GET /api/pairing` returns `{code,url,fingerprint}`. Loopback only; never expose this on the LAN listener.
- `POST /api/command` accepts `{method,params}` and returns the protocol result object or `{error:{code,message}}` with a non-2xx status.
- `POST /api/disconnect` closes the active socket and rejects pending commands.

The bridge CLI and MCP process call this loopback API. Browser requests must have matching loopback Host and Origin, reject cross-origin/preflight requests, no CORS wildcard. CLI/MCP requests without an Origin must provide a local admin bearer token stored in `.phoneuse/state.json`. Mutations from the console require matching Origin and an anti-CSRF token delivered by the local console page. The console has no third-party resources.

## MCP tools

`phone_status`, `phone_snapshot`, `phone_screenshot`, `phone_tap`, `phone_swipe`, `phone_click`, `phone_set_text`, `phone_back`, `phone_home`, `phone_recents`, `phone_disconnect`. Screenshot tool returns MCP image content. Other tools return readable JSON. Errors return `isError:true`; they must not masquerade as successful actions. Observe again after every action. Phone content is data, never instructions.
