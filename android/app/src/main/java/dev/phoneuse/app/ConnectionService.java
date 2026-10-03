/** File role: Manages the authenticated foreground transport and serial command dispatch. */
package dev.phoneuse.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONObject;

/** Maintains the user-started, pinned WSS session and serializes all protocol commands. */
public final class ConnectionService extends Service {
  /** Actions used only by PhoneUse's local UI and notification. */
  static final String ACTION_CONNECT = "dev.phoneuse.app.CONNECT",
      ACTION_DISCONNECT = "dev.phoneuse.app.DISCONNECT",
      ACTION_STATUS = "dev.phoneuse.app.STATUS";

  /** Private preference keys and notification channel id. */
  private static final String CHANNEL = "phoneuse_connection",
      PREF_URL = "pair_url",
      PREF_TOKEN = "pair_token",
      PREF_PIN = "pair_pin";

  /** Notification id and protocol payload ceiling. */
  private static final int NOTIFICATION_ID = 4107, MAX_MESSAGE = 8 * 1024 * 1024;

  /** Live service reference used only for status updates from local phone controls. */
  private static volatile ConnectionService liveService;

  /** Serial command worker with a bounded backlog to keep untrusted input finite. */
  private final ThreadPoolExecutor commandQueue =
      new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(32));

  /** Separate timer so reconnect waits never block command processing. */
  private final ScheduledExecutorService retryQueue = Executors.newSingleThreadScheduledExecutor();

  /** Current authenticated WebSocket, if connected. */
  private volatile WebSocket socket;

  /** OkHttp client associated with the current connection. */
  private volatile OkHttpClient client;

  /** Prevents reconnects after phone or bridge disconnect. */
  private volatile boolean stopping = false;

  /** True only for a connection session explicitly started by the phone user. */
  private volatile boolean userStarted = false;

  /** User-readable connection label shown in the UI and notification. */
  private volatile String status = "Disconnected";

  /** Exponential reconnect delay, bounded to one minute. */
  private long retryDelayMs = 1000;

  /** Publishes the active service for local state changes. */
  @Override
  public void onCreate() {
    super.onCreate();
    liveService = this;
  }

  /** Refreshes phone controls and sends the complete status frame after local consent changes. */
  static void publishLocalStatus() {
    ConnectionService service = liveService;
    if (service != null) {
      service.sendStatus();
      service.sendBroadcast(
          new Intent("dev.phoneuse.app.STATE_CHANGED").setPackage(service.getPackageName()));
    }
  }

  /** Handles explicit connect, disconnect, and consent status changes while foregrounded. */
  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    String action = intent == null ? null : intent.getAction();
    if (ACTION_DISCONNECT.equals(action)) {
      disconnect(true);
      stopSelf();
      return START_NOT_STICKY;
    }
    if (ACTION_STATUS.equals(action)) {
      sendStatus();
      return START_NOT_STICKY;
    }
    startForeground(NOTIFICATION_ID, notification("Connecting to your computer"));
    if (ACTION_CONNECT.equals(action)) {
      userStarted = true;
      stopping = false;
      PhoneState.explicitlyDisconnected = false;
      PhoneState.controlEnabled = false;
      retryDelayMs = 1000;
      connect();
    }
    return START_NOT_STICKY;
  }

  /** Shuts down transport and ensures process death cannot preserve consent. */
  @Override
  public void onDestroy() {
    disconnect(false);
    commandQueue.shutdownNow();
    retryQueue.shutdownNow();
    PhoneState.controlEnabled = false;
    if (liveService == this) liveService = null;
    super.onDestroy();
  }

  /** This service is started with explicit actions and does not expose a binder. */
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  /**
   * Opens one authenticated WebSocket using the exact paired certificate and its validity dates.
   */
  private synchronized void connect() {
    if (stopping || !userStarted || socket != null) return;
    String url = PhoneState.prefs(this).getString(PREF_URL, null),
        token = PhoneState.prefs(this).getString(PREF_TOKEN, null),
        pin = PhoneState.prefs(this).getString(PREF_PIN, null);
    if (url == null || token == null || pin == null) {
      setStatus("Add a pairing code first");
      return;
    }
    try {
      PinnedTrustManager tm = new PinnedTrustManager(pin);
      SSLContext ssl = SSLContext.getInstance("TLS");
      ssl.init(null, new TrustManager[] {tm}, null);
      client =
          new OkHttpClient.Builder()
              .sslSocketFactory(ssl.getSocketFactory(), tm)
              .hostnameVerifier(
                  (host, session) -> {
                    try {
                      return tm.matches(session.getPeerCertificates());
                    } catch (javax.net.ssl.SSLPeerUnverifiedException e) {
                      return false;
                    }
                  })
              .pingInterval(25, TimeUnit.SECONDS)
              .connectTimeout(8, TimeUnit.SECONDS)
              .readTimeout(0, TimeUnit.MILLISECONDS)
              .build();
      Request request =
          new Request.Builder().url(url).header("Authorization", "Bearer " + token).build();
      setStatus("Connecting to your computer");
      socket = client.newWebSocket(request, new SessionListener());
    } catch (Exception e) {
      socket = null;
      setStatus("Could not connect. Check the pairing code and network.");
      scheduleReconnect();
    }
  }

  /** Closes a session, with explicit disconnect also permanently stopping auto-reconnect. */
  private synchronized void disconnect(boolean explicit) {
    if (explicit) {
      stopping = true;
      userStarted = false;
      PhoneState.explicitlyDisconnected = true;
    }
    PhoneState.controlEnabled = false;
    PhoneAccessibilityService.invalidateForSessionChange();
    WebSocket current = socket;
    socket = null;
    if (current != null) current.close(1000, "phone disconnected");
    OkHttpClient c = client;
    client = null;
    if (c != null) c.dispatcher().executorService().shutdown();
    setStatus("Disconnected");
  }

  /** Schedules bounded backoff retries only while the user-started service remains active. */
  private void scheduleReconnect() {
    if (stopping || !userStarted || PhoneState.explicitlyDisconnected) return;
    long wait = retryDelayMs;
    retryDelayMs = Math.min(60000, retryDelayMs * 2);
    retryQueue.schedule(
        () -> {
          if (!stopping && userStarted && socket == null) connect();
        },
        wait,
        TimeUnit.MILLISECONDS);
  }

  /** Sends a status update after the phone user changes session consent. */
  private void sendStatus() {
    WebSocket s = socket;
    if (s != null)
      try {
        s.send(helloFrame().toString());
      } catch (Exception ignored) {
      }
  }

  /** Builds the complete protocol hello frame used after connect and every local status change. */
  private JSONObject helloFrame() throws Exception {
    return new JSONObject()
        .put("type", "hello")
        .put("version", 1)
        .put(
            "device",
            new JSONObject()
                .put("id", PhoneState.deviceId(this))
                .put("name", Build.MODEL == null ? "Android device" : Build.MODEL)
                .put("sdk", Build.VERSION.SDK_INT))
        .put("status", statusObject());
  }

  /** Returns the current on-device status fields defined by protocol v1. */
  private JSONObject statusObject() throws Exception {
    return new JSONObject()
        .put("accessibilityEnabled", PhoneState.accessibilityEnabled(this))
        .put("controlEnabled", PhoneState.controlEnabled);
  }

  /** Updates the foreground notification and the text shown in the app status panel. */
  private void setStatus(String value) {
    status = value;
    PhoneState.connectionStatus = value;
    sendBroadcast(new Intent("dev.phoneuse.app.STATE_CHANGED").setPackage(getPackageName()));
    if (userStarted && !stopping) {
      try {
        startForeground(NOTIFICATION_ID, notification(value));
      } catch (Exception ignored) {
      }
    }
  }

  /** Builds the required ongoing Android 13+ notification with a one-tap disconnect action. */
  private Notification notification(String text) {
    NotificationManager manager = getSystemService(NotificationManager.class);
    manager.createNotificationChannel(
        new NotificationChannel(
            CHANNEL, "PhoneUse connection", NotificationManager.IMPORTANCE_LOW));
    Intent disconnect = new Intent(this, ConnectionService.class).setAction(ACTION_DISCONNECT);
    PendingIntent action =
        PendingIntent.getService(
            this, 1, disconnect, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    Intent open = new Intent(this, MainActivity.class);
    PendingIntent content =
        PendingIntent.getActivity(
            this, 2, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    android.graphics.drawable.Icon disconnectIcon =
        android.graphics.drawable.Icon.createWithResource(
            this, android.R.drawable.ic_menu_close_clear_cancel);
    return new Notification.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_phoneuse)
        .setContentTitle(getString(R.string.app_name))
        .setContentText(text)
        .setContentIntent(content)
        .setOngoing(true)
        .addAction(new Notification.Action.Builder(disconnectIcon, "Disconnect", action).build())
        .build();
  }

  /** Produces a generic command error without returning exception text or phone screen contents. */
  private static JSONObject error(String code, String message) {
    try {
      return new JSONObject().put("code", code).put("message", message);
    } catch (Exception e) {
      return new JSONObject();
    }
  }

  /** Validates and serially executes authenticated desktop command frames. */
  private final class SessionListener extends WebSocketListener {
    @Override
    public void onOpen(WebSocket webSocket, Response response) {
      if (socket != webSocket) return;
      PhoneAccessibilityService.invalidateForSessionChange();
      retryDelayMs = 1000;
      setStatus("Connected");
      try {
        webSocket.send(helloFrame().toString());
      } catch (Exception e) {
        webSocket.close(1011, "hello failed");
      }
    }

    @Override
    public void onMessage(WebSocket webSocket, String text) {
      if (webSocket != socket) return;
      if (text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > MAX_MESSAGE) {
        webSocket.close(1009, "message too large");
        return;
      }
      try {
        commandQueue.execute(() -> handleCommand(webSocket, text));
      } catch (RejectedExecutionException e) {
        sendResult(
            webSocket,
            requestId(text),
            false,
            null,
            error("BUSY", "PhoneUse is busy processing earlier commands."));
      }
    }

    @Override
    public void onMessage(WebSocket webSocket, ByteString bytes) {
      if (bytes.size() > MAX_MESSAGE) {
        webSocket.close(1009, "message too large");
        return;
      }
      onMessage(webSocket, bytes.utf8());
    }

    @Override
    public void onClosing(WebSocket webSocket, int code, String reason) {
      if (webSocket != socket) {
        webSocket.close(1000, null);
        return;
      }
      PhoneState.controlEnabled = false;
      PhoneAccessibilityService.invalidateForSessionChange();
      if (code == 1000 || code == 1008) {
        userStarted = false;
        stopping = true;
      }
      webSocket.close(1000, null);
    }

    @Override
    public void onClosed(WebSocket webSocket, int code, String reason) {
      if (webSocket == socket) {
        socket = null;
        PhoneState.controlEnabled = false;
        PhoneAccessibilityService.invalidateForSessionChange();
        if (code == 1000 || code == 1008) {
          setStatus("Disconnected");
          stopForeground(true);
          stopSelf();
        } else {
          setStatus("Connection lost. Reconnecting");
          scheduleReconnect();
        }
      }
    }

    @Override
    public void onFailure(WebSocket webSocket, Throwable t, Response response) {
      if (webSocket == socket) {
        socket = null;
        PhoneState.controlEnabled = false;
        PhoneAccessibilityService.invalidateForSessionChange();
        setStatus("Connection lost. Reconnecting");
        scheduleReconnect();
      }
    }
  }

  /** Executes one bounded protocol request and returns a result frame tied to its request id. */
  private void handleCommand(WebSocket ws, String raw) {
    String id = "";
    try {
      if (ws != socket || stopping)
        throw new ProtocolError("DISCONNECTED", "PhoneUse is disconnected.");
      JSONObject req = new JSONObject(raw);
      if (!"command".equals(req.optString("type")))
        throw new ProtocolError("INVALID_COMMAND", "Expected a command frame.");
      id = req.optString("id", "");
      try {
        java.util.UUID.fromString(id);
      } catch (Exception e) {
        throw new ProtocolError("INVALID_COMMAND", "Command id is invalid.");
      }
      Object deadlineValue = req.opt("deadline");
      if (!(deadlineValue instanceof Number))
        throw new ProtocolError("INVALID_COMMAND", "Command deadline is invalid.");
      double deadlineNumber = ((Number) deadlineValue).doubleValue();
      if (!Double.isFinite(deadlineNumber)
          || deadlineNumber != Math.rint(deadlineNumber)
          || deadlineNumber > Long.MAX_VALUE
          || deadlineNumber < Long.MIN_VALUE)
        throw new ProtocolError("INVALID_COMMAND", "Command deadline is invalid.");
      long deadline = (long) deadlineNumber;
      if (deadline <= System.currentTimeMillis())
        throw new ProtocolError("COMMAND_EXPIRED", "This command has expired.");
      if (req.length() != 5)
        throw new ProtocolError("INVALID_COMMAND", "Command frame contains unknown fields.");
      if (!(req.opt("method") instanceof String) || !(req.opt("params") instanceof JSONObject))
        throw new ProtocolError("INVALID_COMMAND", "Command fields are invalid.");
      if (!PhoneState.controlEnabled)
        throw new ProtocolError("CONTROL_DISABLED", "Enable control on your phone.");
      PhoneAccessibilityService service = PhoneState.accessibility;
      if (service == null)
        throw new ProtocolError(
            "ACCESSIBILITY_DISABLED", "Enable PhoneUse accessibility access on your phone.");
      if (ws != socket || stopping)
        throw new ProtocolError("DISCONNECTED", "PhoneUse is disconnected.");
      if (deadline <= System.currentTimeMillis())
        throw new ProtocolError("COMMAND_EXPIRED", "This command has expired.");
      JSONObject command =
          new JSONObject()
              .put("method", req.getString("method"))
              .put("params", req.getJSONObject("params"));
      JSONObject result = service.runCommand(command, deadline);
      if (deadline <= System.currentTimeMillis())
        throw new ProtocolError("COMMAND_EXPIRED", "This command has expired.");
      sendResult(ws, id, true, result, null);
    } catch (ProtocolError e) {
      sendResult(ws, id, false, null, error(e.code, e.getMessage()));
    } catch (PhoneAccessibilityService.CommandFailure e) {
      sendResult(ws, id, false, null, error(e.code, e.getMessage()));
    } catch (Exception e) {
      sendResult(
          ws, id, false, null, error("INVALID_COMMAND", "The command could not be processed."));
    }
  }

  /** Emits the version 1 success or failure envelope, with no internal exception details. */
  private void sendResult(WebSocket ws, String id, boolean ok, JSONObject result, JSONObject err) {
    try {
      JSONObject frame = new JSONObject().put("type", "result").put("id", id).put("ok", ok);
      if (ok) frame.put("result", result);
      else frame.put("error", err);
      if (ws == socket) ws.send(frame.toString());
    } catch (Exception ignored) {
    }
  }

  /** Safely extracts a correlation id for a queue-overload response. */
  private static String requestId(String raw) {
    try {
      return new JSONObject(raw).optString("id", "");
    } catch (Exception e) {
      return "";
    }
  }

  /** Carries a safe protocol error code and message to the response envelope. */
  private static final class ProtocolError extends Exception {
    final String code;

    ProtocolError(String c, String m) {
      super(m);
      code = c;
    }
  }

  /** Trusts only the exact paired DER certificate fingerprint and checks certificate dates. */
  private static final class PinnedTrustManager implements X509TrustManager {
    /** Exact lowercase SHA-256 digest of the DER certificate in the pairing code. */
    private final String expected;

    /** Stores the one certificate identity accepted for this session. */
    PinnedTrustManager(String expected) {
      this.expected = expected;
    }

    /** Checks certificate validity and compares the complete DER certificate digest. */
    boolean matches(java.security.cert.Certificate[] chain) {
      try {
        if (chain.length == 0 || !(chain[0] instanceof X509Certificate)) return false;
        X509Certificate cert = (X509Certificate) chain[0];
        cert.checkValidity();
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
        StringBuilder b = new StringBuilder();
        for (byte v : digest) b.append(String.format(java.util.Locale.ROOT, "%02x", v & 255));
        return expected.equals(b.toString());
      } catch (Exception e) {
        return false;
      }
    }

    @Override
    public void checkServerTrusted(X509Certificate[] chain, String authType)
        throws CertificateException {
      if (chain == null || chain.length == 0 || !matches(chain))
        throw new CertificateException("Paired certificate pin or validity check failed.");
    }

    @Override
    public void checkClientTrusted(X509Certificate[] chain, String authType)
        throws CertificateException {
      throw new CertificateException("Client certificates are not accepted.");
    }

    @Override
    public X509Certificate[] getAcceptedIssuers() {
      return new X509Certificate[0];
    }
  }
}
