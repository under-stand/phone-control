import { createHash } from "node:crypto";

export function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function clampText(value, limit = 500) {
  const text = asString(value);
  if (!text) return null;
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

export const MAX_MESSAGE_TEXT_LENGTH = 64_000;

export function clampMessageText(value, limit = MAX_MESSAGE_TEXT_LENGTH) {
  const text = asString(value);
  if (!text) return null;
  const formatted = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  return formatted.length > limit ? `${formatted.slice(0, limit - 1)}…` : formatted;
}

export function isCodexInjectedUserMessage(value) {
  const text = asString(value);
  if (!text) return false;
  return [
    /^<(?:recommended_plugins|skills_instructions|environment_context|permissions(?:\s+instructions)?|collaboration_mode|apps_instructions|plugins_instructions)(?:>|\s)/,
    /^# AGENTS\.md instructions for (?:\/|[A-Za-z]:[\\/])/,
    /^The following is the Codex agent history (?:added since your last approval assessment|whose request action you are assessing)\./,
    /^<turn_aborted>(?:\s|$)/,
    /^<image name=\[Image #\d+\] path="[^"\n]+">\s*<\/image>(?:\s|$)/,
  ].some((pattern) => pattern.test(text));
}

export function isoTime(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function stableId(...parts) {
  return createHash("sha256")
    .update(parts.filter((part) => part != null).join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

export function extractContentText(content) {
  if (typeof content === "string") return clampMessageText(content);
  if (!Array.isArray(content)) return null;
  const text = content
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (!entry || typeof entry !== "object") return "";
      return entry.text ?? entry.input_text ?? entry.output_text ?? "";
    })
    .filter(Boolean)
    .join("\n");
  return clampMessageText(text);
}

export function inferSurface(value) {
  const source = String(value ?? "").toLowerCase();
  if (source.includes("vscode") || source.includes("desktop") || source.includes("ide")) {
    return "Desktop";
  }
  if (source.includes("cli") || source.includes("terminal") || source.includes("exec")) {
    return "CLI";
  }
  return "Unknown";
}
