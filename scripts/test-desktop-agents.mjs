import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "sucrase";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "bops-desktop-agents-"));
for (const key of Object.keys(process.env)) if (/^(BOPS_|ORGO_|OPENAI_|ANTHROPIC_|COMPOSIO_|HONCHO_|AGENTMAIL_)/.test(key)) delete process.env[key];
Object.assign(process.env, { BOPS_SELF_HOSTED: "1", BOPS_UI_TOKEN: "desktop-test-window", NEXT_PUBLIC_BOPS_BRAINS: "0", BOPS_DESKTOP_USER_DATA: scratch, BOPS_CODEX_BIN: process.execPath, BOPS_HERMES_BIN: process.execPath, BOPS_CLAUDE_BIN: process.execPath });
process.chdir(scratch);
for (const name of ["node_modules", "vm"]) symlinkSync(join(root, name), join(scratch, name), process.platform === "win32" ? "junction" : "dir");
const seen = [];
let vmFailure = false;
let vmStarts = 0;
let vmStops = 0;
globalThis.__bopsTestVm = async () => {
  vmStarts++;
  if (vmFailure) throw new Error("Podman is unavailable");
  return { command: process.execPath, args: ["guest-mcp"], release: async () => { vmStops++; } };
};
const requests = [];
let settingsStatus = 200;
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname;
  requests.push({ path, method: options?.method, body: options?.body });
  if (path === "/api/bops/settings") return Response.json({}, { status: settingsStatus });
  throw new Error("Unexpected network call in desktop test");
};
let mode = "ok";
let claudeAuth = "claude.ai";
globalThis.__bopsNativeSpawn = (binary, args, options) => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 987654321, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.signalCode = "SIGTERM"; child.emit("close", null); } });
  let input = "";
  child.stdin.on("data", (chunk) => (input += chunk));
  seen.push({ binary, args, env: options.env, child, input: () => input });
  if (binary === "taskkill.exe") { queueMicrotask(() => { child.exitCode = 0; child.emit("close", 0); }); return child; }
  if (args.includes("-EncodedCommand")) {
    child.stdin.once("data", () => queueMicrotask(() => child.stdout.write("ready\n")));
    child.stdin.once("finish", () => { child.exitCode = 0; child.emit("close", 0); });
    return child;
  }
  if (args[0] === "login") {
    queueMicrotask(() => { child.stderr.write("Logged in using ChatGPT\n"); child.exitCode = 0; child.emit("close", 0); });
  } else if (args.includes("auth") && args.includes("status")) {
    queueMicrotask(() => { child.stdout.write(JSON.stringify({ loggedIn: true, authMethod: claudeAuth, apiProvider: "firstParty" })); child.exitCode = 0; child.emit("close", 0); });
  } else child.stdin.on("finish", () => {
    if (mode === "hang") return;
    queueMicrotask(() => {
      if (args[0] === "chat") child.stdout.write(JSON.stringify({ type: "result", text: "Hermes answer", exit_code: mode === "fail" ? 1 : 0 }) + "\n");
      else if (args[0] === "--print") child.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "Claude answer", is_error: false }) + "\n");
      else child.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex answer" } }) + "\n");
      child.exitCode = mode === "fail" ? 1 : 0;
      child.emit("close", child.exitCode);
    });
  });
  return child;
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    if (specifier === "./local-vm" && context.parentURL?.endsWith("/desktop-agents.ts")) return { url: "data:text/javascript,export const startLocalVm=()=>globalThis.__bopsTestVm()", shortCircuit: true };
    if (specifier === "node:child_process" && context.parentURL?.endsWith("/native-agents.ts")) return { url: "data:text/javascript,export const spawn=(...a)=>globalThis.__bopsNativeSpawn(...a)", shortCircuit: true };
    if (specifier.startsWith("@/")) specifier = pathToFileURL(join(root, specifier.slice(2))).href;
    try { return next(specifier, context); }
    catch (error) {
      if (/^(file:|\.{1,2}\/)/.test(specifier)) for (const ext of [".ts", ".tsx"]) { try { return next(specifier + ext, context); } catch {} }
      throw error;
    }
  },
  load(url, context, next) {
    if (url.endsWith(".ts") || url.endsWith(".tsx")) return { format: "module", shortCircuit: true, source: transform(readFileSync(new URL(url), "utf8"), { transforms: url.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"], jsxRuntime: "automatic", filePath: fileURLToPath(url) }).code };
    return next(url, context);
  },
});

try {
  const N = await import(pathToFileURL(join(root, "lib/server/native-agents.ts")).href);
  assert.throws(() => N.nativeArgs("hermes", scratch, false), /Enable Full access/);
  assert.ok(N.nativeArgs("hermes", scratch, true).includes("--yolo"));
  assert.ok(N.nativeArgs("codex", scratch, false).includes('forced_login_method="chatgpt"'));
  process.env.BOPS_UI_TOKEN = "desktop-test-window";
  process.env.OPENAI_API_KEY = "not-a-real-provider-key";
  const clean = N.nativeEnvironment("codex");
  assert.equal(clean.BOPS_UI_TOKEN, undefined); assert.equal(clean.OPENAI_API_KEY, undefined);
  const result = await N.runNative({ kind: "codex", binary: process.execPath, cwd: scratch, prompt: "literal $() `quotes`\nnext line", fullAccess: false });
  assert.equal(result.text, "Codex answer");
  const invocation = seen.findLast((x) => x.args[0] === "exec");
  assert.equal(invocation.input(), "literal $() `quotes`\nnext line");
  assert.ok(!invocation.args.join(" ").includes("literal"));
  mode = "fail";
  await assert.rejects(N.runNative({ kind: "hermes", binary: process.execPath, cwd: scratch, prompt: "test", fullAccess: true }), /did not finish/);
  mode = "hang";
  await assert.rejects(N.runNative({ kind: "codex", binary: process.execPath, cwd: scratch, prompt: "test", fullAccess: false, timeoutMs: 20 }), /run limit/);
  mode = "ok";
  const S = await import(pathToFileURL(join(root, "lib/server/store.ts")).href);
  const A = await import(pathToFileURL(join(root, "lib/agents.ts")).href);
  const B = await import(pathToFileURL(join(root, "lib/server/bot-ai.ts")).href);
  const D = await import(pathToFileURL(join(root, "lib/server/desktop-agents.ts")).href);
  const R = await import(pathToFileURL(join(root, "app/api/desktop-agents/route.ts")).href);
  const b = S.getState().bots[0];
  assert.ok(b);
  const chatId = S.getState().chats.find((c) => c.kind === "bot" && c.botIds.includes(b.id)).id;
  const h = {};
  B.setBotAi(b.id, { op: "add", kind: "hermes", pays: "local" }, h);
  B.setBotAi(b.id, { op: "default", agentId: h.added });
  assert.equal(D.hermesFullAccess(b.id, h.added), false);
  await D.desktopChat(chatId, "test before grant");
  assert.match(S.getState().messages.at(-1).text, /Enable Full access/);
  const request = (body, token = "desktop-test-window") => new Request("http://localhost/api/desktop-agents", { method: "POST", headers: { "Content-Type": "application/json", "x-bops-window": token }, body: JSON.stringify(body) });
  assert.equal((await R.POST(request({ op: "access", botId: b.id, agentId: h.added, fullAccess: true }, "wrong"))).status, 403);
  assert.equal(D.hermesFullAccess(b.id, h.added), false);
  const grant = await R.POST(request({ op: "access", botId: b.id, agentId: h.added, fullAccess: true }));
  assert.equal(grant.status, 200);
  assert.equal(D.hermesFullAccess(b.id, h.added), true);
  await D.desktopChat(chatId, "test with grant");
  assert.equal(S.getState().messages.at(-1).text, "Hermes answer");
  mode = "hang";
  const pending = D.desktopChat(chatId, "a long run");
  await new Promise((resolve) => setTimeout(resolve, 20));
  D.setHermesAccess(b.id, h.added, false);
  await pending;
  assert.match(S.getState().messages.at(-1).text, /stopped/);
  mode = "ok";
  const c = {};
  B.setBotAi(b.id, { op: "add", kind: "codex", pays: "plan" }, c);
  B.setBotAi(b.id, { op: "default", agentId: c.added });
  const profile = A.aiOf(S.getState().bots[0], S.getState());
  assert.ok(profile.agents.some((a) => a.id === c.added && a.account === undefined));
  await D.desktopChat(chatId, "subscription test");
  assert.equal(S.getState().messages.at(-1).text, "Codex answer");
  mode = "hang";
  const codexRun = D.desktopChat(chatId, "a Codex run");
  await new Promise((resolve) => setTimeout(resolve, 20));
  D.setHermesAccess(b.id, h.added, false);
  assert.equal((await D.desktopAgentInfo(b.id, c.added)).running, true, "Hermes grants do not stop a different agent");
  D.stopDesktopRun(b.id, c.added);
  await codexRun;
  mode = "ok";
  const cl = {};
  B.setBotAi(b.id, { op: "add", kind: "claude", pays: "local" }, cl);
  B.setBotAi(b.id, { op: "default", agentId: cl.added });
  assert.equal(A.defaultAgent(S.getState().bots[0], S.getState()).account, undefined);
  claudeAuth = "api_key";
  const before = seen.filter((x) => x.args[0] === "--print").length;
  await D.desktopChat(chatId, "this cannot use API billing");
  assert.match(S.getState().messages.at(-1).text, /Sign in to your Claude subscription/);
  assert.equal(seen.filter((x) => x.args[0] === "--print").length, before);
  claudeAuth = "claude.ai";
  process.env.ANTHROPIC_API_KEY = "not-a-real-anthropic-key";
  await D.desktopChat(chatId, "Claude subscription test");
  assert.equal(S.getState().messages.at(-1).text, "Claude answer");
  assert.equal(seen.findLast((x) => x.args[0] === "--print").env.ANTHROPIC_API_KEY, undefined);
  if (process.platform === "win32") {
    const H = await import(pathToFileURL(join(root, "app/api/host/route.ts")).href);
    const P = await import(pathToFileURL(join(root, "app/api/runs-on/route.ts")).href);
    const U = await import(pathToFileURL(join(root, "app/api/routines/route.ts")).href);
    const Q = await import(pathToFileURL(join(root, "lib/server/routines.ts")).href);
    const M = await import(pathToFileURL(join(root, "lib/server/routine-sync.ts")).href);
    const L = await import(pathToFileURL(join(root, "lib/server/runner.ts")).href);
    process.env.ORGO_API_KEY = "fixture-desktop-policy-key";
    S.update((s) => { s.host = "orgo"; s.account = { user: { id: "test-pc-owner" } }; });
    assert.equal((await H.POST(request({ host: "mac" }, "wrong"))).status, 403);
    settingsStatus = 503;
    assert.equal((await H.POST(request({ host: "mac" }))).status, 502);
    assert.equal(D.localRoutinesHere(), false, "a failed cloud scheduling switch cannot arm this PC");
    settingsStatus = 200;
    assert.equal((await H.POST(request({ host: "mac" }))).status, 200);
    assert.equal(requests.at(-1).body, '{"runsOn":"mac"}');
    assert.equal((await P.POST(request({ runsOn: "cloud" }))).status, 409);
    assert.equal(D.localRoutinesHere(), true);
    const networkBefore = requests.length;
    const { routine } = Q.createRoutine(b.id, "Local VM check", "Read the guest display size", { kind: "daily", time: "10:00" }, { run: "task", where: "cloud" });
    assert.ok(routine);
    const pc = S.getState().desktopRoutineDevice;
    S.update((s) => {
      b.computerId = "fixture-cloud-computer";
      s.runners = { [b.computerId]: { status: "running" } };
      delete s.desktopRoutineDevice;
    });
    assert.equal(L.runnerRuns(routine), true, "this routine otherwise has a cloud runner");
    S.update((s) => { s.desktopRoutineDevice = pc; });
    const mirror = M.routinePayload(routine);
    assert.equal(mirror.onMac, true);
    assert.equal(mirror.nextRunAt, undefined);
    S.update((s) => { s.desktopRoutineAfter = Date.now() + 60_000; });
    const waiting = await U.PATCH(request({ id: routine.id, action: "run" }));
    assert.equal(waiting.status, 409);
    assert.match((await waiting.json()).error, /Cloud scheduling was just turned off/);
    S.update((s) => { delete s.desktopRoutineAfter; });
    assert.equal((await Q.runRoutine(routine.id, { manual: "external-message" })).status, "skipped");
    assert.equal(vmStarts, 0);
    const due = Date.now() - 10;
    S.update(() => { routine.nextRunAt = due; });
    globalThis.__bopsRoutineTick();
    for (let i = 0; i < 100 && routine.last?.status !== "ok"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(routine.last?.status, "ok", "the actual timer dispatches to the local desktop agent");
    assert.ok(routine.nextRunAt > due);
    assert.equal(S.getState().messages.at(-1).text, "Claude answer");
    assert.ok(seen.findLast((x) => x.args[0] === "--print").args.some((x) => x.includes("guest-mcp")));
    assert.equal(vmStarts, 1); assert.equal(vmStops, 1);

    B.setBotAi(b.id, { op: "default", agentId: c.added });
    vmFailure = true;
    const blocked = await Q.runRoutine(routine.id, { manual: "app" });
    assert.equal(blocked.status, "failed"); assert.match(blocked.error, /Podman/);
    vmFailure = false;
    S.update(() => { routine.run = "chat"; });
    assert.equal((await Q.runRoutine(routine.id, { manual: "app" })).status, "ok");
    const restricted = seen.findLast((x) => x.args[0] === "exec");
    assert.ok(restricted.args.includes("--ignore-user-config"));
    assert.ok(restricted.args.includes("read-only"));
    assert.ok(restricted.args.includes("shell_tool"));
    assert.equal(vmStarts, 2, "text-only routines start no VM");

    B.setBotAi(b.id, { op: "default", agentId: h.added });
    D.setHermesAccess(b.id, h.added, true);
    const hermesBefore = seen.length;
    assert.match((await Q.runRoutine(routine.id, { manual: "app" })).error, /scoped Local VM tool bridge/);
    assert.equal(seen.length, hermesBefore, "a host Full access grant never gives a scheduled job host tools");
    D.setHermesAccess(b.id, h.added, false);
    const pcTask = D.startPcTask(b.id, c.added, "Do a task in the Podman guest");
    assert.equal(pcTask.pcTask, true);
    for (let i = 0; i < 100 && S.session(pcTask.id)?.status === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(S.session(pcTask.id)?.status, "done");
    assert.equal(S.session(pcTask.id)?.answer, "Codex answer");
    assert.ok(seen.findLast((x) => x.args[0] === "exec").args.some((x) => x.includes("guest-mcp")));
    assert.equal(vmStarts, 3); assert.equal(vmStops, 2);
    const stoppedTask = D.startPcTask(b.id, c.added, "Stop before launching");
    D.stopPcTask(stoppedTask, "Stopped by you");
    assert.equal(S.session(stoppedTask.id)?.status, "failed");
    assert.throws(() => D.startPcTask(b.id, h.added, "Windows host tools"), /Choose Codex or Claude Code/);
    S.update(() => { routine.deliverTo = { kind: "text", to: "fake" }; });
    assert.match((await Q.runRoutine(routine.id, { manual: "app" })).error, /standalone routines/);
    const binding = S.getState().desktopRoutineDevice;
    S.update((s) => { s.desktopRoutineDevice = "another-pc"; routine.nextRunAt = due; });
    globalThis.__bopsRoutineTick();
    assert.equal(routine.nextRunAt, due, "other devices don't consume due times");
    assert.equal((await Q.runRoutine(routine.id, { manual: "app" })).status, "skipped");
    assert.equal(requests.length, networkBefore, "no fallback model or Orgo request was made for any local run");
    S.update((s) => { s.desktopRoutineDevice = binding; });
    assert.equal((await H.POST(request({ host: "orgo" }))).status, 200);
    assert.equal(requests.at(-1).body, '{"runsOn":"cloud"}');
    S.update((s) => { delete s.account; delete s.runners; delete b.computerId; });
  }
  B.setBotAi(b.id, { op: "default", agentId: "bops" });
  assert.equal(A.defaultAgent(S.getState().bots[0], S.getState()).id, "bops");
  S.update((s) => { s.shared = { ownerName: "owner" }; });
  assert.throws(() => D.setHermesAccess(b.id, h.added, true), /Only the owner/);
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { DesktopAgentControls } = await import(pathToFileURL(join(root, "components/app/desktop-agent-controls.tsx")).href);
  const html = renderToStaticMarkup(createElement(DesktopAgentControls, { botId: b.id, agent: { id: h.added, kind: "hermes", pays: "local" }, readOnly: false }));
  assert.match(html, /Full access for Hermes/); assert.match(html, /aria-checked="false"/);
  console.log("Desktop agent checks passed: Codex and Claude subscriptions, API key rejection, stdin, Hermes access and owner-only controls with cloud agents off.");
} finally {
  process.chdir(root);
  rmSync(scratch, { force: true, recursive: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(0);
