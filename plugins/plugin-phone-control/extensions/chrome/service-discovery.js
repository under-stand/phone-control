export const DEFAULT_SERVICE_PORT = 8787;
export const DEFAULT_SERVICE_SCAN_WINDOW = 20;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function normalizeServiceUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const port = Number(parsed.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return `http://${parsed.hostname.toLowerCase()}:${port}`;
}

export function serviceUrlCandidates({
  configuredServiceUrl = null,
  defaultPort = DEFAULT_SERVICE_PORT,
  scanWindow = DEFAULT_SERVICE_SCAN_WINDOW,
} = {}) {
  const candidates = [];
  const seen = new Set();
  const add = (value) => {
    const normalized = normalizeServiceUrl(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  add(configuredServiceUrl);
  const start = Number(defaultPort);
  const window = Number(scanWindow);
  if (!Number.isInteger(start) || start < 1 || start > 65_535) return candidates;
  if (!Number.isInteger(window) || window < 0) return candidates;
  for (let offset = 0; offset <= window && start + offset <= 65_535; offset += 1) {
    add(`http://127.0.0.1:${start + offset}`);
  }
  return candidates;
}

export async function probeServiceUrl(serviceUrl, { fetchImpl = globalThis.fetch, timeoutMs = 700 } = {}) {
  if (typeof fetchImpl !== "function") return false;
  const normalized = normalizeServiceUrl(serviceUrl);
  if (!normalized) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${normalized}/api/health`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response?.ok || typeof response.json !== "function") return false;
    const body = await response.json().catch(() => null);
    return body?.ok === true && body?.ready === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverServiceUrl(options = {}) {
  const candidates = serviceUrlCandidates(options);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!candidates.length || typeof fetchImpl !== "function") return null;
  const results = await Promise.all(candidates.map(async (candidate) => ({
    candidate,
    healthy: await probeServiceUrl(candidate, options),
  })));
  return results.find((result) => result.healthy)?.candidate || null;
}
