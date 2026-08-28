import { timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE = "phone_control_token";

export function tokenMatches(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index < 0) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

export function requestToken(request, url) {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  const cookies = parseCookies(request.headers.cookie);
  return cookies[AUTH_COOKIE] || url.searchParams.get("token") || null;
}

export function cookieCredential(request) {
  return parseCookies(request.headers.cookie)[AUTH_COOKIE] || null;
}

export function bearerToken(request) {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}

export function authCookie(token, { clear = false, secure = false } = {}) {
  const value = clear ? "" : encodeURIComponent(token);
  return `${AUTH_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}${clear ? "; Max-Age=0" : "; Max-Age=2592000"}`;
}

export function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function isInternalAuthorized(request, expected) {
  return isLoopback(request.socket.remoteAddress) && tokenMatches(bearerToken(request), expected);
}

export function secureRequest(request, configured = false) {
  if (configured) return true;
  const forwarded = String(request.headers["x-forwarded-proto"] || "").split(",", 1)[0].trim();
  return forwarded === "https" || Boolean(request.socket.encrypted);
}

export function isSameOriginWrite(request) {
  if (request.headers["x-phone-control-client"] !== "1") return false;
  if (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin") return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}
