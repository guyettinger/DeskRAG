import React, { useEffect, useState } from "react";
import type { EnvInfo, RecordingStatus } from "@shared/types";
import { api } from "./api.js";
import { IconRecord, IconSearch, IconSettings } from "./icons.js";
import { RecordScreen } from "./screens/RecordScreen.js";
import { SearchScreen } from "./screens/SearchScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";

type Route = "record" | "search" | "settings";

const NAV: { id: Route; label: string; Icon: typeof IconRecord }[] = [
  { id: "record", label: "Record", Icon: IconRecord },
  { id: "search", label: "Search", Icon: IconSearch },
  { id: "settings", label: "Settings", Icon: IconSettings },
];

export function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>("record");
  const [status, setStatus] = useState<RecordingStatus>({ state: "idle", activeSignals: [] });
  const [env, setEnv] = useState<EnvInfo | null>(null);

  useEffect(() => {
    api.recording.status().then(setStatus);
    api.system.env().then(setEnv);
    const off = api.recording.onState(setStatus);
    return off;
  }, []);

  const live = status.state === "recording";
  const busy = status.state === "indexing";

  return (
    <div className="shell">
      <nav className="rail">
        <div className="rail__brand">DESK·RAG</div>
        <div className="rail__nav">
          {NAV.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={`rail__item${route === id ? " is-active" : ""}`}
              onClick={() => setRoute(id)}
              aria-current={route === id}
            >
              <Icon />
              {label}
            </button>
          ))}
        </div>
        <div className="rail__spacer" />
        <div className={`rail__reclamp${live ? " is-live" : ""}`} title={status.state} />
      </nav>

      <div className="main">
        <header className="topbar">
          <span className="topbar__title">
            {route === "record" ? "Recorder" : route === "search" ? "Experience Search" : "Settings"}
          </span>
          <div className="topbar__status">
            {live && (
              <span className="chip live">
                <span className="dot" /> Recording
              </span>
            )}
            {busy && (
              <span className="chip busy">
                <span className="dot" /> Indexing
              </span>
            )}
            {!live && !busy && (
              <span className="chip">
                <span className="dot" /> Idle
              </span>
            )}
          </div>
        </header>

        <main className="content">
          {route === "record" && <RecordScreen status={status} env={env} />}
          {route === "search" && <SearchScreen />}
          {route === "settings" && <SettingsScreen onEnv={setEnv} />}
        </main>
      </div>
    </div>
  );
}
