/** Defines strict v2 wire schemas and bounded command/result validation for the bridge and agent tools. */
import { z } from "zod";

/** Hard transport message ceiling shared with the Android peer. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** Wire v2 uses relative execution budgets; saved pairing identity remains version 1. */
export const PROTOCOL_VERSION = 2;

/** Build a text validator with a strict UTF-16 length ceiling. */
const boundedText = (maximum: number) => z.string().max(maximum);

/** Validate canonical base64 in linear time without a recursive regular expression. */
export function isBase64(value: string): boolean {
  if (!value.length || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const end = value.length - padding;
  for (let i = 0; i < end; i++) {
    const code = value.charCodeAt(i);
    if (!(
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47
    ))
      return false;
  }
  // Padding bits must be zero as well as the padding count being valid.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const last = alphabet.indexOf(value[end - 1]!);
  return padding === 0 || (padding === 2 ? (last & 15) === 0 : (last & 3) === 0);
}

/** Identity and explicit local-control state announced with every phone connection. */
export const HelloSchema = z
  .object({
    type: z.literal("hello"),
    version: z.literal(PROTOCOL_VERSION),
    device: z
      .object({
        id: z.string().uuid(),
        name: boundedText(120).min(1),
        sdk: z.number().int().min(1).max(100),
      })
      .strict(),
    status: z.object({ accessibilityEnabled: z.boolean(), controlEnabled: z.boolean() }).strict(),
  })
  .strict();

export type PhoneHello = z.infer<typeof HelloSchema>;

/** Physical display coordinates and dimensions. */
const point = z.number().int().min(0).max(100_000);

/** Bounds may extend beyond the display. */
const signedPoint = z.number().int().min(-100_000).max(100_000);

/** Identifies a node from the current snapshot only. */
const nodeParams = z
  .object({ snapshotId: z.string().uuid(), nodeId: boundedText(128).min(1) })
  .strict();

/** A snapshot can inspect all visible windows or one previously observed region. */
export const SnapshotParams = z
  .object({ windowId: z.number().int().min(0).optional(), root: nodeParams.optional() })
  .strict()
  .refine(
    (value) => !(value.windowId !== undefined && value.root !== undefined),
    "Choose a window or a root, not both",
  );

/** Screenshot sizing is bounded and does not change physical input coordinates. */
export const ScreenshotParams = z
  .object({ maxDimension: z.number().int().min(320).max(1440).optional() })
  .strict();

/** Leaf input methods that can be followed by one observation. */
export const ActionParams = {
  tap: z.object({ x: point, y: point }).strict(),
  swipe: z
    .object({
      startX: point,
      startY: point,
      endX: point,
      endY: point,
      durationMs: z.number().int().min(100).max(3000),
    })
    .strict(),
  click: nodeParams,
  set_text: nodeParams.extend({ text: boundedText(4000) }).strict(),
  scroll: nodeParams
    .extend({ direction: z.enum(["forward", "backward", "up", "down", "left", "right"]) })
    .strict(),
  global_action: z.object({ action: z.enum(["back", "home", "recents"]) }).strict(),
} as const;

/** Reject arbitrary nesting and observation commands within an action-and-observe request. */
export const ActionSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("tap"), params: ActionParams.tap }).strict(),
  z.object({ method: z.literal("swipe"), params: ActionParams.swipe }).strict(),
  z.object({ method: z.literal("click"), params: ActionParams.click }).strict(),
  z.object({ method: z.literal("set_text"), params: ActionParams.set_text }).strict(),
  z.object({ method: z.literal("scroll"), params: ActionParams.scroll }).strict(),
  z.object({ method: z.literal("global_action"), params: ActionParams.global_action }).strict(),
]);

/** One action followed by bounded quiet-period observation, with separate outcomes. */
export const ObserveActionParams = z
  .object({
    action: ActionSchema,
    quietMs: z.number().int().min(100).max(1000).optional(),
    maxWaitMs: z.number().int().min(200).max(3000).optional(),
  })
  .strict()
  .refine(
    (value) => (value.quietMs ?? 200) <= (value.maxWaitMs ?? 2000),
    "Quiet period must fit within maximum wait",
  );

/** Validated command arguments reject unknown properties and unsafe values. */
export const CommandParams = {
  snapshot: SnapshotParams,
  screenshot: ScreenshotParams,
  ...ActionParams,
  observe_action: ObserveActionParams,
} as const;

export type CommandMethod = keyof typeof CommandParams;

/** Validate untrusted local or MCP commands at the protocol boundary. */
export function parseCommand(value: unknown): {
  method: CommandMethod;
  params: Record<string, unknown>;
} {
  const raw = z.object({ method: z.string(), params: z.unknown() }).strict().parse(value);
  if (!Object.hasOwn(CommandParams, raw.method)) throw new Error("Unknown command method");
  const method = raw.method as CommandMethod;
  return { method, params: CommandParams[method].parse(raw.params) as Record<string, unknown> };
}

/** Bounded error content must not contain implementation diagnostics or phone text. */
const errorSchema = z
  .object({ code: boundedText(80).min(1), message: boundedText(500).min(1) })
  .strict();

/** Validate the envelope before correlating an incoming phone result. */
export const PhoneResultSchema = z
  .object({
    type: z.literal("result"),
    id: z.string().uuid(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: errorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ok && (value.result === undefined || value.error !== undefined))
      context.addIssue({ code: "custom", message: "Successful result must contain only result" });
    if (!value.ok && (value.error === undefined || value.result !== undefined))
      context.addIssue({ code: "custom", message: "Failed result must contain only error" });
  });

/** Window and node rectangles may be partially outside the screen. */
const bounds = z
  .object({ left: signedPoint, top: signedPoint, right: signedPoint, bottom: signedPoint })
  .strict()
  .refine((b) => b.right >= b.left && b.bottom >= b.top);

/** Physical display dimensions accompany semantic and image observations. */
const screen = z.object({ width: point.min(1), height: point.min(1) }).strict();

/** Only explicitly supported input capabilities are exposed to agents. */
const nodeSchema = z
  .object({
    id: boundedText(128).min(1),
    parentId: boundedText(128).min(1).optional(),
    windowId: z.number().int().min(0),
    text: boundedText(4000).optional(),
    description: boundedText(1000).optional(),
    viewId: boundedText(300).optional(),
    className: boundedText(300).optional(),
    bounds,
    clickable: z.boolean(),
    editable: z.boolean(),
    scrollable: z.boolean(),
    enabled: z.boolean(),
    actions: z
      .array(
        z.enum([
          "click",
          "set_text",
          "scroll_forward",
          "scroll_backward",
          "scroll_up",
          "scroll_down",
          "scroll_left",
          "scroll_right",
        ]),
      )
      .max(8),
    collection: z
      .object({ rows: z.number().int().min(0), columns: z.number().int().min(0) })
      .strict()
      .optional(),
  })
  .strict();

/** A bounded snapshot includes window identity and compact ancestry. */
const snapshotSchema = z
  .object({
    snapshotId: z.string().uuid(),
    packageName: boundedText(300),
    screen,
    nodes: z.array(nodeSchema).max(500),
    truncated: z.boolean(),
    windows: z
      .array(
        z
          .object({
            id: z.number().int().min(0),
            type: z.number().int().min(0),
            active: z.boolean(),
            focused: z.boolean(),
            bounds,
          })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Map(value.nodes.map((node) => [node.id, node]));
    const windows = new Set(value.windows.map((window) => window.id));
    if (ids.size !== value.nodes.length || windows.size !== value.windows.length)
      context.addIssue({ code: "custom", message: "Duplicate snapshot identity" });
    for (const node of value.nodes) {
      const ancestors = new Set([node.id]);
      let current = node;
      let invalid = !windows.has(node.windowId);
      while (current.parentId !== undefined) {
        const parent = ids.get(current.parentId);
        if (!parent || parent.windowId !== node.windowId || ancestors.has(parent.id)) {
          invalid = true;
          break;
        }
        ancestors.add(parent.id);
        current = parent;
      }
      if (invalid) context.addIssue({ code: "custom", message: "Invalid node ancestry or window" });
    }
  });

/** Leaf actions acknowledge performance; later observation has an independent result. */
const performed = z.object({ performed: z.literal(true) }).strict();

/** Method-specific response shapes preserve screenshot and traversal ceilings. */
const resultSchemas: Record<CommandMethod, z.ZodTypeAny> = {
  snapshot: snapshotSchema,
  screenshot: z
    .object({
      mimeType: z.literal("image/png"),
      data: z.string().max(7_800_000).refine(isBase64, "Invalid base64"),
      width: point.min(1).max(1440),
      height: point.min(1).max(1440),
      screen,
    })
    .strict(),
  tap: performed,
  swipe: performed,
  click: performed,
  set_text: performed,
  scroll: performed,
  global_action: performed,
  observe_action: z
    .object({
      performed: z.literal(true),
      observation: z.discriminatedUnion("ok", [
        z.object({ ok: z.literal(true), snapshot: snapshotSchema, settled: z.boolean() }).strict(),
        z.object({ ok: z.literal(false), error: errorSchema }).strict(),
      ]),
    })
    .strict(),
};

/** Validate Android results before returning them to HTTP or MCP clients. */
export function validateCommandResult(method: CommandMethod, value: unknown): unknown {
  return resultSchemas[method].parse(value);
}

/** Carry a remaining budget rather than a timestamp from another device's clock. */
export function makeCommandMessage(
  id: string,
  method: CommandMethod,
  params: Record<string, unknown>,
  timeoutMs: number,
): string {
  return JSON.stringify({ type: "command", id, method, params, timeoutMs });
}
