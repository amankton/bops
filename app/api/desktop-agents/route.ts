import { desktopAgentInfo, setHermesAccess, stopDesktopRun } from "@/lib/server/desktop-agents";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";
const allowed = (request: Request) => fromBopsWindow(request) ? notReady() : Response.json({ error: "Use the Bops desktop window." }, { status: 403 });

export async function GET(request: Request) {
  const refused = allowed(request);
  if (refused) return refused;
  const q = new URL(request.url).searchParams;
  try { return Response.json(await desktopAgentInfo(q.get("botId") ?? "", q.get("agentId") ?? "")); }
  catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
}

export async function POST(request: Request) {
  const refused = allowed(request);
  if (refused) return refused;
  const b = await request.json().catch(() => ({})) as { botId?: unknown; agentId?: unknown; op?: unknown; fullAccess?: unknown };
  if (typeof b.botId !== "string" || typeof b.agentId !== "string") return Response.json({ error: "Choose an agent." }, { status: 400 });
  try {
    await desktopAgentInfo(b.botId, b.agentId);
    if (b.op === "stop") stopDesktopRun(b.botId, b.agentId);
    else if (b.op === "access" && typeof b.fullAccess === "boolean") setHermesAccess(b.botId, b.agentId, b.fullAccess);
    else return Response.json({ error: "Choose stop or access." }, { status: 400 });
    return Response.json(await desktopAgentInfo(b.botId, b.agentId));
  } catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
}
