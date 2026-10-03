# PhoneUse Android companion

The Android app is the phone-side consent and accessibility boundary for PhoneUse. Pairing credentials and the app blocklist stay in private phone preferences. Control consent exists only in process memory and resets after a process restart, a new connection started from the app, a local disconnect, or an accessibility interruption. `dev.phoneuse.app` is always blocked from remote commands.

## Build

Install Android SDK platform 36 and Java 17, then run from this directory:

```sh
./gradlew :app:assembleDebug
```

The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`. The wrapper uses Gradle 9.3.1 and the Android plugin uses 9.1.0.

## Phone setup

Install the APK, open PhoneUse, then scan the pairing QR code shown by the computer, open it with an external QR scanner that supports app links, or paste its pairing code. Scanned and opened credentials are checked and the computer address is shown for confirmation before saving. If an external scanner cannot open app links, use PhoneUse's in-app scanner. Saving connects with control disabled. Enable PhoneUse under Android Accessibility settings; use Connect if the connection is stopped. Enable the control switch only when the phone is ready for a remote session. Use Disconnect in the app or its ongoing notification to stop the connection.

If Android says PhoneUse is "Controlled by restricted setting," open **Setup help** in PhoneUse and choose **Open app info**. On the app-info screen, tap the three-dot menu and choose **Allow restricted settings**, then return to Accessibility settings and enable PhoneUse. Android requires this manual step for some sideloaded apps; PhoneUse cannot bypass it.

Scanning requests camera access from Android. If camera access is denied or the scan is canceled, allow camera access in app permissions and scan again, or paste the pairing code instead.

Choose blocked apps on the phone before enabling control. Remote requests are denied whenever a visible accessibility window belongs to a blocked app or PhoneUse itself. Screen capture and gestures require the Android accessibility service capabilities declared in `src/main/res/xml/accessibility_service.xml`.

Android exposes only retrievable accessibility window roots. The app fails closed when a visible window has no readable root or package, though Android system and vendor surfaces can limit which windows are exposed. Accessibility access does not grant access to private app storage or secure biometric screens.

The transport is outbound WSS. The app checks the pinned certificate's SHA-256 DER fingerprint and validity dates, and sends the pairing token only as an Authorization header. It does not log pairing material or screen contents.

The companion uses wire protocol 2. Install the updated APK and restart the updated bridge together; saved pairing credentials retain their version 1 format. Lost transport revokes control before reconnecting. Newly suitable networks can wake a pending retry, while rejected credentials, changed certificates, and invalid addresses stop retries and show repair instructions.

Accessibility snapshots bound child queries and traversal time, report truncation, and include allowed windows, parent relationships, and advertised actions. Window and current-node scopes support closer inspection. Semantic scrolling and one-action observation avoid guessed gestures and a separate observation call for common navigation steps. A successful action stays successful when its later observation is blocked; never repeat it because the observation failed.
