import assert from "node:assert/strict";
import { deriveTaskInbox, inboxNeedsAttention } from "../src/task-inbox.mjs";

const session = {
  status: "working",
  statusReason: "Codex is working",
  updatedAt: "2026-09-04T00:00:00Z",
  pendingApproval: null,
  control: {},
};

export const tests = [
  {
    name: "ranks live questions and approvals above passive work",
    run() {
      const question = deriveTaskInbox({
        ...session,
        status: "waiting",
        pendingApproval: { kind: "question", canRespond: true, reason: "Choose a target" },
        control: { canAnswer: true },
      });
      const approval = deriveTaskInbox({
        ...session,
        status: "waiting",
        pendingApproval: { kind: "permission", canRespond: true, reason: "Allow command" },
        control: { canApprove: true },
      });
      const running = deriveTaskInbox(session);
      assert.equal(question.bucket, "needs_answer");
      assert.equal(approval.bucket, "needs_approval");
      assert.ok(question.priority > approval.priority && approval.priority > running.priority);
      assert.equal(inboxNeedsAttention(question), true);
    },
  },
  {
    name: "does not advertise an expired passive approval as actionable",
    run() {
      const inbox = deriveTaskInbox({
        ...session,
        status: "waiting",
        pendingApproval: { kind: "permission", canRespond: false, reason: "Handle on desktop" },
        control: { canApprove: false },
      });
      assert.equal(inbox.bucket, "needs_review");
      assert.equal(inbox.actionRequired, false);
      assert.equal(inbox.action, "inspect");
    },
  },
  {
    name: "surfaces uncertain delivery and recent failures in the action inbox",
    run() {
      const review = deriveTaskInbox(session, { state: "needs_review", detail: "Check before retrying", changedAt: session.updatedAt });
      const failure = deriveTaskInbox({ ...session, status: "error" }, null, Date.parse("2026-09-05T00:00:00Z"));
      assert.equal(review.action, "review_delivery");
      assert.equal(review.actionRequired, true);
      assert.equal(failure.bucket, "failed");
      assert.equal(failure.actionRequired, true);
      const oldFailure = deriveTaskInbox(session, { state: "failed", detail: "Old failure", changedAt: "2026-08-01T00:00:00Z" }, Date.parse("2026-09-05T00:00:00Z"));
      assert.equal(oldFailure.actionRequired, false);
    },
  },
];
