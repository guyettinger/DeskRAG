import React, { useEffect, useState } from "react";
import type { IndexJobDTO, IndexQueueDTO, IndexTickDTO } from "@shared/types";
import { api, durationShort, wallClock } from "../api.js";
import { GhostLottie } from "../brand/GhostLottie.js";
import { StageGraph } from "./StageGraph.js";

/**
 * The indexing queue, and what the pipeline is doing to each job in it.
 *
 * The screen exists because indexing stopped being a modal moment and became
 * background work: `stopRecording` hands off to a durable queue and returns, so
 * a second recording can start while the first indexes. Once that is true,
 * "what is happening to my recordings" has nowhere else to live — and the old
 * answer (a progress bar on the Record screen that vanished when it finished)
 * could not describe a crash, a failure, or a backlog.
 *
 * Two panes: the queue on the left, the selected job's stage ladder on the
 * right. The ladder is the point. It shows a QUEUED job's plan too — with the
 * gates already resolved — so a reader can see that captions will be skipped
 * before they are, rather than inferring it afterwards from their absence.
 */

const KIND_LABEL: Record<IndexJobDTO["kind"], string> = {
  record: "New recording",
  reindex: "Re-index",
  "trace-rebuild": "Trace graph",
};

const STATE_LABEL: Record<IndexJobDTO["state"], string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function IndexingScreen({ queue }: { queue: IndexQueueDTO | null }): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState<IndexTickDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The fine-grained stream, subscribed only HERE. It fires per frame in the
  // patch stage, and the shell has no use for it — only the open ladder does.
  useEffect(() => api.indexing.onTick(setTick), []);

  if (!queue) {
    return (
      <div className="page">
        <div className="loading">
          <div className="spinner" />
        </div>
      </div>
    );
  }

  const jobs = [...queue.jobs].reverse(); // newest first, like the Library
  // Follow the running job unless the reader has picked something else. A queue
  // that jumped to a new selection on every transition would be unreadable.
  const activeId = selected ?? queue.runningJobId ?? jobs[0]?.id ?? null;
  const active = jobs.find((j) => j.id === activeId) ?? null;

  const act = async (fn: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const finished = jobs.filter(
    (j) => j.state === "done" || j.state === "failed" || j.state === "cancelled",
  ).length;

  return (
    <div className="page jobs">
      <div className="page__head">
        <span className="eyebrow">Indexing queue</span>
        <h1>What the pipeline is doing</h1>
        <p>
          Recordings are indexed in the background, one at a time. Recording
          keeps working while this runs — indexing pauses itself for the length of a
          capture, because a dropped frame cannot be re-recorded and an index can
          always be rebuilt.
        </p>
      </div>

      {queue.heldMessage !== null && (
        <div className="banner">
          <span className="led" /> {queue.heldMessage}
        </div>
      )}
      {error !== null && (
        <div className="banner">
          <span className="led" /> {error}
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="empty">
          <GhostLottie size={104} className="empty__ghost" playing />
          <h2>Nothing to index</h2>
          <p>Every recording is indexed. New ones join this queue the moment they stop.</p>
        </div>
      ) : (
        <div className="jobs__stage">
          <div className="jobs__list">
            <div className="jobs__listhead">
              <span className="eyebrow">
                {jobs.length} job{jobs.length === 1 ? "" : "s"}
              </span>
              {finished > 0 && (
                <button
                  className="btn ghost"
                  onClick={() => void act(() => api.indexing.clearFinished())}
                >
                  Clear finished
                </button>
              )}
            </div>
            {jobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                tick={tick}
                active={job.id === activeId}
                onSelect={() => setSelected(job.id)}
                onCancel={() => void act(() => api.indexing.cancel(job.id))}
                onRetry={() => void act(() => api.indexing.retry(job.id))}
              />
            ))}
          </div>

          <div className="jobs__detail">
            {active === null ? (
              <p className="jobs__hint">Pick a job to see its pipeline.</p>
            ) : (
              <>
                <div className="jobs__detailhead">
                  <span className="eyebrow">{KIND_LABEL[active.kind]}</span>
                  <h2>{jobTitle(active)}</h2>
                  {/* The composed purpose is PROSE, not a title — it is a whole
                      sentence, and setting it as the heading gave this pane a
                      two-line run-on where a name belongs. Clamped and carrying
                      its full text in `title`, exactly as the Library card
                      does, so one recording reads the same way on both. */}
                  {active.sessionLabel !== null && (
                    <p className="jobs__purpose" title={active.sessionLabel}>
                      {active.sessionLabel}
                    </p>
                  )}
                  <p className="jobs__legend">
                    Top to bottom is the order stages RUN. The wires on the left are
                    what each stage needs — every one points at something above it.
                  </p>
                </div>
                {active.error !== null && (
                  <div className="banner">
                    <span className="led" /> {active.error}
                  </div>
                )}
                <StageGraph stages={withTick(active, tick)} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function JobRow({
  job,
  tick,
  active,
  onSelect,
  onCancel,
  onRetry,
}: {
  job: IndexJobDTO;
  tick: IndexTickDTO | null;
  active: boolean;
  onSelect: () => void;
  onCancel: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  const pct = job.total === 0 ? 0 : (job.done / job.total) * 100;
  const running = job.state === "running";
  const live = tick && tick.jobId === job.id ? tick.detail : null;
  const stage = job.stages.find((s) => s.state === "running");

  return (
    <div className={`job${active ? " is-active" : ""}`} onClick={onSelect}>
      {job.posterUrl !== null && <img className="job__thumb" src={job.posterUrl} alt="" />}
      <div className="job__body">
        <div className="job__head">
          <span className="job__kind">{KIND_LABEL[job.kind]}</span>
          <span className={`job__state job__state--${job.state}`}>{STATE_LABEL[job.state]}</span>
        </div>
        <div className="job__title">{jobTitle(job)}</div>
        {job.sessionLabel !== null && (
          <div className="job__purpose" title={job.sessionLabel}>
            {job.sessionLabel}
          </div>
        )}

        {running && (
          <>
            <div className="job__stage">
              {stage?.label ?? "Starting…"}
              {/* The live tick, which is the patch stage's per-frame count and
                  the whisper download's byte count. It is deliberately NOT a
                  second progress bar: the bar counts stages and only stages. */}
              {live !== null && <span className="mono job__ticker"> · {live}</span>}
            </div>
            <div className="bar">
              <div className="bar__fill" style={{ width: `${pct}%` }} />
            </div>
          </>
        )}

        <div className="job__meta">
          <span className="mono">
            {job.done}/{job.total} stages
          </span>
          <span>{jobWhen(job)}</span>
        </div>
      </div>

      <div className="job__actions">
        {job.state === "queued" && (
          <button
            className="btn ghost"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
          >
            Cancel
          </button>
        )}
        {(job.state === "failed" || job.state === "cancelled") && (
          <button
            className="btn ghost"
            onClick={(e) => {
              e.stopPropagation();
              onRetry();
            }}
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * What to call a job.
 *
 * The recording's WALL CLOCK, not its composed purpose. The purpose is a whole
 * sentence — measured in the running app at over 200 characters — and it read as
 * a two-line run-on where a name belongs. It is still shown, as prose beneath.
 *
 * A job queued the instant a recording stopped has no purpose at all yet, by
 * construction: it is written by a stage this job is about to run. So the clock
 * is the only thing every job can be named by, which is also what makes it the
 * right choice — a title that appeared later would move under the reader.
 */
function jobTitle(job: IndexJobDTO): string {
  if (job.kind === "trace-rebuild") return "Every recording, re-lifted into one graph";
  return wallClock(job.enqueuedAt);
}

function jobWhen(job: IndexJobDTO): string {
  if (job.startedAt !== null && job.endedAt !== null) {
    return `took ${durationShort(job.endedAt - job.startedAt)}`;
  }
  if (job.startedAt !== null) return `started ${wallClock(job.startedAt)}`;
  return `queued ${wallClock(job.enqueuedAt)}`;
}

/**
 * Fold the live tick into the ladder the DTO carried.
 *
 * The queue snapshot only fires on stage transitions, so without this the
 * running stage's detail would freeze at whatever it said when it began —
 * "Frame patches" with no count, for the several minutes that stage takes.
 */
function withTick(job: IndexJobDTO, tick: IndexTickDTO | null): IndexJobDTO["stages"] {
  if (!tick || tick.jobId !== job.id) return job.stages;
  return job.stages.map((s) => (s.id === tick.stageId ? { ...s, detail: tick.detail } : s));
}
