"use client";

import { useContext, useEffect, useRef, useState } from "react";
import type { Bot } from "@/lib/types";
import { VncDesktop } from "./live-desktop";
import { BrowserGoTo } from "./panel-tabs";

type Connection =
  | { status: "opening" }
  | { status: "ready"; url: string; password: string; viewOnly: boolean }
  | { status: "error"; error: string };

export function LocalBrowser({ bot }: { bot: Bot }) {
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<Connection>({ status: "opening" });
  const [liveUrl, setLiveUrl] = useState<string>();
  const [endedUrl, setEndedUrl] = useState<string>();
  const [note, setNote] = useState("");
  const goTo = useContext(BrowserGoTo);
  const opened = useRef<number>(0);

  useEffect(() => {
    const stream = new EventSource(`/api/browser/local?${new URLSearchParams({ bot: bot.id })}`);
    stream.addEventListener("browser", (event: MessageEvent<string>) => {
      const next: Connection = JSON.parse(event.data);
      setConnection(next);
      if (next.status === "error") stream.close();
    });
    stream.onerror = () => {
      stream.close();
      setConnection({ status: "error", error: "Lost the connection to the local browser." });
    };
    return () => stream.close();
  }, [bot.id, attempt]);

  const ready = connection.status === "ready" ? connection : null;
  const live = !!ready && liveUrl === ready.url;
  useEffect(() => {
    const ask = goTo?.go;
    if (!ask || ask.botId !== bot.id || opened.current === ask.at || !live || ready?.viewOnly) return;
    opened.current = ask.at;
    goTo.took(ask.at);
    void fetch("/api/browser/local", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bot: bot.id, url: ask.url }),
    }).then(async (res) => {
      setNote(res.ok ? "" : ((await res.json()) as { error: string }).error);
    }).catch(() => setNote("Couldn't open that address. Try again."));
  }, [bot.id, goTo, live, ready]);

  const error = connection.status === "error" ? connection.error : ready && ready.url === endedUrl ? "The Podman desktop disconnected." : "";
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label={`${bot.name}'s browser`} data-local-browser>
      <div className="flex min-h-10 shrink-0 items-center border-b border-[#F0F0EE] px-4 text-[13px] font-medium">
        {ready?.viewOnly ? "Local task · View only" : "Firefox · This PC"}
      </div>
      <div className="relative min-h-0 flex-1 bg-[#F6F6F5]">
        {ready && !error && (
          <VncDesktop key={ready.url} url={ready.url} password={ready.password} interactive={!ready.viewOnly}
            connected={live} onLive={() => setLiveUrl(ready.url)} onEnd={() => setEndedUrl(ready.url)} />
        )}
        {(error || !live) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-[13px]" role="status">
            <p>{error || `Opening ${bot.name}'s browser on this PC…`}</p>
            {error && (
              <button className="rounded-full bg-black px-4 py-1.5 font-semibold text-white" onClick={() => {
                setConnection({ status: "opening" });
                setNote("");
                setAttempt((n) => n + 1);
              }}>Try again</button>
            )}
          </div>
        )}
      </div>
      {note && <p className="px-4 py-2 text-[13px]" role="status">{note}</p>}
    </div>
  );
}
