import { createHash } from "node:crypto";

const optional = (value) => value == null || value === "" ? null : value;
const text = (value) => typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : value;

// Hash the user's intent, not mutable runtime state or delivery results.
export function commandFingerprint(input, { channel, deviceId = input.deviceId } = {}) {
  return createHash("sha256").update(JSON.stringify({
    channel, deviceId: optional(deviceId), sessionId: optional(input.sessionId),
    text: text(input.text), expectedTurnId: optional(input.expectedTurnId),
    cwd: optional(input.cwd), model: optional(input.model), reasoningEffort: optional(input.reasoningEffort),
    serviceTier: optional(input.serviceTier), permissionProfile: optional(input.permissionProfile),
    confirmDangerFullAccess: input.confirmDangerFullAccess === true,
    actionHint: channel === "outbox" ? (input.actionHint === "steer" ? "steer" : "start") : null,
    context: optional(input.context), branchOf: optional(input.branchOf),
    imageIds: input.imageIds || [],
    images: (input.images || []).map((image) => ({ id: image.id || null, path: image.path || image.localPath || null })),
  })).digest("hex");
}

export function assertCommandIdentity(expected, actual) {
  if (expected !== actual) throw Object.assign(new Error("消息标识已用于另一条指令 / Command id conflicts with a different request"), {
    statusCode: 409, code: "command_id_conflict", delivery: "not_delivered", retryable: false,
  });
}
