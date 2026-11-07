import { appConnectionStatus } from "@/lib/server/composio";
import { desktopComposioScope, saveDesktopComposioKey } from "@/lib/server/composio-desktop";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

/** The key is validated by Composio and kept in Windows secure storage. Only status is returned. */
export async function POST(request: Request) {
  if (!fromBopsWindow(request) || !process.env.BOPS_UI_TOKEN) return Response.json({ error: "Open Logins in the Bops app on this PC." }, { status: 403 });
  const unready = notReady();
  if (unready) return unready;
  if (!desktopComposioScope()) return Response.json({ error: "Composio setup is available in the Bops app on Windows." }, { status: 403 });
  try {
    const status = await appConnectionStatus();
    if (!status.canSetUp) return Response.json({ error: "Bops Cloud already provides Connected Apps." }, { status: 409 });
    const body = await request.json().catch(() => null);
    await saveDesktopComposioKey(body?.key);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
