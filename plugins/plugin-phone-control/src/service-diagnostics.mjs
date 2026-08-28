import { realpathSync } from "node:fs";
import path from "node:path";

export const MINIMUM_SUPPORTED_NODE_MAJOR = 22;

export function nodeMajor(version = process.version) {
  const parsed = Number(String(version || "").match(/^v?(\d+)/)?.[1]);
  return Number.isInteger(parsed) ? parsed : null;
}

export function nodeRuntimeStatus(version = process.version) {
  const major = nodeMajor(version);
  return {
    version,
    major,
    supported: Boolean(major && major >= MINIMUM_SUPPORTED_NODE_MAJOR),
    minimumMajor: MINIMUM_SUPPORTED_NODE_MAJOR,
  };
}

function samePath(left, right) {
  if (!left || !right) return false;
  const comparable = (value) => {
    const resolved = path.resolve(value);
    try {
      return realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  };
  return comparable(left) === comparable(right);
}

export function serviceDefinitionStatus({ service, expectedRoot, currentRuntime = process.execPath } = {}) {
  const expectedEntry = expectedRoot ? path.join(expectedRoot, "bin", "phone-control.mjs") : null;
  const definition = service?.definition || null;
  return {
    known: Boolean(definition),
    runtime: definition?.runtime || null,
    entry: definition?.entry || null,
    runtimeMatches: Boolean(definition && samePath(definition.runtime, currentRuntime)),
    rootMatches: Boolean(definition && samePath(definition.entry, expectedEntry)),
  };
}
