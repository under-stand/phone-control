import os from "node:os";
import path from "node:path";

export function resolveDataDir(environment = process.env) {
  return path.resolve(
    environment.PHONE_CONTROL_DATA_DIR || path.join(os.homedir(), ".phone-control"),
  );
}

export function resolveCodexHome(environment = process.env) {
  return path.resolve(environment.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

export function dataPaths(dataDir) {
  return {
    root: dataDir,
    config: path.join(dataDir, "config.json"),
    devices: path.join(dataDir, "devices.json"),
    taskTitles: path.join(dataDir, "task-titles.json"),
    push: path.join(dataDir, "push.json"),
    uploads: path.join(dataDir, "uploads"),
    eventLog: path.join(dataDir, "events.jsonl"),
    auditLog: path.join(dataDir, "audit.jsonl"),
    hookSpool: path.join(dataDir, "hook-spool.jsonl"),
    relayConfig: path.join(dataDir, "relay.json"),
    relayDir: path.join(dataDir, "relay"),
    relayClientConfig: path.join(dataDir, "relay", "frpc.toml"),
    relayToken: path.join(dataDir, "relay", "token"),
    relayLauncher: path.join(dataDir, "run-relay.sh"),
    relayLog: path.join(dataDir, "relay.log"),
  };
}
