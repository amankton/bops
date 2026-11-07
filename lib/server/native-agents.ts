import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { VmMcp } from "./local-vm";
import type { DesktopAppsMcp } from "./desktop-apps";

export type DesktopKind = "codex" | "hermes" | "claude";
const NATIVE_NAMES: Record<DesktopKind, string> = { codex: "Codex", hermes: "Hermes", claude: "Claude Code" };
const CLAUDE_SETTINGS = ["--setting-sources", ""];
const APPS_TOKEN_ENV = "BOPS_APPS_MCP_TOKEN";
const APP_TOOLS = ["find_app_actions", "use_app"];
const VM_TOOLS = [
  "list_apps", "list_windows", "get_window_state", "verify_state", "launch_app", "kill_app", "bring_to_front", "set_window_frame", "invoke_menu",
  "click", "double_click", "right_click", "drag", "type_text", "press_key", "hotkey", "set_value", "scroll", "clipboard_read", "clipboard_write",
  "get_screen_size", "get_desktop_state", "move_cursor", "get_accessibility_tree", "health_report", "zoom",
  "page", "get_browser_state", "browser_prepare", "browser_navigate", "browser_click", "browser_type", "browser_dialog", "browser_set_input_files", "browser_download",
];
export function nativeBinary(kind: DesktopKind): string | undefined {
  const override = process.env[`BOPS_${kind.toUpperCase()}_BIN`];
  const exe = process.platform === "win32" ? `${kind}.exe` : kind;
  const paths = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const npmRoots = [...paths, join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "npm")];
  const target = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`;
  const candidates = [
    ...(override ? [override] : []),
    ...(kind === "hermes" && process.platform === "win32" ? [join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "hermes", "bin", exe)] : []),
    ...(kind === "claude" ? [join(homedir(), ".local", "bin", exe)] : []),
    ...paths.map((dir) => join(dir, exe)),
    ...(kind === "codex" && process.platform === "win32" ? npmRoots.flatMap((dir) => {
      const pkg = join(dir, "node_modules", "@openai", "codex");
      return [join(pkg, "node_modules", "@openai", `codex-win32-${process.arch}`, "vendor", target, "bin", exe), join(pkg, "vendor", target, "bin", exe)];
    }) : []),
  ];
  return candidates.find((file) => {
    try { return isAbsolute(file) && !/\.(cmd|bat|ps1)$/i.test(file) && existsSync(file) && statSync(file).isFile(); }
    catch { return false; }
  });
}

/** The CLIs own their logins. Never pass Bops' window token, service keys or account state to a child. */
export function nativeEnvironment(kind: DesktopKind, localVm = false): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(BOPS_|ORGO_|OPENAI_|ANTHROPIC_|COMPOSIO_|AGENTMAIL_|AGENTPHONE_|HONCHO_|POSTHOG_|CLAUDE_CODE_USE_)/i.test(key) || /^(CODEX_API_KEY|CODEX_ACCESS_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete env[key];
  if (localVm) for (const key of Object.keys(env)) if (/^(CONTAINER_HOST|CONTAINER_CONNECTION|CONTAINER_SSHKEY|DOCKER_HOST|PODMAN_CONNECTIONS_CONF|CONTAINERS_CONF|CONTAINERS_CONF_OVERRIDE)$/i.test(key)) delete env[key];
  if (kind === "hermes") {
    delete env.HERMES_HOME;
    if (process.env.BOPS_HERMES_HOME) env.HERMES_HOME = process.env.BOPS_HERMES_HOME;
  }
  return env;
}

export function stopNative(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => { child.kill(); });
  } else {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

// A private kill-on-close Windows Job owns the CLI and its tools, including tools that outlive the CLI.
const JOB_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class BopsAgentJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long UserTime, JobTime; public uint Flags; public UIntPtr Min, Max; public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Basic; public IO IO; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr info, uint length);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
  public static void Run(int pid) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("job");
    try {
      Extended info = new Extended(); info.Basic.Flags = 0x2000;
      int size = Marshal.SizeOf(info); IntPtr memory = Marshal.AllocHGlobal(size);
      try { Marshal.StructureToPtr(info, memory, false); if (!SetInformationJobObject(job, 9, memory, (uint)size)) throw new Exception("limits"); }
      finally { Marshal.FreeHGlobal(memory); }
      using (Process process = Process.GetProcessById(pid)) { if (!AssignProcessToJobObject(job, process.Handle)) throw new Exception("assign"); }
      bool awake = Environment.GetEnvironmentVariable("BOPS_KEEP_AWAKE") != "0" && SetThreadExecutionState(0x80000001U) != 0;
      Console.WriteLine("ready"); Console.Out.Flush();
      try { while (Console.ReadLine() != null) {} }
      finally { if (awake) SetThreadExecutionState(0x80000000U); }
    } finally { CloseHandle(job); }
  }
}
'@
try { [BopsAgentJob]::Run([int][Console]::ReadLine()) } catch { exit 1 }
`;

function bindWindowsJob(child: ChildProcess, kind: DesktopKind, lost: () => void): Promise<() => void> {
  if (process.platform !== "win32") return Promise.resolve(() => {});
  return new Promise((resolve, reject) => {
    const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const env = { ...nativeEnvironment(kind), BOPS_KEEP_AWAKE: process.env.BOPS_KEEP_AWAKE };
    const owner = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(JOB_SCRIPT, "utf16le").toString("base64")], { env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let ready = false, closed = false;
    const timer = setTimeout(() => { owner.kill(); reject(new Error("Windows could not start the agent's process container.")); }, 10_000);
    owner.stdin.on("error", () => {});
    owner.stdout.setEncoding("utf8").on("data", (data: string) => {
      if (ready || !data.includes("ready")) return;
      ready = true; clearTimeout(timer);
      resolve(() => { closed = true; owner.stdin.end(); });
    });
    owner.on("error", () => { clearTimeout(timer); reject(new Error("Windows could not start the agent's process container.")); });
    owner.on("close", () => { clearTimeout(timer); if (!ready) reject(new Error("Windows could not contain the agent process.")); else if (!closed) lost(); });
    owner.stdin.write(`${child.pid}\n`);
  });
}

export function nativeArgs(kind: DesktopKind, cwd: string, fullAccess: boolean, model?: string, routine?: { vm?: VmMcp }, apps?: DesktopAppsMcp) {
  if (kind === "hermes") {
    if (!fullAccess) throw new Error("Enable Full access for this Hermes agent before running it on this PC.");
    return ["chat", "--query-file", "-", "--format", "stream-json", "--yolo", "--no-restore-cwd", "--in", cwd, "--source", "bops", ...(model ? ["--model", model] : [])];
  }
  if (kind === "claude") {
    const vm = routine?.vm;
    const servers = {
      ...(vm ? { bops_vm: { command: vm.command, args: vm.args } } : {}),
      ...(apps ? { bops_apps: { type: "http", url: apps.url, headers: { Authorization: "Bearer ${BOPS_APPS_MCP_TOKEN}" } } } : {}),
    };
    const tools = [
      ...(vm ? VM_TOOLS.map((name) => `mcp__bops_vm__${name}`) : []),
      ...(apps ? APP_TOOLS.map((name) => `mcp__bops_apps__${name}`) : []),
    ];
    return ["--print", "--output-format", "json", ...CLAUDE_SETTINGS, "--tools", "", "--strict-mcp-config",
      "--mcp-config", JSON.stringify({ mcpServers: servers }),
      ...(tools.length ? ["--allowedTools", tools.join(",")] : []), "--disable-slash-commands", "--no-session-persistence",
      "--permission-mode", "dontAsk", ...(model ? ["--model", model] : [])];
  }
  const restricted = routine ? ["--ignore-user-config", "--ignore-rules", "--ephemeral",
    "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "apps", "--disable", "plugins",
    "--disable", "skill_mcp_dependency_install", "-c", 'web_search="disabled"'] : [];
  const vm = routine?.vm;
  // Unattended routines can act only through the tools on their disposable guest.
  if (vm) restricted.push("-c", `mcp_servers.bops_vm.command=${JSON.stringify(vm.command)}`,
    "-c", `mcp_servers.bops_vm.args=${JSON.stringify(vm.args)}`, "-c", `mcp_servers.bops_vm.enabled_tools=${JSON.stringify(VM_TOOLS)}`,
    "-c", `mcp_servers.bops_vm.tools={${VM_TOOLS.map((name) => `${name}={approval_mode="approve"}`).join(",")}}`,
    "-c", "mcp_servers.bops_vm.required=true", "-c", "mcp_servers.bops_vm.startup_timeout_sec=30");
  if (apps) restricted.push("-c", `mcp_servers.bops_apps={url=${JSON.stringify(apps.url)},bearer_token_env_var="${APPS_TOKEN_ENV}",enabled_tools=${JSON.stringify(APP_TOOLS)},default_tools_approval_mode="approve",required=true,tool_timeout_sec=600}`);
  return ["exec", "--json", "--skip-git-repo-check", "--sandbox", routine ? "read-only" : "workspace-write", "-c", 'approval_policy="never"', "-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"', ...restricted, "-C", cwd, ...(model ? ["--model", model] : []), "-"];
}

export type NativeResult = { text: string; session?: string };
export function nativeEvent(kind: DesktopKind, e: Record<string, unknown>): Partial<NativeResult> & { failed?: boolean } {
  if (kind === "claude" && e.type === "result") return { text: typeof e.result === "string" ? e.result : "", failed: e.is_error !== false || e.subtype !== "success" };
  if (kind === "hermes" && e.type === "result") return { text: typeof e.text === "string" ? e.text : "", session: typeof e.session_id === "string" ? e.session_id : undefined, failed: e.exit_code !== 0 };
  if (kind === "codex" && e.type === "item.completed") {
    const item = e.item as { type?: string; text?: unknown } | undefined;
    if (item?.type === "agent_message" && typeof item.text === "string") return { text: item.text };
  }
  return { failed: e.type === "turn.failed" || e.type === "error" || (e.type === "result" && e.exit_code !== 0) };
}

export function runNative(o: { kind: DesktopKind; binary: string; cwd: string; prompt: string; fullAccess: boolean; model?: string; routine?: { vm?: VmMcp }; apps?: DesktopAppsMcp; signal?: AbortSignal; valid?: () => boolean; timeoutMs?: number }): Promise<NativeResult> {
  const args = nativeArgs(o.kind, o.cwd, o.fullAccess, o.model, o.routine, o.apps);
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted || o.valid?.() === false) return reject(new Error("This agent run was stopped."));
    const env = nativeEnvironment(o.kind, !!o.routine?.vm);
    if (o.apps) env[APPS_TOKEN_ENV] = o.apps.token;
    const child = spawn(o.binary, args, { cwd: o.cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let pending = "", text = "", session: string | undefined, total = 0, failed = false, ended = false;
    let closeJob = () => {};
    const finish = (error?: Error) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer); clearInterval(guard); o.signal?.removeEventListener("abort", abort);
      closeJob();
      if (error) { stopNative(child); reject(error); } else resolve({ text, session });
    };
    const abort = () => finish(new Error("This agent run was stopped."));
    const timer = setTimeout(() => finish(new Error("This agent reached the ten minute run limit.")), o.timeoutMs ?? 10 * 60_000);
    const guard = setInterval(() => { try { if (o.valid?.() === false) abort(); } catch { abort(); } }, 300);
    o.signal?.addEventListener("abort", abort, { once: true });
    const take = (line: string) => {
      try {
        const result = nativeEvent(o.kind, JSON.parse(line));
        if (result.text !== undefined) text = result.text;
        if (result.session) session = result.session;
        failed ||= !!result.failed;
      } catch { /* A CLI banner or diagnostic is never mistaken for the agent's final response. */ }
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      total += Buffer.byteLength(chunk);
      if (total > 8 * 1024 * 1024) return finish(new Error("This agent produced too much output and was stopped."));
      pending += chunk;
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) { take(pending.slice(0, index)); pending = pending.slice(index + 1); }
    });
    // Drain diagnostics, but never put raw process output (which may contain credentials) in Bops logs.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => finish(new Error(`${NATIVE_NAMES[o.kind]} could not start. Check its local installation.`)));
    child.on("close", (code) => {
      if (pending.trim()) take(pending);
      finish(code !== 0 || failed || !text.trim() ? new Error(`${NATIVE_NAMES[o.kind]} did not finish. Check its sign-in, model and usage limits in its own app.`) : undefined);
    });
    void bindWindowsJob(child, o.kind, abort).then((close) => {
      if (ended) return close();
      closeJob = close;
      child.stdin.end(o.prompt);
    }, (error) => finish(error));
  });
}

export const codexSubscriptionStatus = (binary?: string) => subscriptionStatus("codex", binary);

export async function subscriptionStatus(kind: "codex" | "claude", binary = nativeBinary(kind)): Promise<{ installed: boolean; signedIn: boolean; apiKey?: boolean }> {
  if (!binary) return { installed: false, signedIn: false };
  return new Promise((resolve) => {
    const args = kind === "claude" ? [...CLAUDE_SETTINGS, "auth", "status", "--json"] : ["login", "status"];
    const child = spawn(binary, args, { cwd: homedir(), env: nativeEnvironment(kind), windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    const timer = setTimeout(() => { stopNative(child); resolve({ installed: true, signedIn: false }); }, 5000);
    const take = (chunk: Buffer) => { if (text.length < 16_384) text += chunk.toString(); };
    child.stdout.on("data", take);
    if (kind === "codex") child.stderr.on("data", take); else child.stderr.resume();
    child.on("error", () => { clearTimeout(timer); resolve({ installed: false, signedIn: false }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (kind === "codex") return resolve({ installed: true, signedIn: code === 0 && /logged in using ChatGPT/i.test(text) });
      try {
        const status = JSON.parse(text);
        return resolve({ installed: true, signedIn: code === 0 && status.loggedIn === true && status.authMethod === "claude.ai" && status.apiProvider === "firstParty", apiKey: status.authMethod === "api_key" || status.authMethod === "api_key_helper" });
      } catch { resolve({ installed: true, signedIn: false }); }
    });
  });
}
