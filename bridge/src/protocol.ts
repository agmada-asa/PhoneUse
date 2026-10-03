/** Defines strict version 1 wire schemas and bounded command/result validation shared by the bridge and MCP tools. */
import { z } from "zod";

/** Hard transport message ceiling shared with the Android peer. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** Build a text validator with a strict UTF-16 length ceiling. */
const boundedText = (maximum: number) => z.string().max(maximum);

/** Android identity and local-control state announced with each phone connection. */
export const HelloSchema = z.object({
  type: z.literal("hello"),
  version: z.literal(1),
  device: z.object({ id: z.string().uuid(), name: boundedText(120).min(1), sdk: z.number().int().min(1).max(100) }).strict(),
  status: z.object({ accessibilityEnabled: z.boolean(), controlEnabled: z.boolean() }).strict(),
}).strict();
export type PhoneHello = z.infer<typeof HelloSchema>;

/** Empty method parameters reject even harmless-looking unexpected fields. */
const emptyParams = z.object({}).strict();
/** Shared non-negative integer validator for physical display coordinates and dimensions. */
const point = z.number().int().min(0).max(100_000);
/** Snapshot bounds can legitimately extend beyond an edge of the display. */
const signedPoint = z.number().int().min(-100_000).max(100_000);
/** Shared identifiers required to reference a node from a specific snapshot. */
const nodeParams = z.object({ snapshotId: z.string().uuid(), nodeId: boundedText(128).min(1) }).strict();
/** Validated command arguments, rejecting unknown properties and unsafe values. */
export const CommandParams = {
  snapshot: emptyParams,
  screenshot: emptyParams,
  tap: z.object({ x: point, y: point }).strict(),
  swipe: z.object({ startX: point, startY: point, endX: point, endY: point, durationMs: z.number().int().min(100).max(3000) }).strict(),
  click: nodeParams,
  set_text: nodeParams.extend({ text: boundedText(4000) }).strict(),
  global_action: z.object({ action: z.enum(["back", "home", "recents"]) }).strict(),
} as const;
export type CommandMethod = keyof typeof CommandParams;

/** Validate an untrusted local or MCP command at the protocol boundary. */
export function parseCommand(value: unknown): { method: CommandMethod; params: Record<string, unknown> } {
  const raw = z.object({ method: z.string(), params: z.unknown() }).strict().parse(value);
  if (!(raw.method in CommandParams)) throw new Error("Unknown command method");
  const method = raw.method as CommandMethod;
  return { method, params: CommandParams[method].parse(raw.params) as Record<string, unknown> };
}

/** Validate an incoming phone result. Shapes are bounded so malformed peers cannot inflate memory use. */
/** Envelope validation for companion results before command correlation. */
export const PhoneResultSchema = z.object({
  type: z.literal("result"),
  id: z.string().uuid(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: boundedText(80).min(1), message: boundedText(500).min(1) }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.ok && (value.result === undefined || value.error !== undefined)) context.addIssue({ code: "custom", message: "Successful result must contain only result" });
  if (!value.ok && (value.error === undefined || value.result !== undefined)) context.addIssue({ code: "custom", message: "Failed result must contain only error" });
});

/** Rectangle schema used by snapshot nodes. */
const bounds = z.object({ left: signedPoint, top: signedPoint, right: signedPoint, bottom: signedPoint }).strict().refine((b) => b.right >= b.left && b.bottom >= b.top);
/** Bound each visible field and capability flag in a returned accessibility node. */
const nodeSchema = z.object({
  id: boundedText(128).min(1), text: boundedText(4000).optional(), description: boundedText(1000).optional(),
  viewId: boundedText(300).optional(), className: boundedText(300).optional(), bounds,
  clickable: z.boolean(), editable: z.boolean(), scrollable: z.boolean(), enabled: z.boolean(),
}).strict();
/** Method-specific response shapes, including screenshot and traversal ceilings. */
const resultSchemas: Record<CommandMethod, z.ZodTypeAny> = {
  snapshot: z.object({ snapshotId: z.string().uuid(), packageName: boundedText(300), screen: z.object({ width: point.min(1), height: point.min(1) }).strict(), nodes: z.array(nodeSchema).max(500), truncated: z.boolean() }).strict(),
  screenshot: z.object({ mimeType: z.literal("image/png"), data: z.string().max(7_800_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/), width: point.min(1), height: point.min(1) }).strict(),
  tap: z.object({ performed: z.literal(true) }).strict(), swipe: z.object({ performed: z.literal(true) }).strict(),
  click: z.object({ performed: z.literal(true) }).strict(), set_text: z.object({ performed: z.literal(true) }).strict(),
  global_action: z.object({ performed: z.literal(true) }).strict(),
};

/** Check the method-specific Android result before returning it to HTTP or MCP clients. */
export function validateCommandResult(method: CommandMethod, value: unknown): unknown {
  return resultSchemas[method].parse(value);
}

/** Envelope for a command sent to the companion. */
export function makeCommandMessage(id: string, method: CommandMethod, params: Record<string, unknown>, deadline: number): string {
  return JSON.stringify({ type: "command", id, method, params, deadline });
}
