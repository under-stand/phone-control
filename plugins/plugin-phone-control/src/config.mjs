import { randomBytes } from "node:crypto";
import os from "node:os";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dataPaths, resolveDataDir } from "./paths.mjs";
import { safeJsonParse } from "./utils.mjs";

const DEFAULT_PORT = 8787;
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_EVENT_LOG_BYTES = 8 * 1024 * 1024;

function validPort(value, fallback = DEFAULT_PORT) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : fallback;
}

function validInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function envBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function storedConfig(config) {
  return {
    version: 3,
    host: config.host,
    port: config.port,
    token: config.token,
    machineName: config.machineName,
    publicUrl: config.publicUrl,
    secureCookies: config.secureCookies,
    retentionDays: config.retentionDays,
    maxEventLogBytes: config.maxEventLogBytes,
    approvals: {
      enabled: Boolean(config.approvals?.enabled),
      timeoutSeconds: config.approvals?.timeoutSeconds,
    },
    interactions: {
      enabled: Boolean(config.interactions?.enabled),
    },
  };
}

async function writeConfigFile(filePath, config) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(storedConfig(config), null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}

export async function loadConfig({ environment = process.env, create = true } = {}) {
  const dataDir = resolveDataDir(environment);
  const paths = dataPaths(dataDir);
  let stored = null;
  try {
    stored = safeJsonParse(await readFile(paths.config, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (!stored && create) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const seed = {
      version: 3,
      host: environment.PHONE_CONTROL_HOST || "127.0.0.1",
      port: validPort(environment.PHONE_CONTROL_PORT),
      token: environment.PHONE_CONTROL_TOKEN || randomBytes(32).toString("base64url"),
      machineName: environment.PHONE_CONTROL_MACHINE_NAME || os.hostname(),
      publicUrl: environment.PHONE_CONTROL_PUBLIC_URL || null,
      secureCookies: envBoolean(environment.PHONE_CONTROL_SECURE_COOKIES),
      retentionDays: validInteger(environment.PHONE_CONTROL_RETENTION_DAYS, DEFAULT_RETENTION_DAYS, { min: 1, max: 365 }),
      maxEventLogBytes: validInteger(environment.PHONE_CONTROL_MAX_EVENT_LOG_BYTES, DEFAULT_MAX_EVENT_LOG_BYTES, { min: 1024 * 1024 }),
      approvals: {
        enabled: envBoolean(environment.PHONE_CONTROL_APPROVALS_ENABLED),
        timeoutSeconds: validInteger(environment.PHONE_CONTROL_APPROVAL_TIMEOUT_SECONDS, 45, { min: 10, max: 55 }),
      },
      interactions: {
        enabled: envBoolean(environment.PHONE_CONTROL_INTERACTIONS_ENABLED, true),
      },
    };
    try {
      await writeFile(paths.config, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      stored = seed;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      stored = safeJsonParse(await readFile(paths.config, "utf8"));
    }
  }

  const config = {
    version: 3,
    host: environment.PHONE_CONTROL_HOST || stored?.host || "127.0.0.1",
    port: validPort(environment.PHONE_CONTROL_PORT ?? stored?.port),
    token: environment.PHONE_CONTROL_TOKEN || stored?.token || randomBytes(32).toString("base64url"),
    machineName: environment.PHONE_CONTROL_MACHINE_NAME || stored?.machineName || os.hostname(),
    publicUrl: environment.PHONE_CONTROL_PUBLIC_URL || stored?.publicUrl || null,
    secureCookies: envBoolean(environment.PHONE_CONTROL_SECURE_COOKIES, stored?.secureCookies || false),
    retentionDays: validInteger(environment.PHONE_CONTROL_RETENTION_DAYS ?? stored?.retentionDays, DEFAULT_RETENTION_DAYS, { min: 1, max: 365 }),
    maxEventLogBytes: validInteger(environment.PHONE_CONTROL_MAX_EVENT_LOG_BYTES ?? stored?.maxEventLogBytes, DEFAULT_MAX_EVENT_LOG_BYTES, { min: 1024 * 1024 }),
    approvals: {
      enabled: envBoolean(environment.PHONE_CONTROL_APPROVALS_ENABLED, stored?.approvals?.enabled || false),
      timeoutSeconds: validInteger(
        environment.PHONE_CONTROL_APPROVAL_TIMEOUT_SECONDS ?? stored?.approvals?.timeoutSeconds,
        45,
        { min: 10, max: 55 },
      ),
    },
    interactions: {
      enabled: envBoolean(
        environment.PHONE_CONTROL_INTERACTIONS_ENABLED,
        stored?.interactions?.enabled ?? true,
      ),
    },
    dataDir,
  };

  if (create && JSON.stringify(storedConfig(stored || {})) !== JSON.stringify(storedConfig(config))) {
    await writeConfigFile(paths.config, config);
  } else if (create) await chmod(paths.config, 0o600);
  return config;
}

export async function updateConfig(mutator, options = {}) {
  const config = await loadConfig(options);
  const next = mutator({
    ...config,
    approvals: { ...config.approvals },
    interactions: { ...config.interactions },
  }) || config;
  await writeConfigFile(dataPaths(next.dataDir).config, next);
  return next;
}

export function applyCliConfig(config, flags) {
  return {
    ...config,
    host: flags.host || config.host,
    port: flags.port == null ? config.port : validPort(flags.port, config.port),
  };
}
