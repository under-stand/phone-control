const PERMISSION_PROFILES = new Set([
  "read-only",
  "workspace-write",
  "workspace-write-network",
  "on-request",
  "danger-full-access",
]);

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

export function normalizeCodexApprovalPolicy(value) {
  const compact = String(value || "").trim().toLowerCase().replace(/[-_]/g, "");
  if (compact === "onrequest") return "on-request";
  if (compact === "untrusted") return "untrusted";
  if (compact === "never") return "never";
  return null;
}

export function permissionProfileFromContext({ permissionMode, approvalPolicy } = {}) {
  const mode = String(permissionMode || "").trim().toLowerCase().replace(/[-_]/g, "");
  if (mode === "readonly") return "read-only";
  if (mode === "workspacewritenetwork") return "workspace-write-network";
  if (mode === "workspacewrite") {
    return normalizeCodexApprovalPolicy(approvalPolicy) === "on-request" ? "on-request" : "workspace-write";
  }
  if (mode === "dangerfullaccess") return "danger-full-access";
  return null;
}

export function codexPermissionSelection(value, cwd) {
  if (value == null || value === "" || value === "default") return null;
  if (typeof value !== "string") throw httpError("Permission profile is invalid", 400);
  const profile = value.trim();
  if (!PERMISSION_PROFILES.has(profile)) throw httpError("Permission profile is invalid", 400);

  if (profile === "read-only") {
    return {
      profile,
      approvalPolicy: "never",
      sandbox: "readOnly",
      sandboxPolicy: { type: "readOnly" },
      permissionMode: "read-only",
    };
  }
  if (profile === "danger-full-access") {
    return {
      profile,
      approvalPolicy: "never",
      sandbox: "dangerFullAccess",
      sandboxPolicy: { type: "dangerFullAccess" },
      permissionMode: "danger-full-access",
    };
  }
  return {
    profile,
    approvalPolicy: profile === "on-request" ? "on-request" : "never",
    sandbox: "workspaceWrite",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: cwd ? [cwd] : [],
      networkAccess: profile === "workspace-write-network",
    },
    permissionMode: profile === "workspace-write-network" ? "workspace-write-network" : "workspace-write",
  };
}
