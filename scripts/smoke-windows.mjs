import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright-core";
import net from "node:net";

if (process.platform !== "win32") throw new Error("Run the packaged Windows smoke check on Windows.");
const scratch = mkdtempSync(join(tmpdir(), "bops-smoke-"));
const probe = net.createServer();
await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const env = { ...process.env, BOPS_DESKTOP_USER_DATA: scratch, BOPS_DESKTOP_PORT: String(port) };
delete env.ELECTRON_RUN_AS_NODE;
// Do not use provider credentials from the build machine during the clean-install check.
for (const key of Object.keys(env)) if (/^(ORGO_|OPENAI_|BOPS_)/.test(key) && !["BOPS_DESKTOP_USER_DATA", "BOPS_DESKTOP_PORT"].includes(key)) delete env[key];
let app;
try {
  app = await _electron.launch({ executablePath: resolve(process.env.BOPS_SMOKE_EXE || "dist-desktop/win-unpacked/Bops.exe"), env, timeout: 60_000 });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Continue with Google" }).waitFor({ timeout: 90_000 });
  assert.equal(await page.title(), "Bops");
  const health = await page.evaluate(async () => (await fetch("/api/health")).json());
  assert.equal(health.bops, true);
  const auth = await page.evaluate(async () => (await fetch("/api/auth/status")).json());
  assert.equal(auth.signedIn, false);
  const perms = await page.evaluate(() => window.bopsMac.permissions.status(["automation", "fullDisk"]));
  assert.equal(perms.automation, "restricted");
  assert.equal(perms.fullDisk, "restricted");
  const output = resolve(".scratch/windows-smoke");
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, "sign-in.png") });
  await app.close();
  app = undefined;
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }));
  console.log("Packaged Windows app: sign-in, health, permissions and shutdown passed.");
} finally {
  if (app) await app.close().catch(() => {});
  rmSync(scratch, { force: true, recursive: true, maxRetries: 10, retryDelay: 250 });
}
