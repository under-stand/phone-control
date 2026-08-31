import { access, lstat, mkdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MARKETPLACE_NAME = "phone-control";
export const PLUGIN_NAME = "plugin-phone-control";

/**
 * Build the small marketplace manifest Codex expects at
 * <marketplace-root>/.agents/plugins/marketplace.json.
 *
 * The checkout is intentionally kept outside that generated directory. This
 * makes a standalone clone work without adding Codex's marketplace metadata to
 * the plugin repository, and lets the same installer work from ZIP extracts,
 * Linux, macOS, WSL and Windows paths.
 */
export function buildMarketplaceManifest({ pluginRoot, marketplaceRoot }) {
  const resolvedPluginRoot = path.resolve(pluginRoot);
  const resolvedMarketplaceRoot = path.resolve(marketplaceRoot);
  const relativePluginPath = resolvedPluginRoot === resolvedMarketplaceRoot
    ? "."
    : "./plugins/plugin-phone-control";

  return {
    name: MARKETPLACE_NAME,
    interface: { displayName: "Phone Control" },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: { source: "local", path: relativePluginPath },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ],
  };
}

export function defaultMarketplaceRoot(homeDir = os.homedir()) {
  return path.join(homeDir, ".phone-control", "marketplace");
}

export async function writeMarketplaceManifest({ pluginRoot, marketplaceRoot = defaultMarketplaceRoot() }) {
  const resolvedPluginRoot = path.resolve(pluginRoot);
  const resolvedMarketplaceRoot = path.resolve(marketplaceRoot);
  await access(path.join(resolvedPluginRoot, ".codex-plugin", "plugin.json"));
  if (resolvedPluginRoot !== resolvedMarketplaceRoot) {
    const linkPath = path.join(resolvedMarketplaceRoot, "plugins", PLUGIN_NAME);
    await mkdir(path.dirname(linkPath), { recursive: true, mode: 0o700 });
    let linkExists = false;
    try {
      const stat = await lstat(linkPath);
      linkExists = true;
      if (!stat.isSymbolicLink()) {
        throw new Error(`Marketplace plugin path already exists and is not managed: ${linkPath}`);
      }
      const linkTarget = await realpath(linkPath).catch(() => null);
      if (linkTarget !== resolvedPluginRoot) {
        await unlink(linkPath);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!linkExists || !(await lstat(linkPath).then(() => true).catch(() => false))) {
      await symlink(resolvedPluginRoot, linkPath, process.platform === "win32" ? "junction" : "dir");
    }
  }
  const manifestPath = path.join(resolvedMarketplaceRoot, ".agents", "plugins", "marketplace.json");
  await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  await writeFile(
    manifestPath,
    `${JSON.stringify(buildMarketplaceManifest({ pluginRoot: resolvedPluginRoot, marketplaceRoot: resolvedMarketplaceRoot }), null, 2)}\n`,
    { mode: 0o600 },
  );
  return { marketplaceRoot: resolvedMarketplaceRoot, manifestPath };
}
