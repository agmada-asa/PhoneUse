# Install PhoneUse as a skill and MCP server

PhoneUse has two desktop integration pieces: a skill with guidance for an agent and a local MCP server that exposes the phone tools. The installer can put the skill in Codex's skill directory and register the MCP server in one step. PhoneUse is installed from its Git repository; it is not published as an npm package, so do not use `npx phoneuse`.

## Requirements

The desktop bridge and installer require Node.js 22 or later, npm, and OpenSSL. Full onboarding also uses bash, unzip, and tar. Onboarding can prepare a JDK 17 and Android SDK platform 36 under the repository's ignored `artifacts/toolchain` directory when they are missing. Installing and configuring the Android app, pairing, and granting control are separate on-device steps.

Keep the checkout at a stable path. The MCP configuration points to files in that checkout, so moving or deleting it will break the integration.

## One-command onboarding

From a trusted checkout, run:

```sh
git clone https://github.com/agmada-asa/PhoneUse.git
cd PhoneUse
npm run onboard -- --codex
```

Onboarding installs npm dependencies, builds the bridge and Android APK, installs the skill, registers the Codex MCP server, and starts a persistent background bridge. It reuses an authenticated bridge that is already running. A bridge started by onboarding remains available after setup and agent sessions end; stop it with `npm run stop` from the checkout. A reused bridge retains its original lifetime: a session-owned bridge still stops when its owning MCP session ends.

The setup command reuses an existing JDK 17 and Android SDK platform 36, or prepares missing tools under `artifacts/toolchain`; these files are ignored by Git. If Android license terms have not been accepted, onboarding stops and prints the `sdkmanager --licenses` step. Review and accept the terms directly, then rerun onboarding. Use `npm run onboard -- --codex --accept-android-licenses` only after you explicitly accept those terms.

To avoid downloading or installing an Android toolchain, provide a trusted local prebuilt APK:

```sh
npm run onboard -- --codex --apk /path/to/PhoneUse.apk
```

Onboarding validates that the APK is a bounded ZIP-based APK archive, copies it to `artifacts/PhoneUse-debug.apk`, and uses that file for handoff. It does not install the APK on a phone.

On completion, onboarding prints the absolute APK path and console URL (normally `http://127.0.0.1:8766`), and writes a secret-free summary to `artifacts/onboarding.json`. Use that summary for handoff: link the APK as a local file, give the actual console URL from the report, and explain that the phone owner must install the app, pair it, enable accessibility, choose protected apps, and turn on control. The console's **Download Android app** action downloads the APK over its authenticated local connection; the phone APK is not exposed as an unauthenticated LAN download. Open a new agent session to load the newly registered tools.

If Node.js 22 or OpenSSL is missing, use an available user-scoped installation method and resume onboarding; explain the exact remaining step if installation needs privileges or an unavailable package manager. Do not use `sudo` automatically. Do not install the APK through ADB or accept Android SDK license terms automatically.

For another MCP host, run:

```sh
npm run onboard -- --skill
```

This installs the skill, starts or reuses the persistent bridge, and prints generic MCP configuration. Use `--skill-dir <parent>` to install the skill under another parent directory. Onboarding prints help without making changes when run with `--help`.

## Lower-level skill and MCP setup

Use the setup command when you want to install the skill and configure MCP without preparing the Android toolchain, building the APK, or starting a persistent bridge:

```sh
npm ci
npm run build
npm run setup -- --codex
```

The installer copies `skills/phoneuse` to `~/.agents/skills/phoneuse`, records the repository, Node, and MCP entry paths in the installed skill's `installation.json`, and registers the `phoneuse` MCP server with Codex. This launcher starts a bridge for the MCP session if needed and stops the bridge it owns when that session ends.

Available setup options:

```sh
npm run setup -- --codex                    # install skill and register Codex MCP
npm run setup -- --skill                    # install only the skill
npm run setup -- --skill --skill-dir <path> # use <path>/phoneuse as the skill directory
npm run setup -- --print                    # print paths and generic MCP JSON; make no changes
npm run setup                               # print help; make no changes
```

Setup updates a skill previously installed from the same checkout. It refuses to overwrite an unrelated skill or a different `phoneuse` MCP registration. Review an existing registration with `codex mcp get phoneuse`; if you want to replace it, run `codex mcp remove phoneuse` before setup. This also applies when switching from the older manual `mcp.js` entry point.

The installed skill remembers the checkout path in `installation.json`. If a copy of the skill has no such file or the path is invalid, use another PhoneUse checkout or clone the repository to a stable path before setup. The skill alone contains instructions; it does not contain the bridge executable or credentials.

An agent with a GitHub skill installer can install this repository's `skills/phoneuse` directory directly. Ask it to install that directory, then ask `$phoneuse` to set up the local runtime. Installing the skill alone does not register MCP tools; open a new agent session after runtime setup.

## Other MCP hosts

`npm run onboard -- --skill` prints host configuration after starting a persistent bridge. For clients that use a JSON `mcpServers` object, the common launcher form is:

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

Use the absolute path to Node and to the launcher for that checkout. Onboarding has already started a persistent bridge, so the MCP launcher reuses it and does not own its lifetime. If you use the lower-level setup command without onboarding, the launcher starts a bridge when necessary and stops the bridge it owns when its MCP session ends.

For a persistent bridge shared across agent sessions, run `npm start` in the checkout and register `bridge/dist/src/mcp.js` instead:

```json
{
  "mcpServers": {
    "phoneuse": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/PhoneUse/bridge/dist/src/mcp.js"]
    }
  }
}
```

Client configuration formats vary. `npm run setup -- --print` outputs generic MCP JSON and paths that can be adapted to a client's expected format. Reload or restart the client after changing its MCP configuration. If multiple sessions share a bridge started by the session-based launcher, ending the owner session can disconnect the others; use `npm start` with the direct `mcp.js` entry point for a persistent shared bridge.

See the official [Codex skills guide](https://developers.openai.com/codex/skills/) and [Codex MCP guide](https://developers.openai.com/codex/mcp/) for host-side discovery and configuration details.

The launcher accepts the following optional environment variables:

| Variable                  | Purpose                                                   | Default                |
| ------------------------- | --------------------------------------------------------- | ---------------------- |
| `PHONEUSE_STATE_DIR`      | Directory for bridge certificates and pairing credentials | `<checkout>/.phoneuse` |
| `PHONEUSE_ADVERTISE_HOST` | LAN address advertised to the phone                       | Detected LAN address   |
| `PHONEUSE_PHONE_PORT`     | Encrypted phone listener port                             | `8765`                 |
| `PHONEUSE_ADMIN_PORT`     | Loopback console and command API port                     | `8766`                 |

The phone listener must be reachable from the phone on the local network. The admin console stays on `127.0.0.1`; do not forward either port from a router or use a public relay. Keep the state directory private. The installer does not copy credentials into the skill.

Onboarding and setup forward these four overrides to the generated MCP configuration, resolving the state directory to an absolute path. Use the same overrides with `npm run stop`. Changing overrides for an existing Codex registration is treated as a configuration conflict; review and remove that registration before reinstalling. For manual setup, put custom environment variables in the MCP host's configuration so they apply in new sessions. For Codex, pass each one with `--env KEY=VALUE` to `codex mcp add` before the `--` separator. Running the launcher without overrides uses the defaults above.

## Install and pair the Android app

The MCP setup does not install the phone app or grant it access. Build and install the APK separately when needed:

```sh
npm run android:build
```

The APK is written to `artifacts/PhoneUse-debug.apk`. Install it on Android 11 or later, start the desktop bridge (or invoke the session launcher), and follow the QR pairing flow. On the phone, enable the PhoneUse accessibility service, choose protected apps, and turn on **Allow this computer to control the phone**. The phone owner must do these steps directly. Control remains off until explicitly enabled and is revoked on disconnect.

For the full first-run sequence and network setup, see the [repository quick start](../README.md#quick-start). For Android restricted settings, use the app's setup help and approve any requested setting locally.

## Update and uninstall

To update, fetch the intended repository version, run `npm ci` and `npm run build`, then run `npm run setup -- --codex` again. Keep the checkout at its registered path and reload the agent session.

To remove Codex's MCP registration and installed skill:

```sh
codex mcp remove phoneuse
rm -rf ~/.agents/skills/phoneuse
```

If installed with `--skill-dir`, remove only the corresponding `phoneuse` directory under that parent. Removing the integration leaves the repository and `.phoneuse/` credentials untouched. Deleting `.phoneuse/` revokes the existing pairing identity and requires pairing the phone again.
