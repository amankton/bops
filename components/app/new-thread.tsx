"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent as KeyEvent, type RefObject } from "react";
import { AGENTS, agentLabel, agentName, agentState, aiOf, isDesktopAgent, modelsFor, modelShort, OPENCODE_OTHER, paysLabel, readyAgents, upper, type AgentState } from "@/lib/agents";
import { workBot, workspaceOf, type AppState, type Bot, type BotAgent, type Session } from "@/lib/types";
import { WINDOWS } from "@/lib/platform";
import { AgentMark } from "./agent-marks";
import { readDesktopAgentInfo, type DesktopAgentInfo } from "./desktop-agent-controls";
import { useVaultKeyNames } from "./keys";
import { undash } from "./side-group";
import { post } from "./ui";

/**
 * Picking the agent a new thread runs on: the New thread sheet (from the profile's New thread, and the bot menu),
 * and the agent chip in the message box. Every thread keeps the agent it starts on; the bot's Default is marked,
 * whatever its state, and an agent that isn't ready says why.
 */

/** A menu or popover that closes on Escape or a press outside `ref`, before anything behind it hears the key. */
export function useDismiss(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>) {
  const last = useRef(close);
  useEffect(() => {
    last.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      last.current();
    };
    const down = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) last.current();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", down, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", down, true);
    };
  }, [open, ref]);
}

/** The Vault's key names for a bot's agents on a key (undefined until read, or when it has none on one). */
export function useBotKeys(state: AppState, b: Bot | undefined) {
  return useVaultKeyNames(b ? workspaceOf(b) : "", !!b && !state.shared && aiOf(b, state).agents.some((x) => x.pays === "key"));
}

/** An agent that isn't ready, in a word or two, for a chip: "not signed in", "no key". */
export function notReadyWords(st: AgentState) {
  return st.button === "sign_in" ? "not signed in" : st.button === "add_key" ? "no key" : st.button === "show" ? "signing in" : st.button === "retry" ? "sign in didn't finish" : "not ready";
}

/** The Default's own mark on a tile, whatever its state. */
export const DefaultPill = () => <span className="shrink-0 rounded-full bg-[#F2F2F0] px-1.5 text-[10.5px] font-medium leading-[14px] text-[#3A3A38]">Default</span>;

/** The bot's agents as tiles to pick one from. `onSetUp`: an agent that isn't ready, to its editor in the profile. */
export function AgentPick({ state, bot: b, value, keys, onPick, onSetUp, disabledReason }: { state: AppState; bot: Bot; value: string; keys?: ReadonlySet<string>; onPick: (x: BotAgent) => void; onSetUp?: (agentId: string) => void; disabledReason?: (agent: BotAgent) => string | undefined }) {
  const ai = aiOf(b, state);
  const at = { bot: b, state };
  return (
    <div role="group" aria-label="Agent" className="flex flex-wrap gap-2">
      {ai.agents.map((x) => {
        const reason = disabledReason?.(x);
        const st = reason ? { ready: false, line: reason } : agentState(x, b, state, keys);
        const on = x.id === value;
        return (
          <div key={x.id} className={`flex min-w-[140px] max-w-full flex-col rounded-[14px] bg-white ${on ? "shadow-[0_0_0_1.5px_#0A0A0A]" : "shadow-[0_0_0_1px_#E6E6E3] hover:shadow-[0_0_0_1px_#C9C9C6]"}`}>
            <button
              type="button"
              aria-pressed={on}
              aria-disabled={!st.ready || undefined}
              onClick={() => st.ready && onPick(x)}
              title={st.ready ? `${agentLabel(x, at)} · ${paysLabel(x, state, workBot(b, state.bots).computerId)}` : st.line}
              className={`flex items-center gap-2.5 px-3 py-2 text-left ${st.ready ? "" : "cursor-default opacity-60"}`}
            >
              <AgentMark kind={x.kind} size={18} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5 text-[13px] font-medium leading-4">
                  <span className="truncate">{agentName(x, at)}</span>
                  {x.id === ai.default && <DefaultPill />}
                </span>
                <span className="truncate text-[11.5px] leading-[15px] text-[#6B6B6B]">{st.ready ? modelShort(x.kind, x.model) || "Auto" : st.line}</span>
              </span>
            </button>
            {!st.ready && onSetUp && (
              <button type="button" onClick={() => onSetUp(x.id)} className="self-start px-3 pb-2 text-[12px] font-medium leading-4 text-ink underline decoration-[#C9C9C6] underline-offset-2 hover:decoration-ink">
                Set up
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * New thread for a bot: the agent, its model, how it pays, and what to do. Starts it and opens it. `agentId`: the
 * agent it starts on (else the Default, else the first one ready). Always drawn where it is (the profile's AI, or over
 * the chat's message box from the bot's menu), never over the window; `inline`: a picture of it, which takes no focus.
 * `onSetUp`: an agent that isn't ready, to its editor in the profile (this closes). Esc in it closes it, and only it.
 */
export function NewThread({
  state,
  bot: b,
  agentId,
  inline = false,
  onClose,
  onStarted,
  onSetUp,
}: {
  state: AppState;
  bot: Bot;
  agentId?: string;
  inline?: boolean;
  onClose: () => void;
  onStarted: (s: Session) => void;
  onSetUp?: (agentId: string) => void;
}) {
  const ai = aiOf(b, state);
  const keys = useBotKeys(state, b);
  const pc = WINDOWS && !state.shared && state.host === "mac";
  const blocked = (agent: BotAgent) => {
    if (pc) {
      if (!state.desktopRoutinesHere) return "Select This PC in Settings";
      if (!isDesktopAgent(agent) || agent.kind === "hermes") return "Choose a Codex or Claude Code subscription for Podman";
    } else if (isDesktopAgent(agent)) return "Select This PC in Settings for computer tasks";
  };
  const ready = pc ? ai.agents.filter((agent) => !blocked(agent)) : readyAgents(b, state, keys);
  const first = ready.find((x) => x.id === agentId) ?? ready.find((x) => x.id === ai.default) ?? ready[0] ?? ai.agents[0];
  const [agent, setAgent] = useState<BotAgent>(first);
  const [model, setModel] = useState<string>(first.model ?? modelsFor(first.kind)[0]?.id ?? "");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const models = modelsFor(agent.kind);
  // Its own Escape, from inside it: it closes, and nothing behind it (the profile's tab, the chat) hears it.
  const onKey = (e: KeyEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };
  const start = async () => {
    if (!goal.trim()) return;
    setBusy(true);
    try {
      const res = await post("/api/sessions", { botId: b.id, goal: goal.trim(), agentId: agent.id, ...(pc ? { pc: true } : {}), ...(model && model !== "auto" ? { model } : {}) });
      const j = (await res.json().catch(() => ({}))) as Session & { error?: string };
      if (res.ok && j.id) onStarted(j);
      else setError(undash(j.error ?? "It didn't start. Try again."));
    } catch {
      setError("Couldn't reach Bops. Try again.");
    }
    setBusy(false);
  };
  return (
    <div className="flex w-full justify-center">
      <div
        ref={panel}
        role="region"
        aria-labelledby={titleId}
        data-new-thread
        onKeyDown={onKey}
        className="motion-rise-in flex w-full max-w-[560px] flex-col gap-3.5 rounded-[24px] bg-white p-5 shadow-[0_0_0_1px_#0000000F,0_24px_60px_-20px_#00000038]"
      >
        <div className="flex items-center">
          <span id={titleId} className="flex-1 text-[17px] font-semibold leading-6">
            New thread for {b.name}
          </span>
          <button type="button" onClick={onClose} aria-label="Close" className="flex size-7 items-center justify-center rounded-full text-[#6B6B6B] hover:bg-[#F2F2F0]">
            ×
          </button>
        </div>
        <AgentPick
          state={state}
          bot={b}
          value={agent.id}
          keys={keys}
          disabledReason={blocked}
          onSetUp={onSetUp ? (id) => (onClose(), onSetUp(id)) : undefined}
          onPick={(x) => {
            setAgent(x);
            setModel(x.model ?? modelsFor(x.kind)[0]?.id ?? "");
          }}
        />
        <label className="flex items-center gap-3 rounded-[12px] bg-white px-3 py-2 shadow-[0_0_0_1px_#E6E6E3]">
          <span className="flex-1 text-[13px] leading-4">Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} className="appearance-none bg-transparent text-right text-[13px] font-semibold leading-4 outline-none">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            {agent.kind === "opencode" && model && !models.some((m) => m.id === model) && OPENCODE_OTHER.test(model) && <option value={model}>{model}</option>}
          </select>
          <span aria-hidden className="text-[10px] text-[#9A9A98]">
            ▾
          </span>
        </label>
        <span className="text-[12px] leading-4 text-[#6B6B6B]">{pc && "Podman Local VM on this PC · "}Pays with: {paysLabel(agent, state, workBot(b, state.bots).computerId)}</span>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="What should it do?"
          aria-label="What should it do?"
          autoFocus={!inline}
          rows={3}
          className="resize-none rounded-[14px] bg-[#FAFAF9] px-3.5 py-2.5 text-[14px] leading-5 shadow-[0_0_0_1px_#E6E6E3] outline-none placeholder:text-[#9A9A98]"
        />
        <div className="flex items-center gap-2">
          {error && (
            <span role="alert" className="min-w-0 flex-1 text-[12px] leading-4 text-[#B42318]">
              {error}
            </span>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-full bg-[#F2F2F0] px-3.5 py-2 text-[13px] font-medium leading-4 hover:bg-[#EAEAE7]">
            Cancel
          </button>
          <button type="button" disabled={busy || !goal.trim() || !ready.some((x) => x.id === agent.id)} onClick={() => void start()} className="rounded-full bg-ink px-3.5 py-2 text-[13px] font-medium leading-4 text-white hover:bg-[#2A2A28] disabled:opacity-40">
            Start
          </button>
        </div>
      </div>
    </div>
  );
}

type DesktopStatuses = Partial<Record<string, DesktopAgentInfo | null>>;

export function useDesktopComposerStatuses(state: AppState, b: Bot | undefined) {
  const botId = state.desktopAgents && !state.shared ? b?.id : undefined;
  const ids = botId && b ? aiOf(b, state).agents.filter(isDesktopAgent).map((x) => x.id).sort().join(",") : "";
  const scope = `${botId}:${ids}`;
  const [snapshot, setSnapshot] = useState<{ scope: string; statuses: DesktopStatuses }>();
  useEffect(() => {
    if (!botId || !ids) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const entries = await Promise.all(ids.split(",").map(async (id) => {
        const status = await readDesktopAgentInfo(botId, id, controller.signal).catch(() => null);
        return [id, status] as const;
      }));
      if (controller.signal.aborted) return;
      setSnapshot({ scope, statuses: Object.fromEntries(entries) });
      timer = setTimeout(() => void refresh(), 10_000);
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [botId, ids, scope]);
  return snapshot?.scope === scope ? snapshot.statuses : undefined;
}

function desktopUnavailable(x: BotAgent, info: DesktopAgentInfo | null | undefined) {
  const name = AGENTS[x.kind].name;
  if (info === undefined) return { label: "checking…", detail: `Checking ${name} on this PC.` };
  if (info === null) return { label: "check failed", detail: `Couldn't check ${name} on this PC. Bops will retry.` };
  if (!info.installed) return { label: "not installed", detail: `Install ${x.kind === "codex" ? "Codex CLI" : name} on this PC first.` };
  if (x.kind === "hermes") return info.fullAccess ? undefined : { label: "access off", detail: "Enable Full access for this Hermes agent in AI settings." };
  if (!info.signedIn) {
    const login = x.kind === "claude" ? "claude auth login --claudeai" : "codex login";
    return { label: "not signed in", detail: `Sign in to your subscription on this PC with ${login}.` };
  }
}

/** Direct chat can also use desktop agents. Task and thread pickers still use readyAgents. */
export function boxAgents(state: AppState, b: Bot, value: string | null, keys?: ReadonlySet<string>, desktop?: DesktopStatuses) {
  const ai = aiOf(b, state);
  const taskAgents = readyAgents(b, state, keys);
  const local = state.desktopAgents && !state.shared ? ai.agents.filter(isDesktopAgent) : [];
  const def = ai.agents.find((x) => x.id === ai.default) ?? ai.agents[0];
  const options = [...taskAgents, ...local];
  if (!options.some((x) => x.id === def.id)) options.unshift(def);
  const unavailable = (x: BotAgent) => {
    if (local.some((y) => y.id === x.id)) return desktopUnavailable(x, desktop?.[x.id]);
    if (isDesktopAgent(x)) return { label: "not ready", detail: "Use this agent in your own desktop window." };
    if (!taskAgents.some((y) => y.id === x.id)) {
      const status = agentState(x, b, state, keys);
      return { label: notReadyWords(status), detail: status.line };
    }
  };
  // Keep an explicit desktop pick when its readiness changes, so sending cannot switch providers.
  const picked = options.find((x) => x.id === value && (isDesktopAgent(x) ? local.includes(x) : !unavailable(x)));
  return { def, options, picked, now: picked ?? def, unavailable };
}

/**
 * The message box's agent chip (Warp's split chip): only for the owner, and only when there's a choice of agent.
 * The pick goes with each message as Message.agent. Desktop choices show their status in the menu.
 */
export function AgentChipPick({ state, bot: b, value, keys, desktop, defaultOpen = false, onPick }: { state: AppState; bot: Bot; value: string | null; keys?: ReadonlySet<string>; desktop?: DesktopStatuses; defaultOpen?: boolean; onPick: (agentId: string | null) => void }) {
  const [open, setOpen] = useState(defaultOpen);
  const box = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useDismiss(open, () => setOpen(false), box);
  const { options, now, def, unavailable } = boxAgents(state, b, value, keys, desktop);
  if (options.length < 2 || state.shared) return null;
  const at = { bot: b, state };
  const status = unavailable(now);
  const label = status ? `${AGENTS[now.kind].name} · ${status.label}` : agentName(now, at);
  const title = isDesktopAgent(now) ? `Replies on this PC using ${paysLabel(now, state)}` : value && now.id === value ? `Tasks from this message run on ${agentLabel(now, at)}` : `Tasks run on ${b.name}'s Default, ${agentLabel(now, at)}`;
  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Agent for new tasks: ${agentName(now, at)}${status ? `, ${status.label}` : ""}`}
        title={status?.detail ?? title}
        className="flex h-[30px] items-center gap-1.5 rounded-full px-2 text-[12.5px] leading-4 text-[#3A3A38] hover:bg-[#F2F2F0]"
      >
        <AgentMark kind={now.kind} size={15} />
        <span className={`max-w-[170px] truncate ${status ? "text-[#B54708]" : ""}`}>{label}</span>
        <span aria-hidden className="text-[9px] text-[#9A9A98]">
          ▾
        </span>
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label="Agent for new tasks" className="absolute bottom-[calc(100%+6px)] right-0 z-20 flex min-w-[280px] flex-col rounded-[14px] bg-white p-1 shadow-[0_0_0_1px_#0000000F,0_12px_32px_-12px_#00000040]">
          {options.map((x) => {
            const off = unavailable(x);
            return (
              <button
                key={x.id}
                type="button"
                role="menuitemradio"
                aria-checked={x.id === now.id}
                aria-disabled={!!off || undefined}
                title={off?.detail}
                onClick={() => {
                  if (off) return;
                  onPick(x.id === def.id ? null : x.id);
                  setOpen(false);
                }}
                className={`flex items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-[13px] leading-4 hover:bg-[#F6F6F4] ${x.id === now.id ? "bg-[#F6F6F4]" : ""} ${off ? "cursor-default opacity-60" : ""}`}
              >
                <AgentMark kind={x.kind} size={15} />
                <span className="flex-1">
                  {agentLabel(x, at)}
                  {off ? ` · ${off.label}` : ""}
                </span>
                {x.id === def.id && <span className="text-[11px] text-[#6B6B6B]">Default</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The line above the box while a pick other than the Default holds. */
export const pickLine = (x: BotAgent, b?: Bot, state?: Pick<AppState, "bots" | "brains">) => `${isDesktopAgent(x) ? "Replies on this PC using" : "Tasks from this message run on"} ${upper(agentLabel(x, b && state ? { bot: b, state } : undefined))}`;
