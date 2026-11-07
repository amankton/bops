import { appConnectionStatus, catalog } from "@/lib/server/composio";

/** Every app the user can connect (Composio's catalog), most used first, for the app picker. */
export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  let status;
  try {
    status = await appConnectionStatus();
    return Response.json({ ...status, apps: status.available ? await catalog() : [] }, { headers });
  } catch {
    return Response.json({ ...status, apps: [], error: "Couldn't load the Composio catalog." }, { status: 502, headers });
  }
}
