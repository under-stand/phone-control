import assert from "node:assert/strict";
import {
  codexPermissionSelection,
  normalizeCodexApprovalPolicy,
  permissionProfileFromContext,
} from "../src/codex-permissions.mjs";

export const tests = [
  {
    name: "normalizes legacy approval spellings but emits the current App Server enum",
    async run() {
      assert.equal(normalizeCodexApprovalPolicy("onRequest"), "on-request");
      assert.equal(normalizeCodexApprovalPolicy("on-request"), "on-request");
      assert.equal(permissionProfileFromContext({ permissionMode: "workspaceWrite", approvalPolicy: "onRequest" }), "on-request");
      assert.equal(codexPermissionSelection("on-request", "/work").approvalPolicy, "on-request");
    },
  },
  {
    name: "maps every phone permission profile to a bounded Codex sandbox",
    async run() {
      assert.deepEqual(codexPermissionSelection("read-only", "/work").sandboxPolicy, { type: "readOnly" });
      assert.deepEqual(codexPermissionSelection("workspace-write", "/work").sandboxPolicy, {
        type: "workspaceWrite",
        writableRoots: ["/work"],
        networkAccess: false,
      });
      assert.equal(codexPermissionSelection("workspace-write-network", "/work").sandboxPolicy.networkAccess, true);
      assert.deepEqual(codexPermissionSelection("danger-full-access", "/work").sandboxPolicy, { type: "dangerFullAccess" });
      assert.throws(() => codexPermissionSelection("unknown", "/work"), (error) => error.statusCode === 400);
    },
  },
];
