import "server-only";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, aiOf, defaultAgent, isDesktopAgent, paysLabel } from "@/lib/agents";
import { botChatId, live, personaOf, type Bot, type BotAgent, type Session } from "@/lib/types";
import { onPostgres, onRunner, onExit } from "./persist";
import { addMessage, bot, chat, getState, id, patchSession, sameState, session, setTyping, stateDevice, stateUser, update } from "./store";
import { nativeBinary, subscriptionStatus, runNative } from "./native-agents";
import { scopeOf, userBopsHome } from "./user-paths";
import type { UseWhere } from "./access-sync";

const g = globalThis as typeof globalThis & {
  __bopsDesktopAgents?: Map<string, AbortController & { agentId: string }>;
  __bopsPcTasks?: Set<string>;
};
const active = (g.__bopsDesktopAgents ??= new Map());
const pcTasks = (g.__bopsPcTasks ??= new Set<string>());
onExit("desktop-agents", async () => { for (const run of active.values()) run.abort(); });
export const desktopAgentsAvailable = () => !onRunner() && !onPostgres() && !!process.env.BOPS_UI_TOKEN && !getState().shared;
export const desktopRoutineDevice = () => desktopAgentsAvailable() && process.platform === "win32"
  ? createHash("sha256").update("bops-routines:").update(process.env.BOPS_UI_TOKEN!).digest("hex") : undefined;
export const localRoutinesOnly = () => !!getState().desktopRoutineDevice || (process.platform === "win32" && getState().host === "mac");
export const localRoutinesHere = () => !!getState().desktopRoutineDevice && getState().desktopRoutineDevice === desktopRoutineDevice();
const root = () => join(/*turbopackIgnore: true*/ process.env.BOPS_DESKTOP_USER_DATA ? join(process.env.BOPS_DESKTOP_USER_DATA, "users", scopeOf(stateUser() ?? "self")) : userBopsHome(stateUser()), "desktop-agents");
const identity = (botId: string, agentId: string) => createHash("sha256").update(`${botId}:${agentId}`).digest("hex");
const grant = (botId: string, agentId: string) => join(/*turbopackIgnore: true*/ root(), "grants", identity(botId, agentId));

export function desktopAgentFor(botId: string, picked?: string): BotAgent | undefined {
  const b = bot(botId);
  if (!b) return;
  const ai = aiOf(b, getState());
  const x = (picked ? ai.agents.find((a) => a.id === picked) : undefined) ?? defaultAgent(b, getState());
  return isDesktopAgent(x) ? x : undefined;
}

export function hermesFullAccess(botId: string, agentId: string) {
  return desktopAgentsAvailable() && existsSync(/*turbopackIgnore: true*/ grant(botId, agentId));
}

export function stopDesktopRun(botId: string, agentId?: string) {
  const run = active.get(botId);
  if (run && (!agentId || run.agentId === agentId)) run.abort();
}

export function setHermesAccess(botId: string, agentId: string, on: boolean) {
  if (!desktopAgentsAvailable()) throw new Error("Only the owner can change Hermes access in the desktop app.");
  const b = bot(botId);
  const agent = b && aiOf(b, getState()).agents.find((x) => x.id === agentId && x.kind === "hermes");
  if (!agent) throw new Error("That Hermes agent is not in this bot's roster.");
  stopDesktopRun(botId, agentId);
  const file = grant(botId, agentId);
  if (!on) return rmSync(/*turbopackIgnore: true*/ file, { force: true });
  mkdirSync(join(/*turbopackIgnore: true*/ root(), "grants"), { recursive: true });
  writeFileSync(/*turbopackIgnore: true*/ file, "full-access\n", { mode: 0o600 });
}

export async function desktopAgentInfo(botId: string, agentId: string) {
  const b = bot(botId);
  const agent = b && aiOf(b, getState()).agents.find((x) => x.id === agentId);
  if (!agent || !isDesktopAgent(agent)) throw new Error("No such desktop agent.");
  if (!desktopAgentsAvailable()) throw new Error("This agent runs only in the owner's desktop app.");
  const { kind } = agent;
  const status = kind === "hermes" ? { installed: !!nativeBinary(kind), signedIn: undefined } : await subscriptionStatus(kind);
  return { kind, ...status, fullAccess: kind === "hermes" && hermesFullAccess(botId, agentId), running: active.get(botId)?.agentId === agentId };
}

export async function executeDesktopAgent(b: Bot, agent: BotAgent, instructions: string, opts: { valid?: () => boolean; routine?: "text" | "vm"; model?: string; appsAt?: UseWhere } = {}) {
  if (!isDesktopAgent(agent) || !desktopAgentsAvailable()) throw new Error("Use this agent in your own Bops desktop window.");
  if (opts.routine && agent.kind === "hermes") throw new Error("Choose Codex or Claude Code as this bot's default. Hermes needs a scoped Local VM tool bridge.");
  if (active.has(b.id)) throw new Error("This bot already has a desktop agent running.");
  const controller = new AbortController();
  active.set(b.id, Object.assign(controller, { agentId: agent.id }));
  const ours = sameState();
  const { kind } = agent;
  const valid = () => {
    if (!ours() || !desktopAgentsAvailable() || opts.valid?.() === false) return false;
    const current = bot(b.id);
    const still = current && aiOf(current, getState()).agents.find((x) => x.id === agent.id);
    return still?.kind === kind && still.pays === agent.pays && (kind !== "hermes" || hermesFullAccess(b.id, agent.id));
  };
  let release: (() => Promise<void>) | undefined;
  let closeApps: (() => void) | undefined;
  try {
    const binary = nativeBinary(kind);
    if (!binary) throw new Error(`Install ${AGENTS[kind].name} on this PC first.`);
    if (kind !== "hermes" && !(await subscriptionStatus(kind, binary)).signedIn) {
      throw new Error(kind === "claude" ? "Sign in to your Claude subscription in Claude Code first (claude auth login --claudeai)." : "Sign in to Codex CLI with your ChatGPT account first (codex login).");
    }
    const full = kind === "hermes" && hermesFullAccess(b.id, agent.id);
    if (kind === "hermes" && !full) throw new Error("Enable Full access for this Hermes agent in its AI settings first.");
    if (!valid() || controller.signal.aborted) throw new Error("This agent run was stopped.");
    const cwd = join(/*turbopackIgnore: true*/ root(), "work", identity(b.id, agent.id));
    mkdirSync(/*turbopackIgnore: true*/ cwd, { recursive: true });
    let vm;
    if (opts.routine === "vm") {
      const { startLocalVm } = await import("./local-vm");
      vm = await startLocalVm(() => valid() && !controller.signal.aborted, b.id);
      release = vm.release;
    }
    const apps = opts.appsAt && kind !== "hermes"
      ? await (await import("./desktop-apps")).startDesktopApps(b.id, opts.appsAt, () => valid() && !controller.signal.aborted)
      : undefined;
    closeApps = apps?.close;
    const boundary = vm ? "Use the supplied Bops Local VM computer tools for desktop or browser work. Report a blocked task if the VM or a required tool is unavailable." : "";
    const appGuide = apps ? "For apps connected in Bops Logins, use the Bops Connected Apps tools. Find an action with find_app_actions, then use it with use_app. Bops enforces your account access and asks the owner for approval when required." : "";
    const prompt = `You are ${b.name}, a teammate in Bops. ${personaOf(b).text ?? ""}\nYou are running locally through ${AGENTS[kind].name} using ${paysLabel(agent, getState())}. Never claim to have used tools or taken actions you did not perform.\n${[boundary, appGuide].filter(Boolean).join("\n")}\n\n${instructions}`;
    const result = await runNative({ kind, binary, cwd, prompt, fullAccess: full, model: opts.model ?? agent.model, routine: opts.routine ? { vm } : undefined, apps, signal: controller.signal, valid });
    if (!valid() || controller.signal.aborted) throw new Error("This agent run was stopped.");
    return result.text;
  } finally {
    closeApps?.();
    try { await release?.(); } finally { if (active.get(b.id) === controller) active.delete(b.id); }
  }
}

/** New thread from the owner's Windows app. The same isolated guest serves scheduled and on-demand work. */
export function startPcTask(botId: string, agentId: string, goal: string, title?: string, model?: string): Session {
  const b = bot(botId);
  const agent = b && aiOf(b, getState()).agents.find((a) => a.id === agentId);
  if (!desktopAgentsAvailable() || !localRoutinesHere() || getState().host !== "mac") {
    throw new Error("Select This PC in Settings on the PC that will run the task.");
  }
  if (!b || !agent || !isDesktopAgent(agent) || agent.kind === "hermes") throw new Error("Choose Codex or Claude Code for a Podman task.");
  if (active.has(botId)) throw new Error("This bot already has a desktop agent running.");
  const now = Date.now();
  const task: Session = {
    id: id("ses"), botId, chatId: botChatId(botId), sentVia: "you", pcTask: true,
    host: "mac", runsOn: "mac", by: stateDevice() ?? undefined, status: "running",
    title: title?.trim() || goal.slice(0, 48), goal, createdAt: now, startedAt: now, steps: [], replies: [],
    agent: { id: agent.id, kind: agent.kind, model: model ?? agent.model },
  };
  update((state) => state.sessions.push(task));
  pcTasks.add(task.id);
  const ours = sameState();
  const valid = () => ours() && localRoutinesHere() && session(task.id)?.status === "running";
  void executeDesktopAgent(b, agent, goal, { routine: "vm", model, valid, appsAt: { sessionId: task.id, chatId: task.chatId } }).then(
    (answer) => {
      if (!valid()) return;
      patchSession(task.id, { answer, status: "done", endedAt: Date.now() });
      addMessage({ chatId: task.chatId, botId, role: "bot", text: answer, sessionIds: [task.id], resultOf: task.id });
    },
    (error: Error) => {
      if (ours() && session(task.id)?.status === "running") patchSession(task.id, { status: "failed", endedAt: Date.now(), error: error.message });
    },
  ).finally(() => pcTasks.delete(task.id));
  return task;
}

export function stopPcTask(task: Session, reason: string) {
  if (!pcTasks.has(task.id) || !live(task) || !desktopAgentsAvailable()) return;
  stopDesktopRun(task.botId);
  patchSession(task.id, { status: "failed", error: reason, endedAt: Date.now() });
}

/** Direct desktop messages never pass through the Bops model, cloud routing, or a paid fallback. */
export async function desktopChat(chatId: string, text: string, picked?: string, replyTo?: string) {
  const c = chat(chatId);
  const b = c?.kind === "bot" ? bot(c.botIds[0]) : undefined;
  const agent = b && desktopAgentFor(b.id, picked);
  if (!c || !b || !agent || !isDesktopAgent(agent) || !desktopAgentsAvailable()) throw new Error("Desktop agents can only answer their owner's direct chat on this PC.");
  const mine = addMessage({ chatId, role: "user", text, agent: agent.id, replyTo });
  if (active.has(b.id)) {
    addMessage({ chatId, role: "system", text: "This agent is still working. Wait for its reply, or stop it from its AI settings." });
    return;
  }
  const ours = sameState();
  setTyping(chatId, b.id, true);
  try {
    const history = getState().messages.filter((m) => m.chatId === chatId && ["user", "bot"].includes(m.role) && m.at <= mine.at).slice(-24).map((m) => `${m.role === "user" ? "User" : b.name}: ${m.text.slice(0, 12_000)}`).join("\n\n");
    const answer = await executeDesktopAgent(b, agent, `Answer the user's latest message, using the conversation below as context.\n\n${history}`, { appsAt: { chatId } });
    if (ours()) addMessage({ chatId, role: "bot", botId: b.id, text: answer, replyTo });
  } catch (error) {
    if (ours()) addMessage({ chatId, role: "system", text: (error as Error).message });
  } finally {
    if (ours()) setTyping(chatId, b.id, false);
  }
}
