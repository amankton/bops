import "server-only";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { onExit } from "./persist";
import { nativeEnvironment } from "./native-agents";

// The already-prepared Chief Local VM image. Reuse the image, never its running desktops or profiles.
const IMAGE = "localhost/openmausbot/cua-local-vm:driver-0.20.0-v5";
const BASE = "sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b";
const DRIVER = "/usr/local/libexec/openmausbot/cua-driver";
const SOCKET = "/run/user/1000/openmausbot-cua.sock";
const FIREFOX_PROFILE = "/home/cua/.mozilla/bops";
const command = promisify(execFile);
export type VmMcp = { command: string; args: string[] };
type LocalVm = VmMcp & {
  release: () => Promise<void>;
  desktop: { password: string; connect: () => ReturnType<typeof connectDesktop> };
  openPage: (url: string) => Promise<string>;
};

const g = globalThis as typeof globalThis & {
  __bopsLocalVmCleanup?: Set<() => Promise<void>>;
  __bopsRoutineVms?: Map<string, Promise<LocalVm>>;
  __bopsLocalVmsStopping?: boolean;
};
const cleanups = (g.__bopsLocalVmCleanup ??= new Set());
const routineVms = (g.__bopsRoutineVms ??= new Map<string, Promise<LocalVm>>());
export function stopLocalVms() {
  g.__bopsLocalVmsStopping = true;
  return Promise.allSettled([...cleanups].map((stop) => stop()));
}
onExit("local-vm", stopLocalVms);

export const localRoutineVm = (botId: string) => routineVms.get(botId);

function connectDesktop(podman: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawn(podman, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
}

export function startLocalVm(valid: () => boolean, botId?: string): Promise<LocalVm> {
  const vm = bootLocalVm(valid);
  if (!botId) return vm;
  routineVms.set(botId, vm);
  const forget = () => { if (routineVms.get(botId) === vm) routineVms.delete(botId); };
  void vm.then((ready) => {
    const stop = ready.release;
    ready.release = () => { forget(); return stop(); };
  }, forget);
  return vm;
}

export const startBrowserVm = (valid: () => boolean, profile: string) => bootLocalVm(valid, profile);

async function bootLocalVm(valid: () => boolean, profile?: string): Promise<LocalVm> {
  if (process.platform !== "win32") throw new Error("Local VM routines currently require Bops on Windows.");
  if (profile !== undefined && !/^[a-f\d]{64}$/.test(profile)) throw new Error("Invalid browser profile.");
  const browser = profile !== undefined;
  const podman = [
    process.env.BOPS_PODMAN_BIN,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Podman", "podman.exe"),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((p) => join(p, "podman.exe")),
  ].find((p): p is string => !!p && isAbsolute(p) && p.toLowerCase().endsWith(".exe") && existsSync(p));
  if (!podman) throw new Error("Install Podman and start its local rootless machine.");
  const machine = process.env.BOPS_PODMAN_MACHINE || "podman-machine-default";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(machine)) throw new Error("Invalid Podman machine name.");
  const env = nativeEnvironment("codex", true);
  const password = randomBytes(6).toString("base64url");
  const viewOnly = randomBytes(6).toString("base64url");
  const pod = async (args: string[], timeout = 8000) => (await command(podman, args, { env, timeout, windowsHide: true, maxBuffer: 1024 * 1024 })).stdout.trim();
  const assertLive = () => { if (g.__bopsLocalVmsStopping || !valid()) throw new Error("The local VM was stopped."); };
  try {
    const [vm] = JSON.parse(await pod(["machine", "inspect", machine]));
    const connections = JSON.parse(await pod(["system", "connection", "list", "--format", "json"]));
    const link = connections.find((row: { Name: string }) => row.Name === machine);
    const uri = new URL(link?.URI);
    if (vm?.Name !== machine || vm?.State !== "running" || vm?.Rootful !== false || link.IsMachine !== true ||
        uri.protocol !== "ssh:" || !["127.0.0.1", "[::1]"].includes(uri.hostname) || Number(uri.port) !== vm.SSHConfig?.Port ||
        uri.username !== vm.SSHConfig?.RemoteUsername || !/^\/run\/user\/\d+\/podman\/podman\.sock$/.test(uri.pathname)) throw new Error("Invalid local connection");
  } catch { throw new Error(`Start the local rootless Podman machine ${machine}.`); }
  assertLive();
  const connection = ["--connection", machine];
  let imageId: string;
  try {
    const [image] = JSON.parse(await pod([...connection, "image", "inspect", IMAGE]));
    const labels = image?.Labels ?? image?.Config?.Labels;
    if (!/^(?:sha256:)?[a-f\d]{64}$/.test(image?.Id ?? "") || image.Os !== "linux" || image.Architecture !== "amd64" ||
        labels?.["com.openmausbot.cua-base"] !== BASE || labels?.["com.openmausbot.cua-driver"] !== "0.20.0" || labels?.["com.openmausbot.image-layer"] !== "5") throw new Error("Image mismatch");
    imageId = image.Id;
  } catch { throw new Error("Prepare Chief's CUA Local VM image in this Podman machine first."); }
  assertLive();
  const name = `bops-${browser ? "browser" : "routine"}-${randomUUID()}`;
  env.VNC_PW = browser ? password : `${password}\n${viewOnly}`;
  if (browser) env.VNC_RESOLUTION = "960x720";
  const exec = [...connection, "exec", "-u", "cua", "-e", "HOME=/home/cua", "-e", "DISPLAY=:1", "-e", "CUA_DRIVER_INSTALL_CHANNEL=python_package", "-e", "CUA_DRIVER_RS_TELEMETRY_ENABLED=0"];
  const starting = pod([...connection, "run", "-d", "--rm", "--name", name, "--label", "com.bops.local-vm=1", "--pull=never", browser ? "--timeout=3600" : "--timeout=720",
    "--userns", "keep-id:uid=1000,gid=1000", "--user", "0:0", "--memory", "4g", "--memory-swap", "4g", "--cpus", "2", "--pids-limit", "512",
    "--ipc=private", "--cgroupns=private", "--cap-drop=ALL", "--cap-add=SETUID", "--cap-add=SETGID", "--cap-add=SYS_CHROOT", "--shm-size=512m",
    "--network=pasta:--no-map-gw,-t,none,-u,none,-T,none,-U,none", "-e", "VNC_PW",
    ...(browser ? ["-e", "VNC_RESOLUTION", "--volume", `bops-firefox-${profile}:/home/cua/.mozilla`] : []), imageId], 30_000);
  let stopping: Promise<void> | undefined;
  const release = () => stopping ??= starting.then(async () => {
    // Give Firefox time to write its session and release the profile before the guest is removed.
    if (browser) await pod([...exec, name, "/usr/bin/timeout", "3", "/bin/sh", "-c",
      'pid=$(pgrep -o -x firefox-esr) || exit 0; kill -TERM "$pid" && while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done'], 4500).catch(() => {});
  }, () => {}).then(() => pod([...connection, "rm", "--ignore", "--force", "--time", "0", name], 10_000))
    .then(() => { cleanups.delete(release); }, () => { cleanups.delete(release); throw new Error("Podman couldn't clean up the Bops VM. Its time limit will stop it."); });
  cleanups.add(release);
  let desktopReady = false;
  try {
    await starting;
    delete env.VNC_PW;
    const firefox = [...exec, "-d", "-e", "XDG_RUNTIME_DIR=/run/user/1000",
      "-e", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus", name, "/usr/bin/firefox", "--profile", FIREFOX_PROFILE];
    const openPage = (url: string) => pod([...firefox, "--new-tab", url]);
    const waitFor = async (probe: () => Promise<boolean>) => {
      const deadline = Date.now() + 35_000;
      while (Date.now() < deadline) {
        assertLive();
        if (await probe().catch(() => false)) return;
        await delay(750);
      }
      throw new Error("The local VM did not become ready.");
    };
    await waitFor(() => pod([...exec, name, DRIVER, "status", "--socket", SOCKET], 4000).then(() => true));
    assertLive();
    desktopReady = true;
    if (browser) {
      await pod([...exec, name, "/bin/sh", "-c",
        `umask 077; mkdir -p "$1" && { test -e "$1/user.js" || printf '%s\\n' 'user_pref("browser.startup.page", 3);' 'user_pref("browser.aboutwelcome.enabled", false);' 'user_pref("browser.shell.checkDefaultBrowser", false);' > "$1/user.js"; }`,
        "bops-firefox", FIREFOX_PROFILE]);
      assertLive();
      await pod(firefox);
      await waitFor(async () => {
        const output = await pod([...exec, name, DRIVER, "call", "list_windows", "--socket", SOCKET], 4000);
        const { windows } = JSON.parse(output) as { windows: { app_name: string; is_on_screen: boolean }[] };
        return windows.some((w) => w.app_name === "firefox-esr" && w.is_on_screen);
      });
    }
    assertLive();
    return {
      command: podman, args: [...exec, "-i", name, DRIVER, "mcp", "--socket", SOCKET], release, openPage,
      desktop: {
        password: browser ? password : viewOnly,
        connect: () => connectDesktop(podman, [...exec, "-i", name, "/usr/bin/nc", "127.0.0.1", "5901"], env),
      },
    };
  } catch (error) {
    await release();
    assertLive();
    if (desktopReady && browser) throw new Error("Firefox didn't open in the Podman desktop. Try again.", { cause: error });
    throw new Error("Podman couldn't start the CUA desktop. Check the local machine and image.", { cause: error });
  }
}
