const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 100_000;
const MAX_URL_LENGTH = 8_192;
const MAX_COORDINATE = 100_000;
const ALLOWED_KEYS = new Set([
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

export class BrowserActionError extends Error {
  constructor(message, statusCode = 400, code = "invalid_action") {
    super(message);
    this.name = "BrowserActionError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function requiredString(value, field, { max = MAX_ID_LENGTH } = {}) {
  if (typeof value !== "string") throw new BrowserActionError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\0\r\n]/.test(normalized)) {
    throw new BrowserActionError(`Invalid ${field}`);
  }
  return normalized;
}

function inputText(value) {
  if (typeof value !== "string" || !value.length || value.length > MAX_TEXT_LENGTH || value.includes("\0")) {
    throw new BrowserActionError("Invalid text");
  }
  return value;
}

function finiteNumber(value, field, { nonnegative = false } = {}) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || Math.abs(value) > MAX_COORDINATE
    || (nonnegative && value < 0)
  ) {
    throw new BrowserActionError(`Invalid ${field}`);
  }
  return value;
}

function httpUrl(value) {
  const raw = requiredString(value, "url", { max: MAX_URL_LENGTH });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BrowserActionError("Invalid url");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new BrowserActionError("Only http(s) URLs without embedded credentials are allowed");
  }
  return parsed.toString();
}

function frameFields(action) {
  if (!Number.isInteger(action.pageGeneration) || action.pageGeneration < 0) {
    throw new BrowserActionError("Invalid pageGeneration");
  }
  return {
    frameId: requiredString(action.frameId, "frameId"),
    pageGeneration: action.pageGeneration,
  };
}

export function validateBrowserAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new BrowserActionError("Action must be an object");
  }
  const type = requiredString(action.type, "type", { max: 40 });
  const clientActionId = requiredString(action.clientActionId, "clientActionId");
  const base = { type, clientActionId };

  switch (type) {
    case "navigate":
      return { ...base, url: httpUrl(action.url) };
    case "back":
    case "forward":
    case "reload":
    case "newTab":
    case "screenshot":
    case "listTabs":
    case "startStream":
    case "stopStream":
      return base;
    case "selectTab":
    case "closeTab":
      return { ...base, tabId: requiredString(String(action.tabId ?? ""), "tabId") };
    case "tap":
      return {
        ...base,
        ...frameFields(action),
        x: finiteNumber(action.x, "x", { nonnegative: true }),
        y: finiteNumber(action.y, "y", { nonnegative: true }),
      };
    case "scroll":
      return {
        ...base,
        ...frameFields(action),
        deltaX: finiteNumber(action.deltaX ?? 0, "deltaX"),
        deltaY: finiteNumber(action.deltaY ?? 0, "deltaY"),
      };
    case "insertText":
      return { ...base, ...frameFields(action), text: inputText(action.text) };
    case "key": {
      const key = requiredString(action.key, "key", { max: 80 });
      if (!ALLOWED_KEYS.has(key)) throw new BrowserActionError("Unsupported key");
      return { ...base, ...frameFields(action), key };
    }
    default:
      throw new BrowserActionError(`Unsupported action: ${type}`);
  }
}

export function assertCurrentBrowserFrame(action, current) {
  if (
    !current
    || action.frameId !== current.frameId
    || action.pageGeneration !== current.pageGeneration
    || String(current.tabId) !== String(action.tabId ?? current.tabId)
  ) {
    throw new BrowserActionError("The screenshot is stale; refresh and try again", 409, "stale_frame");
  }
  if (action.type === "tap" && (action.x >= current.width || action.y >= current.height)) {
    throw new BrowserActionError("Tap coordinates are outside the current screenshot", 400, "coordinate_out_of_bounds");
  }
}
