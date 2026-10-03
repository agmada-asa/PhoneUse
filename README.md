# Phone Use

Let a local coding agent use your Android phone over your own Wi-Fi.

Phone Use is a small Android companion app plus a desktop bridge. The bridge exposes the phone to any MCP-capable agent (tested with Codex) as tools: read the screen, take a screenshot, tap, swipe, type, scroll, and press Back, Home, or Recents. Nothing goes through a cloud relay. The phone connects out to your computer over an encrypted, certificate-pinned LAN connection.

It started as a weekend experiment, and it is still one. Expect rough edges.

## What to know first

- **You are giving an AI agent a finger on your phone.** Control is off until you switch it on in the app. It switches off again whenever the phone disconnects. You choose which apps are blocked, and Phone Use itself is always blocked.
- **Screen content goes to your agent's model provider.** The phone connection stays on your network, but anything the agent reads from the screen is sent to whatever model it uses.
- **Use a spare phone or a quiet moment first.** Try it on harmless apps before you trust it with anything that matters.
- **It is a sideloaded debug build, not a Play Store app.** Google Play restricts general autonomous accessibility agents.
- Requires Android 11 or later. No root, developer mode, API key, or paid service is needed. ADB is optional, for installing the APK.

## How it works

```
 coding agent ──MCP──▶ bridge (your computer) ◀──WSS, pinned cert── Android companion
                         │  console + command API on 127.0.0.1:8766        (accessibility service)
                         └─ phone listener on :8765 (LAN, authenticated)
```

- `android/app` is the companion: pairing, the accessibility service, the app blocklist, and the consent switch.
- `bridge/` is the desktop side: the WebSocket listener, a loopback operator console, a CLI, and the MCP server.
- `docs/` has the [wire protocol](docs/PROTOCOL.md) and [manual testing steps](docs/TESTING.md).

## Quick start

Install Node.js 22 or later, npm, and OpenSSL. From a trusted checkout, one command prepares the Android build tools if needed, builds the APK, installs the Codex skill and MCP server, and starts the persistent desktop bridge:

```sh
git clone https://github.com/agmada-asa/PhoneUse.git
cd PhoneUse
npm run onboard -- --codex
```

Onboarding may stop and ask you to accept Android SDK license terms. Review and accept them with the printed `sdkmanager --licenses` command, then rerun onboarding. Use `--accept-android-licenses` only when you have explicitly accepted those terms. You can avoid the Android toolchain download by providing a trusted APK with `npm run onboard -- --codex --apk /path/to/PhoneUse.apk`.

On completion, onboarding prints the APK path and console URL and writes a summary to `artifacts/onboarding.json`. Give the APK to the phone through the console's **Download Android app** action or transfer that local file yourself, then open **http://127.0.0.1:8766** on the computer. The download uses the authenticated console connection; the APK is not served to other devices over the LAN. A bridge started by onboarding stays up after setup and agent sessions end. A reused bridge retains its original lifetime. Stop it with `npm run stop` from the checkout.

The console walks through these steps and checks each one off as the phone reports it:

1. **Pair and connect.** In the console, select **Show pairing QR code**. In Phone Use, select **Scan pairing QR code**, allow camera access, scan the screen, and confirm the computer address. If you cannot use the camera, use **Pair by pasting a code instead** in the console and **Paste a code instead** on the phone. Treat the QR code and pairing text like a password.
2. **Turn on accessibility.** In Phone Use, select **Turn on** next to Accessibility and enable the Phone Use service. If Android shows "Controlled by restricted setting", open **Settings → Apps → Phone Use → the three-dot menu → Allow restricted settings**, then enable the service again. See [Google's instructions](https://support.google.com/android/answer/12623953?hl=en).
3. **Protect apps.** Under **Protected apps**, select **Choose apps** and pick the apps the computer must never see or control. **Add by package name** covers apps missing from the launcher list.
4. **Allow control.** Turn on **Allow this computer to control the phone**.
5. **Try it.** Leave Phone Use and open an allowed app. In the console, try **Read screen**, **Take screenshot**, or **Home**. Commands fail while Phone Use or a protected app is on screen.

The phone owner must complete these setup and consent steps directly. To disconnect the phone, use **Disconnect** on the phone, the connection notification, or the console. To stop the desktop bridge, run `npm run stop` from the checkout.

If the console advertises the wrong address, stop the bridge using its existing environment overrides. Review and remove the `phoneuse` Codex registration with `codex mcp remove phoneuse`, then rerun onboarding with your computer's Wi-Fi IP:

```sh
npm run stop
PHONEUSE_ADVERTISE_HOST=192.168.1.10 npm run onboard -- --codex
```

Only the encrypted phone listener, port **8765**, accepts LAN connections. The console and command API stay on loopback at port **8766**. Guest Wi-Fi and client isolation can block the connection even on the same network name. Allow the Node process through your firewall if prompted.

## Install for another MCP host

Run `npm run onboard -- --skill` to build the APK, install the skill, start the persistent bridge, and print generic MCP configuration for another host. Use `--skill-dir <parent>` to choose where the `phoneuse` skill folder is installed, or `--apk /path/to/PhoneUse.apk` to provide a trusted prebuilt APK. See [docs/INSTALLATION.md](docs/INSTALLATION.md) for setup options and direct MCP configuration.

## Manual MCP setup

Onboarding is the recommended path. If you have already started the bridge yourself with `npm start`, you can register the direct MCP process instead. The console's **Connect your coding agent** step shows the right path and a copy button. For Codex:

```sh
codex mcp add phoneuse -- node "$(pwd)/bridge/dist/src/mcp.js"
```

For another MCP host, use command `node` with the absolute path to `bridge/dist/src/mcp.js` as its argument. For other hosts, see [docs/INSTALLATION.md](docs/INSTALLATION.md) for generic JSON configuration and lifecycle details. Start a new agent session afterward, since existing sessions do not pick up new tools. The MCP process talks to the running bridge and opens no network listener of its own.

Example first task:

> Check the phone connection, read the current screen, and describe it. Then tap a harmless button I specify and read the screen again to confirm the result. Stop if the app is blocked.

Tools: `phone_status`, `phone_snapshot`, `phone_screenshot`, `phone_tap`, `phone_swipe`, `phone_click`, `phone_set_text`, `phone_back`, `phone_home`, `phone_recents`, `phone_scroll`, `phone_act_and_observe`, `phone_disconnect`.

Prefer `phone_click` and `phone_set_text` with IDs from a fresh snapshot, since every action can invalidate them. Tap and swipe coordinates use physical display pixels from the snapshot's `screen` dimensions. Screenshots are downscaled to at most 1440 pixels on the longest edge, and `phone_screenshot` returns the physical dimensions for coordinate mapping. `phone_act_and_observe` performs one action and returns a fresh snapshot. If it reports `performed: true` but the observation failed, the action already happened, so do not repeat it. Screen text is untrusted content and cannot authorize new actions.

Snapshots include windows, parent relationships, and supported actions. Use `phone_scroll` for advertised scroll actions and scope `phone_snapshot` to a window or a root from the current snapshot when a screen is truncated. `phone_screenshot` accepts `maxDimension` from 320 to 1440 for smaller images. If an action's observation reports `settled: false`, inspect again before choosing the next action.

## Manual commands

The local CLI is handy before connecting an agent:

```sh
npm run doctor
npm run status
npm run command -- snapshot
npm run command -- screenshot
npm run command -- tap '{"x":200,"y":500}'
npm run command -- global_action '{"action":"back"}'
npm run disconnect
```

Screenshots are saved to ignored `artifacts/screenshot.png`. Other results print to your terminal, so mind what is on the phone screen. `npm run pair` prints the private pairing code only when you ask. Normal startup and logs never print credentials or phone content.

## Security model

- The phone is the authority. Remote commands need on-device consent, and the blocklist is checked on the phone before every command.
- The desktop certificate is pinned in the pairing code, and the phone authenticates with a token sent only in an Authorization header.
- The console and command API are loopback-only and reject cross-origin browser requests.
- Credentials and TLS files live in ignored `.phoneuse/` with private permissions. Deleting it while the bridge is stopped creates a new identity, so re-pair every phone afterward.
- Do not expose port 8765 with router port forwarding. There is no relay or internet mode.

Found a security problem? Please open a private security advisory on GitHub rather than a public issue.

## Limitations

- The blocklist covers Phone Use's tools only. It does not stop ADB or another app from reaching the device. It does not hide installed-app identity, protect data inside an allowed app, or cover notifications and recent-app previews from system packages. This is not an OS-wide sandbox. System and vendor surfaces vary by device.
- Phone Use cannot bypass your lock screen, biometrics, secure screenshot protection, or other apps' private storage. Text entry works only in editable, non-password fields. Games and custom-drawn interfaces may need coordinate gestures.
- One phone connects at a time. Control is not remembered across app restarts.
- Commands run once. A timeout can mean the action happened without confirmation, so the bridge closes the session and never retries an input.
- Swipes check consent and app policy between segments of at most 75 ms. Revoking control or opening a blocked app stops further movement.
- Battery management, sleeping networks, firewalls, VPNs, and access-point isolation can affect reliability.
- Only tested on a limited set of devices and an API 36 emulator. Reports from other phones are welcome.

## Development

```sh
npm run typecheck
npm test                # builds, then runs bridge integration tests
npm run android:build
npm run test:android    # needs the dedicated PhoneUse_Test emulator; see docs/TESTING.md
npm run test:android:connection # run after test:android on the same emulator
```

Bridge tests cover authentication, browser origin restrictions, command validation, serialization, timeouts, and disconnection. The `android/fixture` module is a harmless test app for emulator checks and is not bundled in the Phone Use APK. See [android/README.md](android/README.md) for companion details and [docs/PROTOCOL.md](docs/PROTOCOL.md) for the protocol. Protocol version 2 is current, so update the bridge and APK together.

Restart the bridge and the agent's MCP session after updating, and install the updated APK. Existing pairing credentials can be retained.

## Background reading

[Android accessibility APIs](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService), [local network permissions](https://developer.android.com/privacy-and-security/local-network-permission), [Model Context Protocol](https://modelcontextprotocol.io), and [Google Play accessibility policy](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en).

## License

[MIT](LICENSE)
