import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { cleanInput } from "@/lib/browser-relay";
import { workspaceOf } from "@/lib/types";
import { desktopRoutineDevice, localRoutinesHere } from "./desktop-agents";
import { localRoutineVm, startBrowserVm } from "./local-vm";
import { sharedProjectId } from "./shared";
import { bot, getState, sameState, stateReady, stateUser } from "./store";
import { fromBopsWindow } from "./ui-token";

type Vm = Awaited<ReturnType<typeof startBrowserVm>>;
type Idle = { vm: Promise<Vm>; viewers: number; valid: () => boolean; linger?: ReturnType<typeof setTimeout>; closing?: Promise<void> };
const LINGER_MS = 15_000;
const g = globalThis as typeof globalThis & { __bopsIdleBrowsers?: Map<string, Idle> };
const idle = (g.__bopsIdleBrowsers ??= new Map<string, Idle>());

function localBrowserAllowed(id: string) {
  return process.platform === "win32" && stateReady() && !sharedProjectId() &&
    getState().host === "mac" && localRoutinesHere() && !!bot(id);
}

function mayWatch(request: Request, id: string) {
  return !!process.env.BOPS_UI_TOKEN && fromBopsWindow(request) && localBrowserAllowed(id);
}

const profileFor = (id: string) => createHash("sha256")
  .update(JSON.stringify([desktopRoutineDevice(), stateUser(), workspaceOf(bot(id)), id])).digest("hex");

function retire(profile: string, session: Idle) {
  clearTimeout(session.linger);
  return session.closing ??= session.vm.then((vm) => vm.release()).catch(() => {}).finally(() => {
    if (idle.get(profile) === session) idle.delete(profile);
  });
}

function acquire(id: string, profile: string) {
  let entry = idle.get(profile);
  if (!entry?.valid()) {
    const previous = entry && retire(profile, entry);
    const ours = sameState();
    const next: Idle = {
      vm: Promise.resolve(previous).then(() => startBrowserVm(next.valid, profile)),
      viewers: 0,
      valid: () => !next.closing && ours() && localBrowserAllowed(id) && profileFor(id) === profile,
    };
    idle.set(profile, (entry = next));
    void next.vm.catch(() => {
      if (idle.get(profile) === next) idle.delete(profile);
    });
  }
  clearTimeout(entry.linger);
  entry.viewers++;
  const session = entry;
  return {
    vm: session.vm,
    retire: () => retire(profile, session),
    release() {
      if (--session.viewers) return;
      if (!session.valid()) return void retire(profile, session);
      session.linger = setTimeout(() => void retire(profile, session), LINGER_MS);
      session.linger.unref();
    },
  };
}

/** A one-use WebSocket sends only this VM's VNC connection through Podman's stdio. */
async function bridge(vm: Vm, origin: string, valid: () => boolean, disconnected?: () => void) {
  const path = `/${randomUUID()}`;
  const http = createServer((_req, res) => res.writeHead(404).end());
  let used = false;
  const wss = new WebSocketServer({
    server: http, path, maxPayload: 1024 * 1024,
    verifyClient: ({ origin: from }: { origin: string }) => !used && from === origin && valid(),
  });
  const stop = () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    http.close();
  };
  wss.on("connection", (ws) => {
    used = true;
    const child = vm.desktop.connect();
    child.on("error", () => { disconnected?.(); ws.terminate(); });
    child.on("close", () => {
      if (ws.readyState === ws.OPEN && valid()) disconnected?.();
      ws.close();
    });
    child.stdin.on("error", () => ws.terminate());
    ws.on("error", () => child.kill());
    ws.on("close", () => child.kill());
    ws.on("message", (data, binary) => {
      if (!binary || !Buffer.isBuffer(data) || !valid()) return ws.terminate();
      if (!child.stdin.write(data)) {
        ws.pause();
        child.stdin.once("drain", () => ws.resume());
      }
    });
    child.stdout.on("data", (data: Buffer) => {
      child.stdout.pause();
      ws.send(data, (error) => {
        if (error) ws.terminate();
        else child.stdout.resume();
      });
    });
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      wss.on("error", reject);
      http.listen(0, "127.0.0.1", () => {
        const address = http.address();
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Couldn't start the browser connection."));
      });
    });
    return { url: `ws://127.0.0.1:${port}${path}`, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

export function watchLocalBrowser(request: Request, id: string) {
  const host = request.headers.get("host") ?? "";
  if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host) || !mayWatch(request, id))
    return Response.json({ error: "Open the local browser from your Bops window on this PC." }, { status: 403 });
  const ours = sameState();
  const profile = profileFor(id);
  const valid = () => ours() && mayWatch(request, id) && profileFor(id) === profile;
  const encoder = new TextEncoder();
  let stop: (closeStream?: boolean) => void;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let session: ReturnType<typeof acquire> | undefined;
      let selected: Promise<Vm> | undefined;
      let socket: Awaited<ReturnType<typeof bridge>> | undefined;
      const send = (event: object) => {
        if (!closed) controller.enqueue(encoder.encode(`event: browser\ndata: ${JSON.stringify(event)}\n\n`));
      };
      const abort = () => stop();
      stop = (closeStream = true) => {
        if (closed) return;
        closed = true;
        clearInterval(check);
        request.signal.removeEventListener("abort", abort);
        socket?.stop();
        session?.release();
        if (closeStream) controller.close();
      };
      const tick = () => {
        if (!valid()) return stop();
        const routine = localRoutineVm(id);
        if (!routine) session ??= acquire(id, profile);
        const target = routine ?? session!.vm;
        if (target === selected) return;
        selected = target;
        socket?.stop();
        send({ status: "opening" });
        const current = () => !closed && target === selected && valid();
        void target.then(async (vm) => {
          if (!current()) return;
          const next = await bridge(vm, `http://${host}`, current, routine ? undefined : session?.retire);
          if (!current()) return next.stop();
          socket = next;
          send({ status: "ready", url: next.url, password: vm.desktop.password, viewOnly: !!routine });
        }).catch((error: Error) => {
          if (current()) send({ status: "error", error: error.message });
        });
      };
      const check = setInterval(tick, 750);
      check.unref();
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) stop();
      else tick();
    },
    cancel() { stop(false); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
}

export async function openLocalBrowserPage(request: Request) {
  const { bot: id, url } = (await request.json().catch(() => null)) ?? {};
  if (typeof id !== "string" || !mayWatch(request, id)) return Response.json({ error: "The local browser isn't available." }, { status: 403 });
  const page = cleanInput("Page.navigate", { url });
  if (!page) return Response.json({ error: "Enter an http or https address." }, { status: 400 });
  const session = idle.get(profileFor(id));
  if (!session?.viewers || !session.valid() || localRoutineVm(id)) return Response.json({ error: "Wait until the local browser is ready." }, { status: 409 });
  try {
    const vm = await session.vm;
    if (!session.viewers || !session.valid() || localRoutineVm(id) || !mayWatch(request, id)) return Response.json({ error: "The local browser changed. Try again." }, { status: 409 });
    await vm.openPage(String(page.url));
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Firefox couldn't open that address." }, { status: 502 });
  }
}
