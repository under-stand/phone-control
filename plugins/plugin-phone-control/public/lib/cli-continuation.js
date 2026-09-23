export const CLI_COMPOSER = {
  eyebrow: "CONTINUE ORIGINAL CLI",
  context: "原 CLI",
  title: "继续 CLI 会话",
  button: "发送到原 CLI",
  placeholder: "继续电脑上这个 CLI 会话…",
  note: "沿用原 CLI 的模型和权限。忙时等待后续处理；CLI 已关闭时，需在电脑重新打开原会话。",
};

// Retain the attempt across rerenders/reloads until its HTTP receipt arrives.
// Retrying after a lost response must query the same server journal entry.
export class CliMessageAttempts {
  constructor(storage, createId) {
    this.storage = storage;
    this.createId = createId;
    this.key = "phone-control-cli-attempts-v1";
    try { this.attempts = JSON.parse(storage.getItem(this.key) || "{}"); } catch { this.attempts = {}; }
    if (!this.attempts || typeof this.attempts !== "object" || Array.isArray(this.attempts)) this.attempts = {};
  }

  id(sessionId, text) {
    const previous = this.attempts[sessionId];
    if (previous?.text === text && typeof previous.id === "string") {
      this.storage.setItem(this.key, JSON.stringify(this.attempts));
      return previous.id;
    }
    const id = this.createId();
    this.attempts[sessionId] = { id, text };
    // Do not send if persistence is unavailable: otherwise reload can cause
    // an accidental duplicate following a lost HTTP response.
    this.storage.setItem(this.key, JSON.stringify(this.attempts));
    return id;
  }

  complete(sessionId) {
    delete this.attempts[sessionId];
    try { this.storage.setItem(this.key, JSON.stringify(this.attempts)); } catch {}
  }
}

export function cliReceiptMessage(entry) {
  if (entry?.status === "cli_queued") return "已交给原 CLI 排队，等待原会话继续";
  if (entry?.status === "delivered") return "原 CLI 已接收这条消息";
  if (entry?.status === "canceled") return "这条消息已取消";
  return entry?.lastError || "投递状态待确认，请查看会话中的手机指令状态";
}
