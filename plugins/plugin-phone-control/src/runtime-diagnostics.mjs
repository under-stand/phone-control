import { execFile } from "node:child_process";

const VERSION_PATTERN = /(?:^|[^0-9])(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=$|[^0-9])/;

export function parseCodexVersion(value) {
  if (typeof value !== "string") return null;
  return value.match(VERSION_PATTERN)?.[1] || null;
}

function readInstalledCodexVersion() {
  return new Promise((resolve, reject) => {
    execFile("codex", ["--version"], {
      timeout: 2_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(`${stdout || ""}\n${stderr || ""}`);
    });
  });
}

export async function inspectCodexRuntime({ appServerUserAgent = null, versionReader = readInstalledCodexVersion } = {}) {
  const checkedAt = new Date().toISOString();
  const appServerVersion = parseCodexVersion(appServerUserAgent);
  try {
    const cliVersion = parseCodexVersion(await versionReader());
    const restartRecommended = Boolean(cliVersion && appServerVersion && cliVersion !== appServerVersion);
    return {
      available: Boolean(cliVersion),
      checkedAt,
      cliVersion,
      appServerVersion,
      restartRecommended,
      reason: restartRecommended
        ? "The resident Codex App Server version differs from the installed CLI; restart the App Server to load the current plugin bundle"
        : null,
    };
  } catch {
    return {
      available: false,
      checkedAt,
      cliVersion: null,
      appServerVersion,
      restartRecommended: false,
      reason: null,
    };
  }
}
