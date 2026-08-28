export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function compactId(id = "") {
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

export function projectName(session = {}) {
  if (!session.cwd) return "Unknown workspace";
  const parts = session.cwd.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) || session.cwd;
}

export function cleanTaskText(value = "") {
  return String(value)
    .replace(/```[\s\S]*?```/g, "代码片段")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, " ")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/\[([^\]\n]+)\]\((?:https?:\/\/|www\.)[^)\s]+\)/gi, "$1")
    .replace(/<https?:\/\/[^>\s]+>/gi, "网页链接")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*(?:#{1,6}|[-+*>]|\d+[.)])\s+/gm, "")
    .replace(/(^|\s):?-{3,}:?(?=\s|$)/g, " ")
    .replace(/[#*_`~\[\]|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(value, limit = 58) {
  const text = cleanTaskText(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function taskPreview(value, limit = 92) {
  const text = cleanTaskText(value);
  const sentenceEnd = text.search(/[。！？.!?](?:\s|$)/);
  const concise = sentenceEnd >= 0 ? text.slice(0, sentenceEnd + 1) : text;
  return concise.length > limit ? `${concise.slice(0, limit - 1)}…` : concise;
}

export function relativeTime(value, now = Date.now()) {
  const delta = now - new Date(value).getTime();
  if (!Number.isFinite(delta) || delta < 45_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

export function localDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function readableBytes(value) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
