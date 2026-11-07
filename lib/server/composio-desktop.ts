import "server-only";
import { createHash } from "node:crypto";
import { getSecret, setSecret } from "./keychain";
import { getState, stateReady, stateUser } from "./store";

/** A project key saved on this PC belongs to one Bops account and one desktop installation. */
export function desktopComposioScope() {
  const token = process.env.BOPS_UI_TOKEN;
  if (process.platform !== "win32" || !token || process.env.BOPS_RUNNER === "1" || process.env.BOPS_DATABASE_URL || !stateReady()) return;
  const owner = stateUser() ?? getState().account?.user.id;
  if (!owner && process.env.BOPS_SELF_HOSTED !== "1") return;
  return "bops-pc-" + createHash("sha256").update(JSON.stringify(["composio", token, owner ?? "self"])).digest("hex").slice(0, 32);
}

type LocalKey = { scope: string; key?: string | null; loading?: Promise<void>; saving?: boolean };
const g = globalThis as typeof globalThis & { bopsDesktopComposio?: LocalKey };

export function desktopComposioKey() {
  const scope = desktopComposioScope();
  return scope && g.bopsDesktopComposio?.scope === scope ? g.bopsDesktopComposio.key ?? undefined : undefined;
}

export async function loadDesktopComposio() {
  const scope = desktopComposioScope();
  if (!scope) {
    g.bopsDesktopComposio = undefined;
    return;
  }
  if (g.bopsDesktopComposio?.scope !== scope) g.bopsDesktopComposio = { scope };
  const current = g.bopsDesktopComposio;
  if (current.key !== undefined) return;
  current.loading ??= getSecret(`composio:${scope}`).then((key) => { current.key = key; }).finally(() => { current.loading = undefined; });
  await current.loading;
}

export async function saveDesktopComposioKey(key: unknown) {
  const value = typeof key === "string" ? key.trim() : "";
  if (!/^[\x21-\x7e]{8,512}$/.test(value)) throw new Error("Enter a Composio project API key.");
  await loadDesktopComposio();
  const current = g.bopsDesktopComposio;
  if (!current || current.scope !== desktopComposioScope()) throw new Error("Open Logins in the Bops app on this PC.");
  if (current.saving) throw new Error("Bops is already checking a project key.");
  current.saving = true;
  try {
    const res = await fetch("https://backend.composio.dev/api/v3/toolkits?limit=1", {
      headers: { "x-api-key": value },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (res?.status === 401 || res?.status === 403) throw new Error("Composio rejected this project API key.");
    if (!res?.ok) throw new Error("Couldn't verify the key with Composio. Try again.");
    const data = await res.json().catch(() => null);
    if (!Array.isArray(data?.items)) throw new Error("Composio returned an unexpected response.");
    if (current.scope !== desktopComposioScope()) throw new Error("The signed-in account changed. Try again.");
    await setSecret(`composio:${current.scope}`, value);
    current.key = value;
  } finally {
    current.saving = false;
  }
}
