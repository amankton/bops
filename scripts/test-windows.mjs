import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { windowsVault } from "../lib/server/windows-vault.ts";

const require = createRequire(import.meta.url);
const { renderEndpoint, linkServer } = require("../desktop/platform.cjs");
const scratch = mkdtempSync(join(tmpdir(), "bops-windows-"));
try {
  const endpoint = renderEndpoint(scratch, "win32");
  assert.ok(endpoint.startsWith("\\\\.\\pipe\\bops-render-"));
  assert.notEqual(endpoint, renderEndpoint(`${scratch}-other`, "win32"));
  if (process.platform === "win32") {
    // A real named pipe round trip verifies Node accepts the endpoint, including a path with spaces.
    const server = net.createServer((socket) => socket.end("ok"));
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
    try {
      const reply = await new Promise((resolve, reject) => {
        let text = "";
        const client = net.connect(endpoint);
        client.on("data", (chunk) => (text += chunk));
        client.on("end", () => resolve(text));
        client.on("error", reject);
      });
      assert.equal(reply, "ok");
    } finally { await new Promise((resolve) => server.close(resolve)); }
    const bundle = join(scratch, "bundle");
    const home = join(scratch, "user data", "server");
    mkdirSync(join(bundle, "node_modules"), { recursive: true });
    writeFileSync(join(bundle, "server.js"), "first");
    writeFileSync(join(bundle, ".env.local"), "must not ship");
    linkServer(bundle, home, "win32");
    writeFileSync(join(home, ".data", "state.json"), "saved");
    writeFileSync(join(bundle, "server.js"), "updated");
    linkServer(bundle, home, "win32");
    assert.equal(readFileSync(join(home, "server.js"), "utf8"), "updated");
    assert.equal(readFileSync(join(home, ".data", "state.json"), "utf8"), "saved");
    assert.ok(!readdirSync(home).includes(".env.local"));
    const vaultDir = join(scratch, "vault");
    const vault = windowsVault(vaultDir);
    const value = 'Unicode 🔐, quotes " and newlines\n$env:PATH';
    assert.equal(await vault.get("missing"), null);
    await vault.set("alice:login", value);
    assert.equal(await vault.get("alice:login"), value);
    assert.equal(await vault.get("bob:login"), null);
    const stored = readFileSync(join(vaultDir, readdirSync(vaultDir)[0]));
    assert.ok(!stored.includes(Buffer.from(value)));
    await vault.set("alice:login", "replacement");
    assert.equal(await vault.get("alice:login"), "replacement");
    await vault.set("alice:login", "");
    assert.equal(await vault.get("alice:login"), "");
    writeFileSync(join(vaultDir, readdirSync(vaultDir)[0]), "corrupted");
    await assert.rejects(vault.get("alice:login"), /secure storage/);
    await vault.delete("alice:login");
    await vault.delete("alice:login");
    assert.equal(await vault.get("alice:login"), null);
  }
  console.log("Windows platform checks passed.");
} finally { rmSync(scratch, { recursive: true, force: true }); }
