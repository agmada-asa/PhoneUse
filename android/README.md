# PhoneUse Android companion

The Android app is the phone-side consent and accessibility boundary for PhoneUse. Pairing credentials and the app blocklist stay in private phone preferences. Control consent exists only in process memory and resets after a process restart, a new connection started from the app, a local disconnect, or an accessibility interruption. `dev.phoneuse.app` is always blocked from remote commands.

## Build

Install Android SDK platform 36 and Java 17, then run from this directory:

```sh
./gradlew :app:assembleDebug
```

The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`. The wrapper uses Gradle 9.3.1 and the Android plugin uses 9.1.0.

## Phone setup

Install the APK, open PhoneUse, paste and save the pairing code from the computer, then enable PhoneUse under Android Accessibility settings. Return to PhoneUse and tap Connect. Enable the control checkbox only when the phone is ready for a remote session. Use Disconnect in the app or its ongoing notification to stop the connection.

Choose blocked apps on the phone before enabling control. Remote requests are denied whenever a visible accessibility window belongs to a blocked app or PhoneUse itself. Screen capture and gestures require the Android accessibility service capabilities declared in `src/main/res/xml/accessibility_service.xml`.

Android exposes only retrievable accessibility window roots. The app fails closed when a visible window has no readable root or package, though Android system and vendor surfaces can limit which windows are exposed. Accessibility access does not grant access to private app storage or secure biometric screens.

The transport is outbound WSS. The app checks the pinned certificate's SHA-256 DER fingerprint and validity dates, and sends the pairing token only as an Authorization header. It does not log pairing material or screen contents.
