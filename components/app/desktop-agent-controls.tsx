"use client";

import { useEffect, useState } from "react";
import type { BotAgent } from "@/lib/types";

export type DesktopAgentInfo = { installed: boolean; signedIn?: boolean; apiKey?: boolean; fullAccess: boolean; running: boolean };

export async function readDesktopAgentInfo(botId: string, agentId: string, signal?: AbortSignal): Promise<DesktopAgentInfo> {
  const res = await fetch(`/api/desktop-agents?botId=${encodeURIComponent(botId)}&agentId=${encodeURIComponent(agentId)}`, { cache: "no-store", signal });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Couldn't check this agent.");
  return data;
}

export function DesktopAgentControls({ botId, agent, readOnly }: { botId: string; agent: BotAgent; readOnly: boolean }) {
  const [info, setInfo] = useState<DesktopAgentInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const hermes = agent.kind === "hermes";
  const claude = agent.kind === "claude";
  const name = hermes ? "Hermes" : claude ? "Claude Code" : "Codex CLI";
  const login = claude ? "claude auth login --claudeai" : "codex login";
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const data = await readDesktopAgentInfo(botId, agent.id);
        if (cancelled) return;
        setInfo(data); setError("");
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't check this agent."); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [botId, agent.id]);
  const change = async (op: "stop" | "access", fullAccess?: boolean) => {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/desktop-agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op, botId, agentId: agent.id, fullAccess }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "That didn't change.");
      setInfo(data);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-2 rounded-[12px] bg-white p-3 text-[12px] leading-5 shadow-[0_0_0_1px_#E6E6E3]">
      <span className="font-medium">{hermes ? "Hermes on this PC" : `${claude ? "Claude" : "Codex"} subscription on this PC`}</span>
      <span>{!info ? "Checking local installation…" : !info.installed ? `Install ${name} on this PC first.` : hermes ? "Uses your installed Hermes model, login and profile settings." : info.signedIn ? `Connected through your existing ${claude ? "Claude" : "ChatGPT"} login.` : <>{info.apiKey ? "Claude Code is using an API key. " : ""}Sign in to your subscription with <code>{login}</code>, then return here.</>}</span>
      {claude && <span className="text-pencil">Claude replies to text using the Claude Code login. Tools are disabled for this agent.</span>}
      <span className="text-pencil">Choose this agent in the chat composer or make it the default. It runs on this PC while Bops is open. Cloud tools and scheduled threads use separate agents.</span>
      {hermes && (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">Full access for Hermes</span>
            <button type="button" role="switch" aria-label="Full access for Hermes" aria-checked={!!info?.fullAccess} disabled={readOnly || busy || !info?.installed} onClick={() => void change("access", !info?.fullAccess)} className={`rounded-full px-3 py-1.5 font-medium disabled:opacity-50 ${info?.fullAccess ? "bg-ink text-white" : "bg-[#F2F2F0]"}`}>
              {info?.fullAccess ? "On" : "Off"}
            </button>
          </div>
          <span className="text-pencil">With Full access, Hermes can run commands and use files, apps and its configured tools with your Windows account&apos;s permissions. It runs without command approval prompts. Turning it off stops its current run. This grant applies only to this agent on this PC.</span>
          {!info?.fullAccess && <span>Hermes stays paused until you assign Full access.</span>}
        </>
      )}
      {info?.running && <button type="button" disabled={readOnly || busy} onClick={() => void change("stop")} className="self-start rounded-full bg-[#FEF3F2] px-3 py-1.5 font-medium text-[#B42318]">Stop agent</button>}
      {error && <span role="alert" className="text-[#B42318]">{error}</span>}
    </div>
  );
}
