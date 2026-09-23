import { CommandReplay } from "./command-replay.mjs";

export class SessionInputService {
  constructor({ filePath, store, bridge, images, executionContext, rememberPrompt }) {
    this.replay = new CommandReplay({ filePath });
    Object.assign(this, { store, bridge, images, executionContext, rememberPrompt });
  }

  send(sessionId, body, device) {
    return this.replay.execute({ ...body, sessionId }, device, "http-input", async () => {
      let records = [];
      let dispatching = false;
      try {
        const session = this.store.get(sessionId);
        if (!session) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
        if (session.pendingApproval || !session.control?.canSend) {
          throw Object.assign(new Error(session.control?.reason || "This session cannot accept phone input"), { statusCode: 409 });
        }
        const expectedTurnId = body.expectedTurnId ?? null;
        if (expectedTurnId !== (session.control.expectedTurnId || null)) {
          throw Object.assign(new Error("The Codex turn changed; refresh before sending"), { statusCode: 409 });
        }
        const inherited = expectedTurnId == null ? this.executionContext(session) : {};
        records = await this.images.consume(body.imageIds || [], { deviceId: device.id, sessionId, expectedTurnId });
        dispatching = true;
        const command = await this.bridge.sendInput({
          sessionId, expectedTurnId, text: body.text,
          images: records.map((record) => ({ path: record.path, mime: record.mime })),
          model: body.model || inherited.model, reasoningEffort: body.reasoningEffort || inherited.reasoningEffort,
          serviceTier: body.serviceTier || inherited.serviceTier, permissionProfile: body.permissionProfile || inherited.permissionProfile,
          confirmDangerFullAccess: body.confirmDangerFullAccess, cwd: body.cwd || inherited.cwd, clientMessageId: body.clientMessageId,
        }, device);
        this.rememberPrompt(command, body.text);
        return command;
      } catch (error) {
        if (!dispatching) error.delivery = "not_delivered";
        await this.images.discardRecords(records);
        throw error;
      }
    });
  }
}
