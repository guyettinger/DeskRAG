import React, { useEffect, useRef, useState } from "react";
import type { EnvInfo, IndexQueueDTO, RecordingStatus } from "@shared/types";
import { api } from "./api.js";
import { GhostMark } from "./brand/GhostMark.js";
import {
  IconFlows,
  IconSkills,
  IconIndexing,
  IconLibrary,
  IconRecord,
  IconSearch,
  IconSettings,
} from "./icons.js";
import { IndexingScreen } from "./screens/IndexingScreen.js";
import { LibraryScreen } from "./screens/LibraryScreen.js";
import { RecordScreen } from "./screens/RecordScreen.js";
import { FlowsScreen } from "./screens/FlowsScreen.js";
import { SearchScreen } from "./screens/SearchScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";
import { SkillsScreen } from "./screens/SkillsScreen.js";

type Route = "record" | "indexing" | "library" | "flows" | "skills" | "search" | "settings";

// Between Record and Library, which is the order the work actually happens in:
// a recording is captured, then indexed, then watched.
const NAV: { id: Route; label: string; Icon: typeof IconRecord }[] = [
  { id: "record", label: "Record", Icon: IconRecord },
  { id: "indexing", label: "Indexing", Icon: IconIndexing },
  { id: "library", label: "Library", Icon: IconLibrary },
  { id: "flows", label: "Flows", Icon: IconFlows },
  // After Flows: a skill is made FROM a flow, which is the order the work happens in.
  { id: "skills", label: "Skills", Icon: IconSkills },
  { id: "search", label: "Search", Icon: IconSearch },
  { id: "settings", label: "Settings", Icon: IconSettings },
];

const TITLES: Record<Route, string> = {
  record: "Recorder",
  indexing: "Indexing",
  library: "Library",
  flows: "Flows",
  skills: "Skills",
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
  const [queue, setQueue] = useState<IndexQueueDTO | null>(null);
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

  /**
   * The queue is subscribed at the SHELL, not only on the Indexing screen.
   *
   * Indexing now runs in the background for minutes at a time, and the topbar
   * chip is the only thing that says so from the other five screens. Subscribing
   * per-screen would mean the chip appeared when you navigated to it.
   */
  useEffect(() => {
    api.indexing.queue().then(setQueue);
    return api.indexing.onQueue(setQueue);
  }, []);

  const live = status.state === "recording";
  const indexing = queue?.runningJobId != null;
  const pending = queue ? queue.jobs.filter((j) => j.state === "queued").length : 0;

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
            {/* A BUTTON, not a chip: indexing now happens somewhere the reader
                can go and look at, so the status is also the way there. The
                count is the backlog behind the running job, which is the number
                that actually predicts how long this will go on. */}
            {indexing && (
              <button
                className="chip busy chip--go"
                onClick={() => setRoute("indexing")}
                title="Open the indexing queue"
              >
                <span className="dot" /> Indexing
                {pending > 0 && <span className="mono">+{pending}</span>}
              </button>
            )}
            {!live && !indexing && (
              <span className="chip">
                <span className="dot" /> Idle
              </span>
            )}
          </div>
        </header>

        <main className="content">
          {route === "record" && (
            <RecordScreen status={status} env={env} onOpenIndexing={() => setRoute("indexing")} />
          )}
          {/* The queue arrives as a prop rather than being re-fetched: the shell
              already holds it for the topbar chip, and two subscriptions to one
              channel would show two answers for one moment. */}
          {route === "indexing" && <IndexingScreen queue={queue} />}
          {/* `openAt` is cleared BY the Library once it has acted on it.
              Leaving it set would re-seek every time the user picked a
              different recording from the list. */}
          {route === "library" && (
            <LibraryScreen openAt={openAt} onOpened={() => setOpenAt(null)} />
          )}
          {route === "flows" && <FlowsScreen onOpenRecording={openRecording} />}
          {route === "skills" && <SkillsScreen />}
          {route === "search" && <SearchScreen onOpenRecording={openRecording} />}
          {route === "settings" && <SettingsScreen onEnv={setEnv} />}
        </main>
      </div>
    </div>
  );
}
