import { copyFile, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const RUNTIME_SOURCE_FILES = [
  "config.mjs",
  "hook-normalizer.mjs",
  "hook-runtime.mjs",
  "http-client.mjs",
  "paths.mjs",
  "spool.mjs",
  "utils.mjs",
];

const RUNTIME_SCRIPT_FILES = ["hook.mjs", "permission-hook.mjs"];

function safeVersion(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._+-]/g, "_");
}

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// Plugin cache directories are versioned and may be pruned while a long-lived
// Codex App Server still has the old hook command in memory. Keep an atomic,
// versioned copy in PLUGIN_DATA, whose path is stable across plugin upgrades.
export async function ensureStableHookRuntime() {
  const pluginRoot = process.env.PLUGIN_ROOT;
  const pluginData = process.env.PLUGIN_DATA;
  if (!pluginRoot || !pluginData) return null;

  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  const version = safeVersion(manifest.version);
  const runtimesDir = path.join(pluginData, "hook-runtimes");
  const runtimeDir = path.join(runtimesDir, version);
  const readyFile = path.join(runtimeDir, ".ready");
  if (!(await fileExists(readyFile))) {
    const temporary = path.join(runtimesDir, `.next-${version}-${process.pid}-${Date.now()}`);
    await mkdir(path.join(temporary, "scripts"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(temporary, "src"), { recursive: true, mode: 0o700 });
    try {
      await Promise.all([
        ...RUNTIME_SCRIPT_FILES.map((file) => copyFile(
          path.join(pluginRoot, "scripts", file),
          path.join(temporary, "scripts", file),
        )),
        ...RUNTIME_SOURCE_FILES.map((file) => copyFile(
          path.join(pluginRoot, "src", file),
          path.join(temporary, "src", file),
        )),
      ]);
      await writeFile(path.join(temporary, ".ready"), `${manifest.version}\n`, { mode: 0o600 });
      try {
        await rename(temporary, runtimeDir);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
        await rm(temporary, { recursive: true, force: true });
      }
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  const stableLink = path.join(pluginData, "hook-runtime");
  const relativeTarget = path.relative(pluginData, runtimeDir);
  let currentTarget = null;
  try {
    currentTarget = await readlink(stableLink);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EINVAL") throw error;
  }
  if (currentTarget !== relativeTarget) {
    const temporaryLink = path.join(pluginData, `.hook-runtime-${process.pid}-${Date.now()}`);
    await mkdir(pluginData, { recursive: true, mode: 0o700 });
    await symlink(relativeTarget, temporaryLink, "dir");
    try {
      await rename(temporaryLink, stableLink);
    } catch (error) {
      await rm(temporaryLink, { force: true });
      throw error;
    }
  }
  return runtimeDir;
}
