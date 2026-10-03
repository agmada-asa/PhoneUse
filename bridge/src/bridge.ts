/** Runs the TLS phone endpoint and authenticated loopback API, coordinating a single phone and serial command queue. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { networkInterfaces } from "node:os";
import { timingSafeEqual } from "node:crypto";
import { createServer as createTlsServer } from "node:https";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import QRCode from "qrcode";
import { ensureState, type BridgeState } from "./state.js";
import { HelloSchema, MAX_MESSAGE_BYTES, makeCommandMessage, parseCommand, PhoneResultSchema, validateCommandResult, type CommandMethod, type PhoneHello } from "./protocol.js";

/** Configuration for both listeners and optional operator-console files. */
export interface CreateBridgeOptions {
  stateDir: string;
  host?: string;
  phonePort?: number;
  adminPort?: number;
  advertisedHost?: string;
  commandTimeoutMs?: number;
  consoleHtml?: (csrfToken: string) => string;
  publicDir?: string;
}

/** A started local bridge. `state` exposes pairing material only to the trusted embedding CLI. */
export interface RunningBridge {
  state: BridgeState;
  phoneAddress: { host: string; port: number; url: string };
  adminAddress: { host: "127.0.0.1"; port: number; url: string };
  close(): Promise<void>;
}

interface WaitingCommand {
  id: string;
  method: CommandMethod;
  params: Record<string, unknown>;
  deadline: number;
  resolve(value: unknown): void;
  reject(error: BridgeError): void;
  timer?: NodeJS.Timeout;
}

/** Stable machine-readable API error sent to local clients. */
export class BridgeError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}

/** Start the authenticated encrypted phone transport and loopback operator API. */
export async function createBridge(options: CreateBridgeOptions): Promise<RunningBridge> {
  const state = await ensureState(options.stateDir);
  const phonePort = options.phonePort ?? 8765;
  const adminPort = options.adminPort ?? 8766;
  const listenHost = options.host ?? "0.0.0.0";
  const timeoutMs = options.commandTimeoutMs ?? 30_000;
  if (!Number.isInteger(phonePort) || phonePort < 0 || phonePort > 65535 || !Number.isInteger(adminPort) || adminPort < 0 || adminPort > 65535) {
    throw new Error("Bridge ports must be integers between 0 and 65535");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error("Command timeout must be between 100 and 120000 ms");

  let phone: WebSocket | undefined;
  let hello: PhoneHello | undefined;
  let active: WaitingCommand | undefined;
  const queue: WaitingCommand[] = [];
  let pumping = false;
  let closed = false;
  let effectiveAdminPort = adminPort;
  const lastPong = new WeakMap<WebSocket, number>();
  const closeTimers = new WeakMap<WebSocket, NodeJS.Timeout>();
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const tlsServer = createTlsServer({ cert: await readFile(state.certPath), key: await readFile(state.keyPath), minVersion: "TLSv1.2" });

  /** Reject all undispatched and currently correlated commands after a session failure. */
  function rejectQueued(error: BridgeError): void {
    for (const item of queue.splice(0)) item.reject(error);
    if (active) {
      clearTimeout(active.timer);
      active.reject(error);
      active = undefined;
    }
  }
  /** Detach the peer and reject its work before sending a deliberate close frame. */
  function clearPhone(socket?: WebSocket, code = 1000, reason = "Disconnected", terminateImmediately = false): void {
    if (socket && phone !== socket) return;
    const previous = phone;
    phone = undefined;
    hello = undefined;
    rejectQueued(new BridgeError("PHONE_DISCONNECTED", "The phone disconnected.", 503));
    if (previous && previous.readyState === WebSocket.OPEN) {
      if (terminateImmediately) { previous.terminate(); return; }
      previous.close(code, reason);
      const timer = setTimeout(() => {
        if (previous.readyState !== WebSocket.CLOSED) previous.terminate();
        closeTimers.delete(previous);
      }, 1000);
      timer.unref();
      closeTimers.set(previous, timer);
    }
  }
  /** Report whether a phone completed hello and still has an open transport. */
  function isCurrentReady(): boolean { return Boolean(phone && phone.readyState === WebSocket.OPEN && hello); }

  /** Dispatch queued commands one at a time and await each correlated phone result. */
  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && !closed) {
        const command = queue.shift()!;
        if (command.deadline <= Date.now()) {
          command.reject(new BridgeError("COMMAND_EXPIRED", "The command expired before it was sent.", 408));
          continue;
        }
        if (!isCurrentReady()) {
          command.reject(new BridgeError("PHONE_DISCONNECTED", "Connect the phone and try again.", 503));
          continue;
        }
        if (!hello!.status.accessibilityEnabled || !hello!.status.controlEnabled) {
          command.reject(new BridgeError("CONTROL_DISABLED", "Enable accessibility and control on your phone.", 403));
          continue;
        }
        active = command;
        const remaining = Math.max(1, command.deadline - Date.now());
        command.timer = setTimeout(() => {
          if (active !== command) return;
          active = undefined;
          command.reject(new BridgeError("COMMAND_TIMEOUT", "The phone did not confirm the command before its deadline; it may have executed.", 504));
          // The peer may still be executing an action. End the session before dispatching anything else.
          clearPhone(phone, 1008, "Command timed out");
        }, remaining);
        try {
          phone!.send(makeCommandMessage(command.id, command.method, command.params, command.deadline), (error) => {
            if (error && active === command) {
              clearTimeout(command.timer);
              active = undefined;
              command.reject(new BridgeError("PHONE_DISCONNECTED", "Could not send the command to the phone.", 503));
              clearPhone(phone, 1000, "Transport error", true);
            }
          });
        } catch {
          clearTimeout(command.timer);
          active = undefined;
          command.reject(new BridgeError("PHONE_DISCONNECTED", "Could not send the command to the phone.", 503));
          clearPhone(phone, 1000, "Transport error", true);
          continue;
        }
        // Incoming result resolves active; the next iteration begins only after it settles.
        await new Promise<void>((resolve) => {
          const priorResolve = command.resolve;
          const priorReject = command.reject;
          command.resolve = (value) => { priorResolve(value); resolve(); };
          command.reject = (error) => { priorReject(error); resolve(); };
        });
      }
    } finally { pumping = false; }
  }

  /** Enqueue one validated command with a bounded deadline and queue position. */
  function execute(method: CommandMethod, params: Record<string, unknown>): Promise<unknown> {
    if (!isCurrentReady()) return Promise.reject(new BridgeError("PHONE_DISCONNECTED", "Connect the phone first.", 503));
    if (!hello!.status.accessibilityEnabled || !hello!.status.controlEnabled) return Promise.reject(new BridgeError("CONTROL_DISABLED", "Enable accessibility and control on your phone.", 403));
    if (queue.length + (active ? 1 : 0) >= 32) return Promise.reject(new BridgeError("QUEUE_FULL", "Too many commands are waiting. Try again shortly.", 429));
    const id = cryptoRandomUuid();
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      queue.push({ id, method, params, deadline, resolve, reject });
      void pump();
    });
  }

  wsServer.on("connection", (socket) => {
    phone = socket;
    lastPong.set(socket, Date.now());
    hello = undefined;
    const handshakeTimer = setTimeout(() => socket.close(1008, "hello required"), 5000);
    socket.on("pong", () => { /* ws updates the heartbeat marker below. */ });
    socket.on("message", (raw: RawData) => {
      // A detached peer may finish sending while its close handshake is in flight.
      if (phone !== socket) return;
      try {
        if (byteLength(raw) > MAX_MESSAGE_BYTES) throw new Error("Message too large");
        const data: unknown = JSON.parse(raw.toString());
        if (!hello) {
          hello = HelloSchema.parse(data);
          clearTimeout(handshakeTimer);
          return;
        }
        if (isHelloLike(data)) {
          hello = HelloSchema.parse(data); // Status changes arrive as a fresh complete hello.
          if (!hello.status.accessibilityEnabled || !hello.status.controlEnabled) {
            const hadActiveCommand = active !== undefined;
            rejectQueued(new BridgeError("CONTROL_DISABLED", "Enable accessibility and control on your phone.", 403));
            if (hadActiveCommand) clearPhone(socket, 1008, "Control disabled");
          }
          return;
        }
        const result = PhoneResultSchema.parse(data);
        if (!active || result.id !== active.id) throw new Error("Unknown command result");
        const command = active;
        const validated = result.ok ? validateCommandResult(command.method, result.result) : undefined;
        active = undefined;
        clearTimeout(command.timer);
        if (result.ok) command.resolve({ type: "result", id: result.id, ok: true, result: validated });
        else command.reject(new BridgeError(result.error!.code, result.error!.message, 409));
      } catch {
        if (active && phone === socket) {
          const command = active;
          active = undefined;
          clearTimeout(command.timer);
          command.reject(new BridgeError("PROTOCOL_ERROR", "The phone returned a response that did not match the PhoneUse protocol.", 502));
        }
        clearPhone(socket, 1008, "Invalid protocol message");
      }
    });
    socket.on("close", () => { clearTimeout(handshakeTimer); clearTimeout(closeTimers.get(socket)); closeTimers.delete(socket); clearPhone(socket); });
    socket.on("error", () => clearPhone(socket, 1000, "Transport error", true));
  });
  const heartbeat = setInterval(() => {
    const socket = phone;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - (lastPong.get(socket) ?? Date.now()) > 50_000) { clearPhone(socket, 1000, "Heartbeat timeout", true); return; }
    socket.ping();
  }, 25_000);
  wsServer.on("connection", (socket: WebSocket) => socket.on("pong", () => lastPong.set(socket, Date.now())));

  tlsServer.on("upgrade", (request, socket, head) => {
    const auth = request.headers.authorization ?? "";
    const candidate = Buffer.from(auth.startsWith("Bearer ") ? auth.slice(7) : "");
    const expected = Buffer.from(state.phoneToken);
    const authorized = candidate.length === expected.length && timingSafeEqual(candidate, expected);
    if (request.url !== "/phone" || !authorized || phone) {
      socket.write(`HTTP/1.1 ${phone ? "409 Conflict" : "401 Unauthorized"}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (websocket) => wsServer.emit("connection", websocket, request));
  });
  tlsServer.on("request", (_request, response) => {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("Not found");
  });

  const adminServer = createServer((request, response) => { void handleAdmin(request, response); });
  /** Apply loopback, origin, CSRF and bearer checks before serving the local API or console. */
  async function handleAdmin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host ?? "";
    const origin = request.headers.origin;
    if (!isLoopbackHost(host, effectiveAdminPort)) return sendJson(response, 403, { error: { code: "HOST_REJECTED", message: "Use the local PhoneUse address." } });
    if (origin !== undefined && !isMatchingOrigin(origin, host, effectiveAdminPort)) return sendJson(response, 403, { error: { code: "ORIGIN_REJECTED", message: "This request came from another origin." } });
    const browser = origin !== undefined;
    const csrf = secureEqual(request.headers["x-phoneuse-csrf"] ?? "", state.csrfToken);
    if (request.headers["sec-fetch-site"] === "cross-site") return sendJson(response, 403, { error: { code: "ORIGIN_REJECTED", message: "This request came from another origin." } });
    if (request.method === "GET" && ["/api/status", "/api/pairing"].includes(request.url ?? "")) {
      if ((browser && (request.url !== "/api/pairing" || csrf)) || (!browser && (bearerMatches(request, state.adminToken) || csrf))) {
        if (request.url === "/api/status") return sendJson(response, 200, { connected: isCurrentReady(), ...(hello ? { device: hello.device, status: hello.status } : {}) });
        const advertisedHost = options.advertisedHost ?? guessAdvertisedHost(listenHost);
        const port = (tlsServer.address() as { port: number }).port;
        const url = `wss://${formatHost(advertisedHost)}:${port}/phone`;
        const payload = { v: 1, url, token: state.phoneToken, fingerprint: state.fingerprint };
        const code = `phoneuse:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
        try {
          // Encode the exact validated paste format locally; never send pairing secrets to a QR service.
          const qrDataUrl = await QRCode.toDataURL(code, { errorCorrectionLevel: "M", margin: 4, scale: 6 });
          return sendJson(response, 200, { code, url, fingerprint: state.fingerprint, qrDataUrl });
        } catch {
          return sendJson(response, 500, { error: { code: "PAIRING_QR_FAILED", message: "Could not create the pairing QR code. Use the pairing code from npm run pair, or restart the bridge and try again." } });
        }
      }
      return sendJson(response, browser || csrf ? 403 : 401, { error: { code: browser || csrf ? "CSRF_REJECTED" : "UNAUTHORIZED", message: browser || csrf ? "Reload the local console and try again." : "Local admin authentication is required." } });
    }
    if (request.method === "POST" && ["/api/command", "/api/disconnect"].includes(request.url ?? "")) {
      if (browser || csrf) {
        if (!csrf) return sendJson(response, 403, { error: { code: "CSRF_REJECTED", message: "Reload the local console and try again." } });
      } else if (!bearerMatches(request, state.adminToken)) {
        return sendJson(response, 401, { error: { code: "UNAUTHORIZED", message: "Local admin authentication is required." } });
      }
      if (request.url === "/api/disconnect") {
        clearPhone();
        return sendJson(response, 200, { disconnected: true });
      }
      try {
        const body = await readJsonBody(request);
        const { method, params } = parseCommand(body);
        return sendJson(response, 200, await execute(method, params));
      } catch (error) { return sendError(response, error); }
    }
    if (request.method === "GET" && (request.url === "/" || request.url === "/index.html" || /^\/(console\.js|console\.css)$/.test(request.url ?? ""))) {
      if (request.url === "/" || request.url === "/index.html") {
        const html = options.consoleHtml ? options.consoleHtml(state.csrfToken) : options.publicDir ?
          (await readFile(join(options.publicDir, "index.html"), "utf8")).replaceAll("{{CSRF_TOKEN}}", escapeHtml(state.csrfToken)) :
          "<!doctype html><html><body>PhoneUse local bridge is running.</body></html>";
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'" });
        response.end(html);
        return;
      }
      if (!options.publicDir) return sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
      const staticUrl = request.url!;
      const file = join(options.publicDir, staticUrl.slice(1));
      try {
        const info = await stat(file);
        if (!info.isFile() || !resolve(file).startsWith(`${resolve(options.publicDir)}${sep}`)) throw new Error("invalid path");
        response.writeHead(200, { "content-type": staticUrl.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-cache" });
        createReadStream(file).pipe(response);
      } catch { sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found." } }); }
      return;
    }
    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
  }

  await listen(tlsServer, phonePort, listenHost);
  try { await listen(adminServer, adminPort, "127.0.0.1"); }
  catch (error) { tlsServer.close(); clearInterval(heartbeat); throw error; }
  const actualPhonePort = (tlsServer.address() as { port: number }).port;
  const actualAdminPort = (adminServer.address() as { port: number }).port;
  effectiveAdminPort = actualAdminPort;
  const advertisedHost = options.advertisedHost ?? guessAdvertisedHost(listenHost);
  return {
    state,
    phoneAddress: { host: advertisedHost, port: actualPhonePort, url: `wss://${formatHost(advertisedHost)}:${actualPhonePort}/phone` },
    adminAddress: { host: "127.0.0.1", port: actualAdminPort, url: `http://127.0.0.1:${actualAdminPort}` },
    async close() {
      closed = true;
      clearInterval(heartbeat);
      clearPhone(undefined, 1000, "Bridge stopped");
      await Promise.all([new Promise<void>((resolve) => adminServer.close(() => resolve())), new Promise<void>((resolve) => tlsServer.close(() => resolve()))]);
      wsServer.close();
    },
  };

  function isHelloLike(value: unknown): boolean { return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "hello"; }
}

/** Parse a local API JSON body without exceeding the protocol transport limit. */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_MESSAGE_BYTES) throw new BridgeError("PAYLOAD_TOO_LARGE", "Request body exceeds 8 MiB.", 413);
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new BridgeError("INVALID_JSON", "Request body must be valid JSON.", 400); }
}

/** Check that a browser origin exactly matches a loopback Host header. */
function isMatchingOrigin(origin: string, host: string, adminPort: number): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash &&
      url.host.toLowerCase() === host.toLowerCase() && isLoopbackHost(url.host, adminPort);
  } catch { return false; }
}

/** Only local names and addresses on the configured admin port may reach the operator API. */
/** Only local names and addresses on the configured admin port may reach the operator API. */
function isLoopbackHost(hostHeader: string, port: number): boolean {
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/i.exec(hostHeader);
  return Boolean(match && Number(match[2] ?? 80) === port);
}

/** Compare a supplied local credential without leaking token prefix timing. */
/** Check a supplied bearer credential without leaking token prefix timing. */
function bearerMatches(request: IncomingMessage, token: string): boolean {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") && secureEqual(value.slice(7), token);
}
/** Compare a credential in constant-time after checking equal byte lengths. */
function secureEqual(left: string | string[], right: string): boolean {
  if (Array.isArray(left)) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Send a small JSON response with safe local defaults. */
/** Send a small JSON response with safe local defaults. */
function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}
/** Map internal failures to bounded machine-readable API errors. */
function sendError(response: ServerResponse, error: unknown): void {
  const known = error instanceof BridgeError ? error : undefined;
  sendJson(response, known?.status ?? 400, { error: { code: known?.code ?? "INVALID_REQUEST", message: known?.message ?? "Invalid command request." } });
}
/** Resolve only after a listener has successfully bound its configured address. */
function listen(server: ReturnType<typeof createServer> | ReturnType<typeof createTlsServer>, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.removeListener("error", reject); resolve(); });
  });
}
/** Count raw WebSocket frame bytes for a second explicit size check. */
function byteLength(raw: RawData): number { return Array.isArray(raw) ? raw.reduce((sum, item) => sum + item.byteLength, 0) : raw.byteLength; }
/** Create an unpredictable request ID for command/result correlation. */
function cryptoRandomUuid(): string { return globalThis.crypto.randomUUID(); }
/** Select a non-loopback IPv4 interface for pairing when no advertised host was supplied. */
function guessAdvertisedHost(bindHost: string): string {
  if (bindHost !== "0.0.0.0" && bindHost !== "::" && bindHost !== "") return bindHost;
  const addresses = Object.values(networkInterfaces()).flatMap((items) => items ?? []).filter((item) => item.family === "IPv4" && !item.internal).map((item) => item.address);
  return addresses.find((address) => address.startsWith("192.168.")) ?? addresses.find((address) => address.startsWith("10.")) ?? addresses[0] ?? "127.0.0.1";
}
/** Bracket IPv6 literals when embedding them in the pairing URL. */
function formatHost(host: string): string { return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host; }
/** Escape a generated CSRF token before inserting it into a console HTML template. */
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
