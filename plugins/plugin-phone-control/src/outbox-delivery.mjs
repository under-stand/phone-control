// Only failures proven to occur before sending may be retried. A transport
// timeout after write is ambiguous and must never become another queued send.
export function canAttemptDelivery(entry, now = Date.now()) {
  return ["queued", "waiting"].includes(entry?.status)
    && !(Date.parse(entry.nextAttemptAt) > now);
}

export async function deliverOutboxEntry({ outbox, entry, bridge, input, onDelivered, now = () => Date.now() }) {
  if (!canAttemptDelivery(outbox.get(entry.id), now())) return;
  const started = await outbox.update(entry.id, {
    status: "sending", waitingFor: null, attempts: entry.attempts + 1, lastError: null, nextAttemptAt: null,
  });
  if (outbox.get(entry.id)?.status !== "sending") return;
  const settle = (patch) => outbox.update(entry.id, patch, { settleAttempt: started.attempts });
  try {
    const command = await bridge.sendInput({
      ...input,
      isCanceled: () => outbox.get(entry.id)?.status !== "sending",
    }, { id: entry.deviceId, name: "Queued phone" });
    onDelivered(command, entry.text);
    await settle({ status: "delivered", waitingFor: null, deliveredAt: command.deliveredAt || new Date(now()).toISOString(), deliveredCommand: command, lastError: null, deliveryUnknown: false });
  } catch (error) {
    const message = String(error?.message || "Instruction delivery failed");
    const notDelivered = error?.delivery === "not_delivered";
    if (outbox.get(entry.id)?.status === "canceled") {
      if (notDelivered) await settle({ status: "canceled", deliveryUnknown: false, lastError: "Canceled before delivery" });
      return;
    }
    const mismatch = Boolean(entry.expectedTurnId) && /session is now idle|turn changed|unexpected turn|active turn/i.test(message);
    const transient = error?.retryable !== false && error?.statusCode !== 404 && (error?.statusCode === 503
      || /unavailable|not ready|not attached|handed off|desktop|transport|connection|resume|active turn|question|approval/i.test(message));
    if (!notDelivered || mismatch) {
      await settle({ status: "needs_review", waitingFor: null, deliveryUnknown: !notDelivered, lastError: mismatch
        ? "The Codex turn changed while this instruction was waiting"
        : "无法确认指令是否送达；已停止自动重试，请先查看会话。" });
    } else if (transient) {
      const delay = Math.min(30_000, 2_000 * 2 ** Math.min(4, started.attempts - 1));
      await settle({ status: "waiting", waitingFor: /desktop|handed off|writer/i.test(message) ? "desktop" : /question/i.test(message) ? "question" : /approval/i.test(message) ? "approval" : "codex", lastError: message.slice(0, 500), nextAttemptAt: new Date(now() + delay).toISOString() });
    } else {
      await settle({ status: "failed", waitingFor: null, lastError: message.slice(0, 500) });
    }
  }
}
