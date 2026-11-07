import { getState, sameState, update } from "@/lib/server/store";
import type { Host } from "@/lib/types";
import { notReady } from "@/lib/server/ready";
import { desktopRoutineDevice } from "@/lib/server/desktop-agents";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { HANDOVER_MS, setRunsOn } from "@/lib/server/runner";
import { routinesBound } from "@/lib/server/routine-sync";

const gate = globalThis as typeof globalThis & { __bopsSwitchingRoutineHost?: boolean };

/** Switch new sessions and, on Windows, transfer routine scheduling to or from this PC. */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { host } = (await request.json()) as { host?: Host };
  if (host !== "mac" && host !== "orgo") return Response.json({ error: "host must be mac or orgo" }, { status: 400 });
  const state = getState();
  if (process.platform !== "win32" && !state.desktopRoutineDevice) {
    update((s) => (s.host = host));
    return Response.json({ host });
  }
  const device = desktopRoutineDevice();
  if (!device || !fromBopsWindow(request) || (state.desktopRoutineDevice && state.desktopRoutineDevice !== device)) {
    return Response.json({ error: "Change this setting from the Bops window on the PC that runs your routines." }, { status: 403 });
  }
  if (gate.__bopsSwitchingRoutineHost) return Response.json({ error: "Bops is already changing where routines run." }, { status: 409 });
  gate.__bopsSwitchingRoutineHost = true;
  const ours = sameState();
  try {
    const hasRunners = Object.keys(state.runners ?? {}).length > 0;
    if (state.account || hasRunners) {
      const result = await setRunsOn(host === "mac" ? "mac" : "cloud");
      if (result.error && !(host === "mac" && result.missing && !hasRunners)) {
        return Response.json({ error: host === "mac" ? `Couldn't turn off cloud scheduling. ${result.error}` : result.error }, { status: 502 });
      }
    }
    if (!ours()) return Response.json({ error: "The Bops account changed. Try again." }, { status: 409 });
    update((s) => {
      s.host = host;
      if (host === "mac") {
        if (s.desktopRoutineDevice !== device && hasRunners) s.desktopRoutineAfter = Date.now() + HANDOVER_MS;
        s.desktopRoutineDevice = device;
      } else {
        delete s.desktopRoutineDevice;
        delete s.desktopRoutineAfter;
      }
    });
    for (const w of getState().workspaces ?? []) routinesBound(w.id);
    return Response.json({ host });
  } finally {
    gate.__bopsSwitchingRoutineHost = false;
  }
}
