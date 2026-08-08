import React, { useEffect, useRef, useState } from "react";
import type { EnvInfo, RecordingStatus } from "@shared/types";
import { api } from "./api.js";
import { GhostMark } from "./brand/GhostMark.js";
import { IconFlows, IconLibrary, IconRecord, IconSearch, IconSettings } from "./icons.js";
import { LibraryScreen } from "./screens/LibraryScreen.js";
import { RecordScreen } from "./screens/RecordScreen.js";
import { FlowsScreen } from "./screens/FlowsScreen.js";
import { SearchScreen } from "./screens/SearchScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";

type Route = "record" | "library" | "flows" | "search" | "settings";

const NAV: { id: Route; label: string; Icon: typeof IconRecord }[] = [
  { id: "record", label: "Record", Icon: IconRecord },
  { id: "library", label: "Library", Icon: IconLibrary },
  { id: "flows", label: "Flows", Icon: IconFlows },
  { id: "search", label: "Search", Icon: IconSearch },
  { id: "settings", label: "Settings", Icon: IconSettings },
];

const TITLES: Record<Route, string> = {
  record: "Recorder",
  library: "Library",
  flows: "Flows",
  search: "Experience Search",
  settings: "Settings",
};

/**
 * Where a cross-screen jump is going. Flows and Search both end at a recorded
 * moment — one from a state on the canvas, one from a retrieved frame — and the
 * Library is where recordings are watched, so the route carries the destination
 * with it.
 *
 * `atSec` is LANE seconds (a `t_mono` offset), not media seconds. `TrackRail`
 * is the one place that converts; see its `seek`. Both producers get the number
 * from main's `laneSec`, so neither screen decides what a moment means.
 */
export interface OpenAt {
  sessionId: string;
  atSec: number;
  /**
   * Distinguishes two jumps to the SAME moment, which is otherwise a dead
   * click: React bails on identical state, so nothing downstream re-renders,
   * and `TrackRail`'s once-per-moment guard would refuse the repeat even if it
   * did. Easy to hit from Search — the screen unmounts on navigation, so
   * returning to it means re-running the query and clicking the same hit.
   */
  nonce: number;
}

export function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>("record");
  const [status, setStatus] = useState<RecordingStatus>({ state: "idle", activeSignals: [] });
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [openAt, setOpenAt] = useState<OpenAt | null>(null);
  /** A counter, not a clock: two clicks land in the same millisecond. */
  const jumps = useRef(0);

  /**
   * The one place a jump is minted. Both producers route through it so the
   * payload can never be half-built — a nonce is not optional, and a screen
   * that forgot one would fail silently on the second identical jump.
   */
  const openRecording = (sessionId: string, atSec: number): void => {
    jumps.current += 1;
    setOpenAt({ sessionId, atSec, nonce: jumps.current });
    setRoute("library");
  };

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
        <div className="rail__brand">
          <GhostMark size={30} />
          <span className="rail__brand-word">DeskRAG</span>
        </div>
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
          <span className="topbar__title">{TITLES[route]}</span>
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
          {/* `openAt` is cleared BY the Library once it has acted on it.
              Leaving it set would re-seek every time the user picked a
              different recording from the list. */}
          {route === "library" && (
            <LibraryScreen openAt={openAt} onOpened={() => setOpenAt(null)} />
          )}
          {route === "flows" && <FlowsScreen onOpenRecording={openRecording} />}
          {route === "search" && <SearchScreen onOpenRecording={openRecording} />}
          {route === "settings" && <SettingsScreen onEnv={setEnv} />}
        </main>
      </div>
    </div>
  );
}
