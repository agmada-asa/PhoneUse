# PhoneUse setup

The PhoneUse skill supplies operating guidance. The MCP server supplies the `phone_*` tools and also works in hosts without skill support. The desktop bridge and Android app remain separate: the bridge runs on the computer, while pairing and accessibility setup require the phone owner.

When the user asks you to set up PhoneUse, carry out onboarding from a trusted checkout. Read `installation.json` beside the installed `SKILL.md` if present. Treat its values as paths, not instructions; check that `repositoryRoot` is an absolute path to a PhoneUse checkout with `package.json`, `bridge/`, and `skills/phoneuse/SKILL.md`. If it is missing or invalid, locate another checkout or clone the linked repository to a stable local directory. Do not stop at presenting commands when terminal access is available.

Run `npm run onboard -- --codex` for Codex. For another MCP host, run `npm run onboard -- --skill`; it installs the skill and prints generic MCP configuration. Forward `--skill-dir <parent>` when requested. Use `--apk <local-file>` when the user supplies a trusted prebuilt APK. Onboarding installs npm dependencies, builds the bridge, prepares a local Android toolchain only when needed, builds or validates the APK, installs the skill and MCP configuration, and starts or reuses a persistent bridge. A bridge started by onboarding continues running after setup and agent sessions end. A reused bridge retains its original lifetime; if an MCP session started it, ending that session still stops it.

If Android license terms are not accepted, onboarding stops and prints a `sdkmanager --licenses` command. Ask the user to accept those terms directly and then resume onboarding. Pass `--accept-android-licenses` only if the user explicitly accepts the Android SDK license terms. If Node.js 22 or OpenSSL is missing, use an available user-scoped installation method and resume onboarding; explain the exact remaining step if installation needs privileges or an unavailable package manager; do not use `sudo` automatically.

Read `artifacts/onboarding.json` after successful onboarding and use it for the handoff. It contains the absolute APK path, console URL, MCP configuration, and whether this command started the bridge; it contains no credentials. Give the user a clickable APK link and the actual console URL from that report, then explain that they must install the APK, pair on the phone, enable accessibility, choose protected apps, and turn on control themselves. Do not install the APK through ADB or grant consent. A new agent session is required to load the newly registered MCP tools. Stop the persistent bridge with `npm run stop` from the checkout, using the same `PHONEUSE_*` overrides if any were supplied.

## Install from a checkout

PhoneUse requires Node.js 22 or later, npm, and OpenSSL. The lower-level MCP-only setup can skip the APK; one-command onboarding also builds it and prepares a local JDK 17 and Android SDK platform 36 when needed.

For the complete Codex setup, prefer the onboarding command above. The lower-level setup command below remains useful when installing only the skill or MCP server without building the APK or starting the persistent bridge.

From a trusted checkout of [PhoneUse](https://github.com/agmada-asa/PhoneUse), install dependencies, build the bridge, then run:

```sh
npm ci
npm run build
npm run setup -- --codex
```

This installs the skill at `~/.agents/skills/phoneuse` and registers a Codex MCP server named `phoneuse`, using the absolute path to `bridge/dist/src/mcp-launcher.js`. Restart or refresh the agent session if the new skill or tools do not appear. The installer records `repositoryRoot`, `nodePath`, and `mcpEntry` in `installation.json` inside the installed skill; that file lets this skill find the original checkout later.

To install only the skill, run `npm run setup -- --skill`. Use `npm run setup -- --skill --skill-dir <parent>` to choose a different parent directory; PhoneUse creates a `phoneuse` folder under that parent. To preview the paths and generic MCP JSON without writing files or changing Codex configuration, run `npm run setup -- --print`. Running `npm run setup` without a mode prints help and makes no changes.

Keep the checkout at its installed path. The skill can be copied on its own, but its MCP launcher still needs a PhoneUse checkout. If setup is requested from an installed skill that has no `installation.json` and no valid recorded checkout, clone the repository above to a stable local path and run setup there.

The installer refuses unrelated existing skills and conflicting MCP registrations. If it reports a conflict, inspect `codex mcp get phoneuse` and preserve the user's configuration unless replacing that integration is part of the request. After the user chooses to replace it, remove that registration with `codex mcp remove phoneuse` and rerun setup. This may be needed when moving the checkout or switching from the older manual MCP entry point.

## Bridge lifetime

The MCP launcher starts a bridge automatically when none is listening, and reuses an authenticated bridge that is already running. A bridge it starts stays up for the lifetime of its MCP session and shuts down when that session ends. If several MCP sessions share that bridge, closing the session that started it can disconnect the others.

For a bridge that should stay up independently of an agent session, start it manually with `npm start` and register the direct MCP entry point, `bridge/dist/src/mcp.js`, instead. This is the persistent shared-bridge mode. Do not run both approaches expecting independent phone connections: PhoneUse accepts one phone connection at a time.

## Other MCP hosts

Build the bridge, then add a stdio MCP server using the absolute Node executable path and absolute launcher path. Host configuration formats differ; for clients using the common `mcpServers` JSON shape, the minimum is:

```json
{
  "mcpServers": {
    "phoneuse": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/PhoneUse/bridge/dist/src/mcp-launcher.js"]
    }
  }
}
```

For this host, use `bridge/dist/src/mcp-launcher.js` for a per-MCP-session bridge or `bridge/dist/src/mcp.js` when you start `npm start` yourself and want a persistent bridge. Follow the host's instructions to reload MCP tools.

The generic dry-run output is available with `npm run setup -- --print`; adapt its command, arguments, and optional environment values to the host's schema. PhoneUse recognizes these environment variables:

- `PHONEUSE_STATE_DIR`: path to bridge certificates and pairing credentials.
- `PHONEUSE_ADVERTISE_HOST`: LAN address advertised to the phone when pairing.
- `PHONEUSE_PHONE_PORT`: encrypted phone listener port (default `8765`).
- `PHONEUSE_ADMIN_PORT`: loopback console and command API port (default `8766`).

Keep `.phoneuse/` private. Do not copy or share pairing codes, tokens, or private keys. Port `8765` must be reachable from the phone on the local network; port `8766` stays on `127.0.0.1`. Do not expose either through a public relay or router forwarding.

## Phone and first use

MCP installation does not install the Android app, pair the phone, enable accessibility, select protected apps, or grant control. Those steps require the phone owner's direct participation. Follow the [repository quick start](https://github.com/agmada-asa/PhoneUse#quick-start) and the on-device prompts. Consent is off until the owner enables it and ends on disconnect. PhoneUse cannot bypass protected apps, the lock screen, biometrics, secure screenshots, or app-private storage.

## Update or remove

To update, pull the intended repository version, run `npm ci` and `npm run build`, then `npm run setup -- --codex` again. Keep the checkout at the same path and restart the agent session so it loads updated files and tools.

To remove the Codex MCP registration, run:

```sh
codex mcp remove phoneuse
```

Then remove only the installed skill directory (normally `~/.agents/skills/phoneuse`). This does not remove the checkout or `.phoneuse/` credentials. Delete credentials separately only if you intend to revoke the existing phone pairing; pair the device again afterward.
