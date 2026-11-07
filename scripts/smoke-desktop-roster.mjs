import assert from "node:assert/strict";
import { _electron } from "playwright-core";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";

const scratch = mkdtempSync(join(tmpdir(), "bops-roster-smoke-"));
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const env = { ...process.env, BOPS_DESKTOP_USER_DATA: scratch, BOPS_DESKTOP_PORT: String(port) };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (/^(ORGO_|OPENAI_|BOPS_)/.test(key) && !["BOPS_DESKTOP_USER_DATA", "BOPS_DESKTOP_PORT"].includes(key)) delete env[key];
writeFileSync(join(scratch, ".env.local"), 'BOPS_SELF_HOSTED=1\nORGO_API_KEY=smoke-fixture-not-a-real-key\nBOPS_ORGO_ORIGIN=http://127.0.0.1:9\n');
const data = join(scratch, "server", ".data");
mkdirSync(data, { recursive: true });
writeFileSync(join(data, "state.json"), JSON.stringify({ host: "orgo", owner: { name: "Desktop test" }, workspaces: [{ id: "ws_main", name: "Test", createdAt: 1 }], workspace: "ws_main", bots: [{ id: "boppy", name: "Boppy", role: "Assistant", color: "#E9FF3B", isMain: true, computerStatus: "none", workspaceId: "ws_main" }], chats: [{ id: "chat_boppy", kind: "bot", botIds: ["boppy"], createdAt: 1, typing: [], workspaceId: "ws_main" }], messages: [], sessions: [], routines: [] }));
let app;
try {
  app = await _electron.launch({ executablePath: resolve(process.env.BOPS_SMOKE_EXE || "dist-desktop/win-unpacked/Bops.exe"), env, timeout: 60_000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.waitForURL(`http://localhost:${port}/`, { timeout: 90_000 });
  await page.getByText("Boppy", { exact: true }).first().waitFor({ timeout: 60_000 });
  const call = (body) => page.evaluate(async (body) => {
    const res = await fetch("/api/bots/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ botId: "boppy", ...body }) });
    return { status: res.status, body: await res.json() };
  }, body);
  const add = async (roster, label) => {
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/bots/ai") && r.request().method() === "POST"),
      roster.getByRole("button", { name: `Add ${label}`, exact: true }).click(),
    ]);
    assert.equal(res.status(), 200);
    const { added } = await res.json();
    assert.ok(added);
    return added;
  };
  await page.getByRole("button", { name: /team, account and settings/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.locator('[data-settings-nav="ai"]').click();
  await add(page.getByRole("region", { name: "Desktop agents" }), "Claude subscription");
  await page.keyboard.press("Escape");
  await page.getByTitle("Boppy's profile", { exact: true }).click();
  await page.locator('[data-page-row="AI"]').click();
  const roster = page.locator("#settings-ai-body").getByRole("region", { name: "Desktop agents" });
  await roster.getByRole("button", { name: /^Claude Code/ }).waitFor();
  const codex = await add(roster, "Codex subscription");
  const hermes = await add(roster, "Hermes");
  assert.equal((await call({ op: "default", agentId: hermes })).status, 200);
  const access = (on) => page.evaluate(async ({ agentId, on }) => {
    const res = await fetch("/api/desktop-agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "access", botId: "boppy", agentId, fullAccess: on }) });
    return { status: res.status, body: await res.json() };
  }, { agentId: hermes, on });
  const on = await access(true);
  assert.equal(on.status, 200); assert.equal(on.body.fullAccess, true);
  const off = await access(false);
  assert.equal(off.status, 200); assert.equal(off.body.fullAccess, false);
  // The owner's normal application cookie authorizes the controls; unrelated pages cannot grant access.
  const denied = await fetch(`http://127.0.0.1:${port}/api/desktop-agents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "access", botId: "boppy", agentId: hermes, fullAccess: true }) });
  assert.equal(denied.status, 403);
  const toggle = roster.getByRole("switch", { name: "Full access for Hermes" });
  await toggle.waitFor();
  if (await toggle.isEnabled()) {
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Full access for Hermes"]')?.getAttribute("aria-checked") === "true");
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Full access for Hermes"]')?.getAttribute("aria-checked") === "false");
  }
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Agent for new tasks:/ }).click();
  const picker = page.getByRole("menu", { name: "Agent for new tasks" });
  await picker.getByRole("menuitemradio", { name: /Codex/ }).waitFor();
  await picker.getByRole("menuitemradio", { name: /Claude Code/ }).waitFor();
  const hermesChoice = picker.getByRole("menuitemradio", { name: /Hermes/ });
  await hermesChoice.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[role="menuitemradio"]')].some((item) => item.textContent.includes("Hermes") && item.textContent.includes("access off") && item.getAttribute("aria-disabled") === "true"));
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /team, account and settings/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.locator('[data-settings-nav="mac"]').click();
  const thisPc = page.getByRole("button", { name: /^This PC Run local threads and routines/ });
  await thisPc.click();
  await thisPc.and(page.locator('[aria-pressed="true"]')).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await page.getByRole("button", { name: "New local routine", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Guest desktop check");
  await page.getByLabel("What it does", { exact: true }).fill("Use the bops_vm get_screen_size tool to read the guest display. Reply with its width and height.");
  await page.getByRole("button", { name: "Save routine", exact: true }).click();
  await page.locator("[data-row-head][aria-expanded]").filter({ hasText: "Guest desktop check" }).click();
  const state = () => page.evaluate(async () => (await (await fetch("/api/state")).json()).state);
  const routineId = (await state()).routines.find((r) => r.title === "Guest desktop check").id;
  const run = async () => {
    await page.locator(`[data-item="${routineId}"]`).getByRole("button", { name: "Run now", exact: true }).click();
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const last = (await state()).routines.find((r) => r.id === routineId).last;
      if (last && last.status !== "running") return last;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("The packaged local routine did not finish within 90 seconds.");
  };
  if (process.env.BOPS_SMOKE_LOCAL_VM === "1") {
    assert.equal((await call({ op: "default", agentId: codex })).status, 200);
    const result = await run();
    assert.equal(result.status, "ok", result.error);
    const report = (await state()).messages.find((m) => m.routine?.id === routineId && m.role === "bot");
    assert.match(report?.text ?? "", /1,?280.*900/s);
  } else {
    const result = await run();
    assert.equal(result.status, "failed");
    assert.match(result.error, /Hermes needs a scoped Local VM tool bridge/);
  }
  const output = resolve(".scratch/windows-smoke"); mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, "desktop-roster.png") });
  console.log("Packaged checks passed: desktop roster, grants and chat picker, This PC switch, local routine form and Run now.");
} finally {
  if (app) await app.close().catch(() => {});
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
