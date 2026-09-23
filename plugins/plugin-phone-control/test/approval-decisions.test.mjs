import assert from "node:assert/strict";
import { ApprovalDecisions } from "../public/lib/approval-decisions.js";

const binding = { sessionId: "session-one", turnId: "turn-one", decision: "deny" };
const pending = { ...binding, id: "request-one", status: "pending", canRespond: true };

export const tests = [
  {
    name: "retains an in-flight decision across view changes and blocks a conflicting click",
    run() {
      const decisions = new ApprovalDecisions();
      assert.equal(decisions.begin("request-one", binding), true);
      assert.equal(decisions.begin("request-two", { ...binding, sessionId: "session-two" }), true);
      decisions.reconcile("request-one", pending);
      assert.equal(decisions.begin("request-one", { ...binding, decision: "allow" }), false);
      assert.equal(decisions.get("request-one").decision, "deny");
    },
  },
  {
    name: "reopens a definitely rejected decision only after a matching direct broker read",
    run() {
      const decisions = new ApprovalDecisions();
      decisions.begin("request-one", binding);
      decisions.set("request-one", { state: "rejected" });
      decisions.reconcile("request-one", { ...pending, turnId: "turn-two" });
      assert.equal(decisions.begin("request-one", binding), false);
      decisions.reconcile("request-one", pending);
      assert.equal(decisions.begin("request-one", { ...binding, decision: "allow" }), true);
    },
  },
  {
    name: "does not replay an uncertain decision even if a subsequent read still reports pending",
    run() {
      const decisions = new ApprovalDecisions();
      decisions.begin("request-one", binding);
      decisions.set("request-one", { state: "uncertain" });
      decisions.reconcile("request-one", pending);
      assert.equal(decisions.begin("request-one", binding), false);
      decisions.reconcile("request-one", { ...pending, status: "denied", decision: "deny" });
      assert.equal(decisions.get("request-one").state, "resolved");
      assert.equal(decisions.begin("request-one", binding), false);
    },
  },
];
