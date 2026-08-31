import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildFrpcConfig,
  buildRelaySystemdUnit,
  buildRelayTmuxLauncher,
  configureRelay,
  loadRelayConfig,
  updateRelayConfig,
} from "../src/relay-manager.mjs";
import { dataPaths } from "../src/paths.mjs";

export const tests = [
  {
    name: "builds an encrypted FRP v2 client with a local health check",
    async run() {
      const rendered = buildFrpcConfig({
        serverAddr: "relay.example.test",
        serverPort: 27070,
        authTokenFile: "/var/lib/phone-control/relay/token",
        proxyName: "GPU 03",
        localPort: 8787,
        remotePort: 27878,
      });
      assert.match(rendered, /transport\.tls\.enable = true/);
      assert.match(rendered, /transport\.wireProtocol = "v2"/);
      assert.match(rendered, /transport\.heartbeatInterval = 15/);
      assert.match(rendered, /transport\.heartbeatTimeout = 45/);
      assert.match(rendered, /transport\.useEncryption = true/);
      assert.match(rendered, /name = "gpu-03"/);
      assert.match(rendered, /path = "\/api\/health"/);
      assert.match(rendered, /remotePort = 27878/);
    },
  },
  {
    name: "rejects insecure relay URLs and weak authentication tokens",
    async run() {
      assert.throws(() => buildFrpcConfig({
        serverAddr: "relay.example.test",
        serverPort: 27070,
        authTokenFile: "relative-token",
        remotePort: 27878,
      }), /must be absolute/);
      const temporary = await mkdtemp(path.join(os.tmpdir(), "phone-control-relay-reject-"));
      try {
        const clientPath = path.join(temporary, "frpc");
        const tokenFile = path.join(temporary, "token");
        await writeFile(clientPath, "");
        await writeFile(tokenFile, "short");
        await assert.rejects(configureRelay({
          dataDir: temporary,
          clientPath,
          tokenFile,
          serverAddr: "relay.example.test",
          serverPort: 27070,
          remotePort: 27878,
          publicUrl: "https://relay.example.test:28443",
        }), /at least 32/);
        await writeFile(tokenFile, "a".repeat(64));
        await assert.rejects(configureRelay({
          dataDir: temporary,
          clientPath,
          tokenFile,
          serverAddr: "relay.example.test",
          serverPort: 27070,
          remotePort: 27878,
          publicUrl: "http://relay.example.test:28443",
        }), /must use HTTPS/);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  },
  {
    name: "persists relay metadata separately from its protected FRP token",
    async run() {
      const temporary = await mkdtemp(path.join(os.tmpdir(), "phone-control-relay-config-"));
      try {
        const clientPath = path.join(temporary, "frpc");
        const tokenFile = path.join(temporary, "token");
        const token = "b".repeat(64);
        await writeFile(clientPath, "");
        await chmod(clientPath, 0o700);
        await writeFile(tokenFile, token);
        const configured = await configureRelay({
          dataDir: temporary,
          clientPath,
          tokenFile,
          serverAddr: "203.0.113.7",
          serverPort: 27070,
          remotePort: 27878,
          publicUrl: "https://203.0.113.7:28443",
          localPort: 8787,
          proxyName: "Phone Control Test",
          previousPublicUrl: "https://old.example.test",
          previousSecureCookies: true,
        });
        assert.equal(configured.active, false);
        assert.equal(configured.previousPublicUrl, "https://old.example.test");
        assert.equal(configured.previousSecureCookies, true);
        const metadata = await readFile(dataPaths(temporary).relayConfig, "utf8");
        const clientConfig = await readFile(dataPaths(temporary).relayClientConfig, "utf8");
        assert.equal(metadata.includes(token), false);
        assert.equal(clientConfig.includes(token), false);
        assert.equal(await readFile(dataPaths(temporary).relayToken, "utf8"), token + "\n");
        const expectedPrivateMode = process.platform === "win32" ? 0o666 : 0o600;
        assert.equal((await stat(dataPaths(temporary).relayConfig)).mode & 0o777, expectedPrivateMode);
        assert.equal((await stat(dataPaths(temporary).relayClientConfig)).mode & 0o777, expectedPrivateMode);
        assert.equal((await stat(dataPaths(temporary).relayToken)).mode & 0o777, expectedPrivateMode);
        await updateRelayConfig(temporary, (current) => ({ ...current, active: true }));
        assert.equal((await loadRelayConfig(temporary)).active, true);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  },
  {
    name: "builds isolated relay service definitions without changing Phone Control",
    async run() {
      const options = {
        clientPath: "/opt/phone relay/frpc",
        clientConfigPath: "/var/lib/phone relay/frpc.toml",
        logPath: "/var/log/phone relay.log",
      };
      const systemd = buildRelaySystemdUnit(options);
      const tmux = buildRelayTmuxLauncher(options);
      assert.match(systemd, /outbound FRP relay/);
      assert.match(systemd, /Restart=always/);
      assert.match(tmux, /while true/);
      assert.match(tmux, /phone relay\.log/);
      assert.equal(systemd.includes("phone-control.service restart"), false);
    },
  },
];
