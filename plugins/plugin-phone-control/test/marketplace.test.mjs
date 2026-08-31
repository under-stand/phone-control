import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { buildMarketplaceManifest, defaultMarketplaceRoot, writeMarketplaceManifest } from "../src/marketplace.mjs";

export const tests = [
  {
    name: "builds a standalone marketplace manifest with a portable relative source",
    async run() {
      const manifest = buildMarketplaceManifest({
        pluginRoot: "/tmp/phone-control/source",
        marketplaceRoot: "/tmp/phone-control/marketplace",
      });
      assert.equal(manifest.name, "phone-control");
      assert.equal(manifest.plugins[0].name, "plugin-phone-control");
      assert.equal(manifest.plugins[0].source.source, "local");
      assert.equal(manifest.plugins[0].source.path, "./plugins/plugin-phone-control");
      assert.equal(manifest.plugins[0].policy.installation, "AVAILABLE");
    },
  },
  {
    name: "writes the marketplace manifest without touching the plugin checkout",
    async run() {
      const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "phone-control-marketplace-"));
      try {
        const pluginRoot = path.join(temporaryRoot, "source");
        const marketplaceRoot = path.join(temporaryRoot, "marketplace");
        await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
        await writeFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "{}\n");
        const result = await writeMarketplaceManifest({ pluginRoot, marketplaceRoot });
        const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
        assert.equal(manifest.plugins[0].source.path, "./plugins/plugin-phone-control");
        // Windows may return the short 8.3 spelling for os.tmpdir() while
        // realpath() resolves the symlink to the long spelling. Compare
        // canonical paths on both sides so the assertion is platform-neutral.
        assert.equal(
          await realpath(path.join(marketplaceRoot, "plugins", "plugin-phone-control")),
          await realpath(pluginRoot),
        );
        assert.equal(
          defaultMarketplaceRoot("/home/example"),
          path.join("/home/example", ".phone-control", "marketplace"),
        );
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  },
];
