# Test PhoneUse

Run `npm test` for bridge integration checks and `npm run android:build` for an installable APK. Device behavior requires an emulator or phone; compilation alone does not establish it.

The initial build was verified on 3 October 2026: bridge typecheck/build and all six integration tests passed; Android debug build and lint passed; all 16 automated behavior checks passed on the isolated API 36 emulator, including a populated password field, blocked commands, interrupted swipes, and deliberate disconnect. Physical-phone and vendor-specific checks below remain for the operator.

## Harmless emulator fixture

The test-only `android/fixture` module contains a text field, a password field with the harmless value `fixture-only-secret`, an increment button, scroll list, and a secure screen. It has no network access and is a separate APK.

```sh
cd android
ANDROID_HOME="$HOME/Library/Android/sdk" JAVA_HOME="$(/usr/libexec/java_home -v 17)" ./gradlew :fixture:assembleDebug
adb -s <emulator-serial> install -r fixture/build/outputs/apk/debug/fixture-debug.apk
```

Pair the companion, enable accessibility and control, and open **PhoneUse test screen**. Perform the checks below. Never run tests on personal apps or assume that a connected device is disposable.

For the automated harness, start a dedicated `PhoneUse_Test` AVD on port 5560 with the API 36 system image, build both APKs, then run `npm run test:android` from the repo root. The harness verifies the AVD name and refuses every other device. It resets only the companion and fixture on that disposable emulator, enables their test setup, and creates isolated bridge credentials under ignored `artifacts/emulator-state`. It does not operate the connected physical phone. The fixture screenshot is saved locally as `artifacts/emulator-fixture.png` for visual verification.

Android's `uiautomator dump` temporarily interrupts accessibility services during local setup. The harness lets services restore and explicitly re-enables control after configuring the blocklist. Remote behavior checks use PhoneUse's own tools.

## Behavior checklist

- Control disabled: the bridge refuses observation and input.
- Fresh snapshot: package, physical display size, bounded node list, IDs and bounds match the visible fixture.
- Text entry: set the regular field using a fresh snapshot; capture again and confirm the text. The password node must have no password content and must refuse text entry.
- Semantic click: click Increment counter, then capture again and confirm the count increased exactly once.
- Tap: tap the center of the same button using physical display pixels, then verify one increment.
- Stale node: use an earlier snapshot after the UI changes. Expect `STALE_SNAPSHOT` and no action.
- Swipe: swipe the list and capture the changed visible content.
- Interrupted swipe: open PhoneUse locally during a long swipe. The command must refuse to continue and release its existing pointer. Swipes recheck consent, deadline, and visible-window policy between segments of at most 75 ms; Android callback scheduling can add latency.
- Screenshot: receive a real PNG with valid dimensions. The secure fixture screen must fail or conceal protected pixels, following platform behavior, never reveal the secure content.
- Navigation: Back, Home and Recent apps execute and show the expected destination.
- Blocklist: add the fixture through the phone's picker. Observation, screenshot, click, tap, swipe, text entry and global actions must all fail while it is visible. Leave it locally to resume other apps.
- Self protection: PhoneUse pairing, consent and blocklist controls cannot be read or changed through remote commands.
- Split-screen: when supported by the device, keep a blocked app in either pane. All commands must fail.
- Disconnect: stop from each endpoint and the notification. Status becomes disconnected, pending commands fail, and deliberate disconnect does not automatically reconnect.
- Process restart: consent starts off. Re-enabling accessibility or reconnecting must not silently grant control.
- Pin mismatch: a pairing code with a different certificate fingerprint must fail TLS connection. Unknown credentials must fail authorization.

## Physical phone checks

Repeat pairing and basic actions on your Android model. Verify app-picker coverage, notification visibility, foreground service behavior, keyboard text entry, screen scaling, rotation, and recovery after Wi-Fi changes. Verify the blocklist against the particular apps you intend to protect, including split-screen and overlays if you use them.

App windows hidden from accessibility cannot provide reliable ownership information. Treat device-specific failures as a reason to keep that workflow disabled until its boundary is understood.
