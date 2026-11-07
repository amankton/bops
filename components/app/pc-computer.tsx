"use client";

import { useState } from "react";
import { MacStream, useMacApp, useMacScreens } from "./mac-screens";

const button = "rounded-full border border-black/10 px-3 py-1.5 text-[13px] font-medium hover:bg-[#F2F2F0]";

export function PcComputer({ onFocus, onBack }: { onFocus?: () => void; onBack?: () => void }) {
  const inApp = useMacApp();
  const screens = useMacScreens();
  const [selected, setSelected] = useState("");
  const source = screens?.sources.find((s) => s.id === selected);
  const displays = screens?.sources.filter((s) => s.id.startsWith("screen:")) ?? [];
  const windows = screens?.sources.filter((s) => s.id.startsWith("window:") && s.name && s.name !== "Bops") ?? [];
  return (
    <section aria-label="Your PC" className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {onBack && <button className={button} onClick={onBack}>Back</button>}
        <span className="text-[14px] font-semibold">Your PC</span>
        {onFocus && <button className={button} onClick={onFocus}>Expand</button>}
      </div>
      {inApp ? (
        <>
          <label className="flex flex-wrap items-center gap-2 text-[13px]">
            <span>View a display or window</span>
            <select value={source?.id ?? ""} onChange={(e) => setSelected(e.target.value)} className="min-w-0 rounded-lg border border-black/10 p-1.5">
              <option value="">Select a screen</option>
              <optgroup label="Displays">
                {displays.map((s) => <option key={s.id} value={s.id}>{screens?.displays.find((d) => d.id === s.displayId)?.label ?? s.name}</option>)}
              </optgroup>
              <optgroup label="Windows">
                {windows.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </optgroup>
            </select>
          </label>
          {source
            ? <MacStream key={source.id} sourceId={source.id} className="min-h-0 flex-1 overflow-hidden rounded-xl" />
            : <p className="text-[13px] text-pencil">{screens ? "Select a screen to view it live in Bops." : "Looking for Windows displays…"}</p>}
        </>
      ) : <p className="text-[13px] text-pencil">Open the Bops desktop app to view your PC.</p>}
    </section>
  );
}

export function PcBotComputer({ name, local, onBrowser, onSettings }: { name: string; local: boolean; onBrowser: () => void; onSettings: () => void }) {
  return (
    <section aria-label={`${name}'s computer`} className="flex flex-col items-start gap-2 rounded-2xl border border-black/10 p-4">
      <span className="text-[14px] font-semibold">Podman Local VM</span>
      <p className="text-[13px] leading-5 text-pencil">
        {local ? `Open ${name}'s browser to browse or watch a local computer task.` : "Select This PC in Settings to run local computer tasks here."}
      </p>
      {local ? <button onClick={onBrowser} className={button}>{name}&apos;s browser</button> : <button onClick={onSettings} className={button}>This PC settings</button>}
    </section>
  );
}
