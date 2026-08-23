/**
 * Habits — recorded routes kept as HABIT.md files an agent can load.
 *
 * THIS SCREEN WRITES, and it is the only one that writes the user's own text.
 * Everything else in the app either captures, derives, or reads; a habit's
 * title, description and prose exist because someone typed them, which is why
 * the table is AUTHORED and why no re-index may touch it.
 *
 * Two panes, one selection, the Flows precedent. The list bands by what needs
 * answering; the editor shows one habit's prose above a read-only well holding
 * the record, because the file's two halves are written by different things and
 * the screen should not pretend otherwise.
 *
 * The markdown is rendered in MAIN and handed here verbatim. The Copy button
 * copies `habit.markdown` — the same string `get_habit` returns — so the two can
 * never drift.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  HabitDTO,
  HabitPatch,
  HabitProposalDTO,
  HabitsDTO,
  HabitWayDTO,
  WalkMarkDTO,
} from "@shared/types";
import { api, timecode, wallClock } from "../api.js";
import { GhostLottie } from "../brand/GhostLottie.js";
import {
  bandHabits,
  bandProposals,
  bindingChip,
  droppedEarlyLine,
  evidenceLine,
  generateDisabledReason,
  ledgerMarks,
  markLabel,
  markReadout,
  markStates,
  proposalEvidence,
  proposalTitle,
  recordTail,
  walkSpan,
} from "../habits-view.js";
import type { LedgerMark } from "../habits-view.js";
import { clampTip } from "./hover-card.js";
import { fadeLine } from "../habit-rhythm.js";

/** Distance from the mark to its card, and from the card to the window edge —
    the rail's two constants, which the shared `clampTip` reads. */
const TIP_OFFSET = 10;
const TIP_MARGIN = 8;

/** The span every ledger on the screen is drawn against. Null draws nothing. */
type Domain = { from: number; to: number } | null;

type Selection = { kind: "habit"; id: string } | { kind: "proposal"; routeKey: string };

function Head({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="page__head habits__head">
      <div className="habits__headtext">
        <span className="eyebrow">Habits</span>
        <h1>What you do repeatedly</h1>
        <p>
          A habit is a route your recordings walked more than once, written as a HABIT.md an
          agent can load. The marks beside each one are the recordings themselves — a route
          walked once is an observation, and it takes repetition to become a habit.
        </p>
      </div>
      {children}
    </div>
  );
}

export function HabitsScreen({
  onOpenRecording,
}: {
  /**
   * The one jump this screen makes. Minted in `App` like every other, so the
   * `OpenAt` nonce cannot be forgotten and the same mark clicked twice still
   * moves the playhead. Until now Habits was the only evidence surface in the
   * app with no way back to the recordings it argues from.
   */
  onOpenRecording: (sessionId: string, atSec: number) => void;
}): React.JSX.Element {
  const [data, setData] = useState<HabitsDTO | undefined>(undefined);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState<string | null>(null);

  useEffect(() => {
    void api.habits.list().then(setData);
  }, []);

  const run = (p: Promise<HabitsDTO>): void => {
    setBusy(true);
    void p
      .then(setData)
      .finally(() => setBusy(false));
  };

  const habit = useMemo(
    () =>
      selected?.kind === "habit" ? data?.habits.find((s) => s.id === selected.id) : undefined,
    [data, selected],
  );
  const proposal = useMemo(
    () =>
      selected?.kind === "proposal"
        ? data?.proposals.find((p) => p.routeKey === selected.routeKey)
        : undefined,
    [data, selected],
  );

  if (data === undefined) {
    return (
      <div className="page">
        <div className="loading">
          <div className="spinner" />
        </div>
      </div>
    );
  }

  // Read once per render. The threshold is four weeks, so a stale read cannot
  // move a row; a `useMemo` keyed on nothing would be the thing that could.
  const now = Date.now();
  const bands = bandHabits(data.habits, now);
  const seen = bandProposals(data.proposals);
  const nothing = data.habits.length === 0 && data.proposals.length === 0;

  // THREE distinct emptinesses, never one. No graph at all, a graph carrying no
  // provenance (zero routes, and the remedy is a rebuild), and a graph with
  // routes nobody has answered about yet.
  if (nothing) {
    return (
      <div className="page habits">
        <Head />
        <div className="empty">
          <GhostLottie size={104} playing />
          {!data.graphPresent ? (
            <p>
              No trace graph has been built yet. A graph is lifted from recordings when they
              are indexed — record something, or press <b>Rebuild trace graph</b> in Settings
              &rarr; Maintenance.
            </p>
          ) : (
            <p>
              No recorded routes to build a habit from. A route is a path a recording actually
              walked, so this is empty when the graph carries no provenance — press{" "}
              <b>Rebuild trace graph</b> in Settings &rarr; Maintenance and try again.
            </p>
          )}
        </div>
      </div>
    );
  }

  const patch = (id: string, p: HabitPatch): void => run(api.habits.update(id, p));

  return (
    <div className="page habits">
      {/* The counts the bar used to chip are said by the band heads a few pixels
          below, and saying them twice made the head the loudest thing on a
          screen whose subject is the rows. What survives is the one fact
          nothing else states: who writes the prose. */}
      <Head>
        <div className="habits__bar">
          <span className="muted">
            {data.prose.available ? `Prose by ${data.prose.model}` : "Prose from the template"}
          </span>
        </div>
      </Head>

      <div className="habits__stage">
        <aside className="habits__list">
          {bands.attention.length > 0 && (
            <Band title="Needs attention">
              {bands.attention.map((s) => (
                <HabitRow
                  key={s.id}
                  habit={s}
                  domain={data.domain}
                  active={habit?.id === s.id}
                  onSelect={() => setSelected({ kind: "habit", id: s.id })}
                />
              ))}
            </Band>
          )}

          {bands.mine.length > 0 && (
            <Band title="Kept">
              {bands.mine.map((s) => (
                <HabitRow
                  key={s.id}
                  habit={s}
                  domain={data.domain}
                  active={habit?.id === s.id}
                  onSelect={() => setSelected({ kind: "habit", id: s.id })}
                />
              ))}
            </Band>
          )}

          {/* Below Kept, because these ARE kept — what changed is that they
              stopped. The head states the fact and declines the verdict:
              a standard that moves is not a streak that broke. */}
          {bands.fading.length > 0 && (
            <Band title="Not walked lately">
              {bands.fading.map((s) => (
                <HabitRow
                  key={s.id}
                  habit={s}
                  domain={data.domain}
                  active={habit?.id === s.id}
                  onSelect={() => setSelected({ kind: "habit", id: s.id })}
                />
              ))}
            </Band>
          )}

          {/* Split on whether anything RECURRED, which is the distinction the
              whole screen turns on. One list ordered by count said the same
              thing in a glyph, and on the real store — four proposals, every
              one of them walked once — it said nothing at all. */}
          {seen.repeated.length > 0 && (
            <Band title="Repeated — not yet kept">
              {seen.repeated.map((p) => (
                <ProposalRow
                  key={p.routeKey}
                  proposal={p}
                  domain={data.domain}
                  active={proposal?.routeKey === p.routeKey}
                  onSelect={() => setSelected({ kind: "proposal", routeKey: p.routeKey })}
                />
              ))}
            </Band>
          )}

          {seen.once.length > 0 && (
            <Band title="Seen once">
              {seen.once.map((p) => (
                <ProposalRow
                  key={p.routeKey}
                  proposal={p}
                  domain={data.domain}
                  active={proposal?.routeKey === p.routeKey}
                  onSelect={() => setSelected({ kind: "proposal", routeKey: p.routeKey })}
                />
              ))}
            </Band>
          )}

          {bands.archived.length > 0 && (
            <Band title="Archived">
              {bands.archived.map((s) => (
                <HabitRow
                  key={s.id}
                  habit={s}
                  domain={data.domain}
                  active={habit?.id === s.id}
                  onSelect={() => setSelected({ kind: "habit", id: s.id })}
                />
              ))}
            </Band>
          )}

        </aside>

        <section className="habitedit">
          {habit !== undefined ? (
            <HabitEditor
              habit={habit}
              domain={data.domain}
              onOpenRecording={onOpenRecording}
              busy={busy}
              copied={copied}
              proseNote={generateDisabledReason(data.prose)}
              confirmRegen={confirmRegen === habit.id}
              onAskRegen={() => setConfirmRegen(habit.edited ? habit.id : null)}
              onCancelRegen={() => setConfirmRegen(null)}
              onGenerate={() => {
                setConfirmRegen(null);
                run(api.habits.generate(habit.id));
              }}
              onPatch={(p) => patch(habit.id, p)}
              onCopy={() => {
                void navigator.clipboard.writeText(habit.markdown).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                });
              }}
              onRebind={(routeKey) => run(api.habits.rebind(habit.id, routeKey))}
              duplicates={habit.duplicates.flatMap((id) => {
                const other = data.habits.find((s) => s.id === id);
                return other === undefined ? [] : [other];
              })}
              onMerge={(mergeId) => run(api.habits.merge(habit.id, mergeId))}
              onRemove={() => {
                setSelected(null);
                run(api.habits.remove(habit.id));
              }}
            />
          ) : proposal !== undefined ? (
            <ProposalPreview
              proposal={proposal}
              domain={data.domain}
              onOpenRecording={onOpenRecording}
              busy={busy}
              onAccept={() => {
                setSelected(null);
                run(api.habits.accept(proposal.routeKey));
              }}
              onDismiss={() => {
                setSelected(null);
                run(api.habits.dismiss(proposal.routeKey));
              }}
            />
          ) : (
            <div className="habitedit__blank muted">
              <p>Pick a habit to read or edit it, or a proposal to see what it would produce.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * THE SIGNATURE: one mark per recording, on the axis every row shares.
 *
 * "We are what we repeatedly do" is only an argument if repetition is the thing
 * you can see, and before this the screen showed it as `×1` in muted mono in a
 * gutter — the least weight on the page given to the fact the page exists for.
 * A ledger cannot be read as anything but what it is: three marks are three
 * recordings, and a lone hollow ring is one afternoon.
 *
 * It draws MARKS ON AN AXIS rather than a bar or a score. A bar would assert a
 * magnitude nothing measured, and a strength percentage would be exactly the
 * `FrameResult.score` sin one layer down — an ordering wearing a confidence. A
 * mark is a recording; there is nothing to misread.
 *
 * IT IS AN INSTRUMENT WHERE IT CAN BE, AND DECORATION WHERE IT CANNOT — and
 * which one is decided by `onOpen`, never by `size`.
 *
 * A mark IS a recording, so the reader should be able to ask it which one and
 * go and watch it. Two of the four ledgers on this screen sit INSIDE the row
 * `<button>` that selects a habit, and a button inside a button is invalid and
 * would take the row's own click with it. So those stay exactly as they were:
 * `aria-hidden`, inert, a picture beside words that already state the fact. The
 * two in a masthead — the editor's and the proposal preview's — are outside any
 * button and become the thing you can question.
 *
 * Interactive, it stops being `aria-hidden` and every mark carries the same
 * sentence the card shows: an action cannot be hidden from a screen reader, and
 * a position is not a fact anyone should have to see to get.
 */
function Ledger({
  walks,
  domain,
  size = "row",
  onOpen,
}: {
  walks: readonly WalkMarkDTO[];
  domain: Domain;
  size?: "row" | "lead";
  /** Given, the marks become buttons. Omitted, the ledger is a picture. */
  onOpen?: (sessionId: string, atSec: number) => void;
}): React.JSX.Element | null {
  const [hover, setHover] = useState<{ mark: LedgerMark; x: number; y: number } | null>(null);
  const marks = ledgerMarks(walks, domain);
  if (marks.length === 0) return null;
  // A single mark is drawn HOLLOW. It is the one visual difference between an
  // observation and a habit, and it has to survive being glanced at.
  const states = markStates(marks);
  const tone = (m: LedgerMark, i: number): string => {
    const state = states[i];
    return [
      "ledger__mark",
      state === "lone" ? "is-lone" : "",
      state === "deviated" ? "is-deviated" : "",
      state === "short" ? "is-short" : "",
      // Last, so the ring composes over whichever fill the state chose.
      m.gained ? "is-gained" : "",
    ]
      .filter((c) => c !== "")
      .join(" ");
  };

  if (onOpen === undefined) {
    return (
      <span className={`ledger ledger--${size}`} aria-hidden="true">
        <span className="ledger__axis" />
        {marks.map((m, i) => (
          <span key={m.sessionId} className={tone(m, i)} style={{ left: `${m.x * 100}%` }} />
        ))}
      </span>
    );
  }

  /** Where the card should point, from the mark itself rather than the cursor,
      so a keyboard focus places it exactly as a hover does. */
  const anchor = (el: Element): { x: number; y: number } => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom };
  };

  return (
    <span
      className={`ledger ledger--${size} ledger--live`}
      role="group"
      aria-label="Recordings that walked this route"
      onMouseLeave={() => setHover(null)}
    >
      <span className="ledger__axis" />
      {marks.map((m, i) => {
        const label = markLabel(markReadout(m.walk, { wallClock, timecode }));
        const walk = m.walk.walk;
        return (
          <button
            key={m.sessionId}
            type="button"
            // The HIT BOX is the button; the MARK is the span inside it. A mark
            // is nine pixels because that is the size of the thing it reports,
            // and widening it to be clickable would be the lie the track rail's
            // separate `.tracks__span-hit` exists to refuse.
            className="ledger__hit"
            style={{ left: `${m.x * 100}%` }}
            // Withheld, never offered dead — the Search hit's `sessionId !== ""`
            // guard. An orphaned habit's marks have no live route and so no
            // moment; the card says that in words.
            disabled={walk === null}
            aria-label={label}
            title={label}
            onMouseEnter={(e) => setHover({ mark: m, ...anchor(e.currentTarget) })}
            onFocus={(e) => setHover({ mark: m, ...anchor(e.currentTarget) })}
            onBlur={() => setHover(null)}
            onClick={() => {
              if (walk !== null) onOpen(m.sessionId, walk.atSec);
            }}
          >
            <span className={tone(m, i)} />
          </button>
        );
      })}
      {hover && <MarkCard mark={hover.mark.walk} x={hover.x} y={hover.y} />}
    </span>
  );
}

/**
 * What one mark says, positioned off the mark rather than inside the ledger.
 *
 * `position: fixed` and MEASURED then clamped, exactly as the track rail's
 * readout card is — a card sized by a guess ran off the bottom of the window
 * there, and the arithmetic is now shared (`hover-card.ts`) so the two cannot
 * drift. Hidden for the one frame between mount and measurement, so it never
 * appears at an unclamped position and jumps.
 */
function MarkCard({
  mark,
  x,
  y,
}: {
  mark: WalkMarkDTO;
  x: number;
  y: number;
}): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const readout = markReadout(mark, { wallClock, timecode });

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos(
      clampTip(
        { x, y },
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
        { offset: TIP_OFFSET, margin: TIP_MARGIN },
      ),
    );
  }, [x, y, mark]);

  return (
    <div
      className="ledger__tip"
      ref={cardRef}
      style={{
        left: pos?.left ?? x + TIP_OFFSET,
        top: pos?.top ?? y + TIP_OFFSET,
        visibility: pos ? undefined : "hidden",
      }}
    >
      <div className="ledger__tip-when">{readout.when}</div>
      {readout.at !== null && (
        <div className="ledger__tip-at mono">
          {readout.at}
          {readout.steps !== null && ` · ${readout.steps}`}
        </div>
      )}
      {readout.fit !== null && <div className="ledger__tip-fit">{readout.fit}</div>}
      {readout.note !== null && <div className="ledger__tip-note">{readout.note}</div>}
      {readout.action !== null && <div className="ledger__tip-go">{readout.action}</div>}
    </div>
  );
}

/**
 * What the three hues mean, said once.
 *
 * Beside the LEAD ledger only, never per row: four legends down a list is
 * chrome, and a row's ledger is `aria-hidden` decoration beside words that
 * already state the fact.
 *
 * The last sentence is load-bearing and is not decoration. A key reading
 * "followed / differed / stopped short" and stopping smuggles a grade back in
 * through the ordering alone — this is the one place in the sub-project where
 * the no-grade rule is carried by prose rather than by structure.
 */
function LedgerLegend(): React.JSX.Element {
  return (
    <div className="ledger-legend">
      <span className="ledger-legend__item">
        <span className="ledger__mark ledger-legend__swatch" /> followed the standard
      </span>
      <span className="ledger-legend__item">
        <span className="ledger__mark ledger-legend__swatch is-deviated" /> went another way
      </span>
      <span className="ledger-legend__item">
        <span className="ledger__mark ledger-legend__swatch is-short" /> stopped before the end
      </span>
      <p className="ledger-legend__note">
        The standard is whichever way these recordings most agreed on, and it moves as you
        record more. Going another way is not a mistake.
      </p>
    </div>
  );
}

/**
 * The recorded steps, as an instrument rather than as text.
 *
 * Ledger marks have been able to open a recording since `c205413`; the steps —
 * the part a person is actually asked to trust — could not, so the record was
 * trusted rather than verifiable. Drawn from `HabitDTO.ways`, which main built
 * from the same `FlowWalk[]` the file is rendered from: two renderers of one
 * thing is a drift hazard, and they are safe only because neither parses the
 * other's output.
 *
 * A step with no moment is DRAWN and states its reason — the
 * `StageSpec.skipReason` rule, and the same rule that already makes a mark with
 * no walk say why it cannot be followed. A disabled control with no explanation
 * is indistinguishable from one nobody implemented.
 */
function RecordedSteps({
  ways,
  onOpen,
}: {
  ways: readonly HabitWayDTO[];
  onOpen: (sessionId: string, atSec: number) => void;
}): React.JSX.Element | null {
  if (ways.length === 0) return null;
  const many = ways.length > 1;
  return (
    <div className="habitsteps">
      {many && (
        <p className="habitsteps__ways">
          The recordings did not take the same path. Each way below is a complete walk that a
          recording actually made — follow one of them, not all of them in sequence.
        </p>
      )}
      {ways.map((way) => (
        <section key={way.letter} className="habitsteps__way">
          {many && (
            <h4 className="habitsteps__wayhead">
              Way {way.letter} — {way.steps.length} step{way.steps.length === 1 ? "" : "s"},{" "}
              {way.sessionIds.length === 1 ? "1 recording" : `${way.sessionIds.length} recordings`}
            </h4>
          )}
          <ol className="habitsteps__list">
            {way.steps.map((step) => (
              <li key={`${way.letter}-${step.index}`} className="habitsteps__step">
                <div className="habitsteps__head">
                  <span className="habitsteps__places">
                    {step.missing
                      ? `edge ${step.edgeId} is not in the graph (index defect)`
                      : `${step.from} → ${step.to}`}
                  </span>
                  {step.firstAt === null ? (
                    <span className="habitsteps__noopen">
                      No recording carries this step, so there is no moment to open
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn ghost habitsteps__open"
                      onClick={() => {
                        const at = step.firstAt;
                        if (at !== null) onOpen(at.sessionId, at.atSec);
                      }}
                    >
                      Open this moment
                    </button>
                  )}
                </div>
                {step.actions.length === 0 ? (
                  <p className="habitsteps__action muted">(no actions recorded on this edge)</p>
                ) : (
                  step.actions.map((a, i) => (
                    <p key={i} className="habitsteps__action mono">
                      {a.action}
                      {a.target === "—" || a.target === "" ? "" : ` — ${a.target}`}
                    </p>
                  ))
                )}
                <p className="habitsteps__count">
                  {step.observations === 1
                    ? "walked once"
                    : `walked by ${step.observations} recordings`}
                </p>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function Band({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="habits__band">
      <div className="habits__bandhead">
        <span className="eyebrow">{title}</span>
      </div>
      <ul className="habits__items">{children}</ul>
    </div>
  );
}

function HabitRow({
  habit,
  domain,
  active,
  onSelect,
}: {
  habit: HabitDTO;
  domain: Domain;
  active: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const chip = bindingChip(habit);
  const span = walkSpan(habit.binding.walks);
  // The same work begun and abandoned partway. A DISCLOSURE beside the count,
  // never folded into it: those recordings walked a different route.
  const dropped = droppedEarlyLine(habit);
  // Null unless this row is in the "Not walked lately" band, so the band head
  // and the line can never disagree — both ask `hasFaded`.
  const faded = fadeLine(habit.binding.walks, Date.now());
  return (
    <li>
      <button className={`habit${active ? " is-active" : ""}`} onClick={onSelect}>
        <span className="habit__title">{habit.title}</span>
        {/* The slug and the `llm`/`template` tag both left the row. Neither
            helps choose between two habits, and the row's job is the choosing —
            the slug is in the editor's own subtitle and the tag beside the
            prose that it describes. */}
        <Ledger walks={habit.binding.walks} domain={domain} />
        <span className="habit__meta">
          <span className="mono">{evidenceLine(habit)}</span>
          {dropped !== null && <span className="mono">{dropped}</span>}
          {faded !== null && <span className="mono">{faded}</span>}
          {span !== null && <span className="mono">{span}</span>}
          {habit.edited && <span className="habit__tag mono">edited</span>}
          {habit.pinned && <span className="habit__tag mono">pinned</span>}
        </span>
        {chip !== null && <span className="habit__bind mono">{chip}</span>}
      </button>
    </li>
  );
}

function ProposalRow({
  proposal,
  domain,
  active,
  onSelect,
}: {
  proposal: HabitProposalDTO;
  domain: Domain;
  active: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const span = walkSpan(proposal.walks);
  return (
    <li>
      <button
        className={`habit${active ? " is-active" : ""}`}
        onClick={onSelect}
        title={proposalTitle(proposal)}
      >
        <span className="habit__title">{proposal.name ?? proposal.label}</span>
        {/* `×N` is gone from the gutter. It was the same fact three times over —
            the glyph, the words below, and now the marks — and it was the one
            of the three that could only be read as a number. */}
        <Ledger walks={proposal.walks} domain={domain} />
        <span className="habit__meta">
          {/* Recurrence in WORDS, at every count. */}
          <span className="mono">{proposalEvidence(proposal)}</span>
          {span !== null && <span className="mono">{span}</span>}
          <span className="mono">
            {proposal.stepSummary}
            {proposal.variants > 0 && " · merged"}
          </span>
        </span>
      </button>
    </li>
  );
}

function ProposalPreview({
  proposal,
  domain,
  busy,
  onAccept,
  onDismiss,
  onOpenRecording,
}: {
  proposal: HabitProposalDTO;
  domain: Domain;
  busy: boolean;
  onAccept: () => void;
  onDismiss: () => void;
  onOpenRecording: (sessionId: string, atSec: number) => void;
}): React.JSX.Element {
  const span = walkSpan(proposal.walks);
  return (
    <div className="habitedit__body">
      <header className="habitedit__masthead">
        <span className="eyebrow">
          {proposal.count > 1 ? "Repeated — not yet kept" : "Seen once"}
        </span>
        <h2>{proposal.name ?? proposal.label}</h2>
        <div className="habitedit__evidence">
          <Ledger
            walks={proposal.walks}
            domain={domain}
            size="lead"
            onOpen={onOpenRecording}
          />
          <p className="mono">
            {proposalEvidence(proposal)}
            {span !== null && ` · ${span}`}
          </p>
        </div>
      </header>

      {proposal.count === 1 && (
        <p className="banner">
          Recorded once. Kept from a single observation, and nothing has confirmed it repeats — keeping it
          is reasonable, but an agent should not read it as how the task is done.
        </p>
      )}
      <div className="habitedit__actions">
        <button className="btn" disabled={busy} onClick={onAccept}>
          Keep as a habit
        </button>
        <button className="btn ghost" disabled={busy} onClick={onDismiss}>
          Not a habit
        </button>
      </div>

      <div className="habitedit__recordhead">
        <span className="eyebrow">The record it would produce</span>
      </div>
      <p className="muted">The prose above it is written when you keep it.</p>
      <pre className="habitedit__record mono">{proposal.preview}</pre>
    </div>
  );
}

function HabitEditor({
  habit,
  domain,
  onOpenRecording,
  busy,
  copied,
  proseNote,
  confirmRegen,
  onAskRegen,
  onCancelRegen,
  onGenerate,
  onPatch,
  onCopy,
  onRebind,
  duplicates,
  onMerge,
  onRemove,
}: {
  habit: HabitDTO;
  domain: Domain;
  onOpenRecording: (sessionId: string, atSec: number) => void;
  busy: boolean;
  copied: boolean;
  proseNote: string | null;
  confirmRegen: boolean;
  onAskRegen: () => void;
  onCancelRegen: () => void;
  onGenerate: () => void;
  onPatch: (p: HabitPatch) => void;
  onCopy: () => void;
  onRebind: (routeKey: string) => void;
  /** The OTHER active habits on this same live route. Usually empty. */
  duplicates: HabitDTO[];
  onMerge: (mergeId: string) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const b = habit.binding;
  // Merging archives somebody else's habit, so it is confirmed. The state holds
  // WHICH one, because a habit can duplicate more than one at a time.
  const [confirmMerge, setConfirmMerge] = useState<string | null>(null);
  // The record is not editable here, and the file says the same thing. Splitting
  // the document at the heading is how the screen shows which half is which.
  const record = recordTail(habit.markdown);

  const span = walkSpan(b.walks);

  return (
    <div className="habitedit__body">
      {/* A DOCUMENT, not a form. The habit's own title existed on this pane only
          as the value of a text input, so the selected habit had no heading at
          all and the editor opened on the word TITLE. */}
      <header className="habitedit__masthead">
        <span className="eyebrow">{habit.state === "archived" ? "Archived" : "Kept"}</span>
        <h2>{habit.title}</h2>
        <p className="habitedit__slugline mono">
          {habit.slug} · v{habit.version}
        </p>
        <div className="habitedit__evidence">
          <Ledger walks={b.walks} domain={domain} size="lead" onOpen={onOpenRecording} />
          <p className="mono">
            {evidenceLine(habit)}
            {span !== null && ` · ${span}`}
          </p>
        {b.walks.some((w) => w.fit !== null) && <LedgerLegend />}
        </div>
      </header>

      {b.note !== null && (
        <div className="banner habitedit__bind">
          <p>{b.note}</p>
          {b.state === "rebound" && b.liveRouteKey !== null && (
            <button className="btn" disabled={busy} onClick={() => onRebind(b.liveRouteKey!)}>
              Re-bind to it
            </button>
          )}
          {b.state === "ambiguous" &&
            b.candidates.map((c) => (
              <button key={c} className="btn" disabled={busy} onClick={() => onRebind(c)}>
                Re-bind to {c}
              </button>
            ))}
        </div>
      )}

      {duplicates.length > 0 && (
        <div className="banner habitedit__bind">
          <p>
            {duplicates.length === 1 ? "Another habit describes" : "Other habits describe"} this
            same recorded route: {duplicates.map((d) => d.title).join(", ")}. Merging keeps this
            one and appends the other&rsquo;s prose to it; the other is archived, not deleted.
          </p>
          {duplicates.map((d) =>
            confirmMerge === d.id ? (
              <div className="confirm" key={d.id}>
                <p>
                  {d.title} is archived, and its prose is appended below yours under a heading.
                  Nothing it wrote is discarded.
                </p>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    setConfirmMerge(null);
                    onMerge(d.id);
                  }}
                >
                  Merge it in
                </button>
                <button className="btn" onClick={() => setConfirmMerge(null)}>
                  Leave both
                </button>
              </div>
            ) : (
              <button
                key={d.id}
                className="btn"
                disabled={busy}
                onClick={() => setConfirmMerge(d.id)}
              >
                Merge in {d.title}
              </button>
            ),
          )}
        </div>
      )}

      {habit.generateNote !== null && <p className="banner">{habit.generateNote}</p>}

      {/* The file's two halves, said once each: this heading over what a person
          writes, the record's own heading over what the recording wrote. */}
      <div className="habitedit__recordhead">
        <span className="eyebrow">Yours to write</span>
      </div>

      <label className="habitedit__field">
        <span className="habitedit__label">Title</span>
        <input
          type="text"
          value={habit.title}
          onChange={(e) => onPatch({ title: e.target.value })}
        />
      </label>

      <label className="habitedit__field">
        <span className="habitedit__label">Description</span>
        <span className="habitedit__hint">
          How an agent decides whether to load this file at all.
        </span>
        <textarea
          rows={2}
          value={habit.description}
          onChange={(e) => onPatch({ description: e.target.value })}
        />
      </label>

      <label className="habitedit__field">
        <span className="habitedit__label">Name</span>
        <span className="habitedit__hint">The frontmatter <code>name:</code>, and the folder it would live in.</span>
        <input
          type="text"
          className="mono"
          value={habit.slug}
          onChange={(e) => onPatch({ slug: e.target.value })}
        />
      </label>

      <label className="habitedit__field">
        <span className="habitedit__label">Prose</span>
        <span className="habitedit__hint">
          Yours or the model&rsquo;s. Everything below is generated from the recording and
          cannot be edited here.
        </span>
        <textarea
          rows={10}
          value={habit.body}
          onChange={(e) => onPatch({ body: e.target.value })}
        />
      </label>

      {/* The version moved to the masthead, beside the name it versions. What
          stays is the thing a version number cannot say: what last moved it. */}
      {habit.history.length > 0 && (
        <p className="muted mono">
          {`Last change: ${habit.history[habit.history.length - 1]!.what}, ${new Date(
            habit.history[habit.history.length - 1]!.at,
          ).toLocaleDateString()}`}
        </p>
      )}

      {/* HIERARCHY, not five identical pills. `.btn` defaults to filled accent,
          so every one of these read as primary — including Forget, sitting
          against Copy HABIT.md in the same row at the same weight. Copy is the
          point of the screen (it is what an agent loads), so it is the only
          filled control; Forget is separated and stays `.danger`. */}
      <div className="habitedit__actions">
        <button className="btn" onClick={onCopy}>
          {copied ? "Copied" : "Copy HABIT.md"}
        </button>
        {confirmRegen ? (
          <div className="confirm">
            <p>This replaces the prose you wrote. The recorded steps are unaffected.</p>
            <button className="btn danger" disabled={busy} onClick={onGenerate}>
              Replace it
            </button>
            <button className="btn ghost" onClick={onCancelRegen}>
              Keep mine
            </button>
          </div>
        ) : (
          <button
            className="btn ghost"
            disabled={busy}
            onClick={habit.edited ? onAskRegen : onGenerate}
            title={proseNote ?? undefined}
          >
            {busy ? "Writing…" : "Generate with model"}
          </button>
        )}
        <button
          className="btn ghost"
          disabled={busy}
          onClick={() => onPatch({ pinned: !habit.pinned })}
        >
          {habit.pinned ? "Unpin" : "Pin"}
        </button>
        <button
          className="btn ghost"
          disabled={busy}
          onClick={() => onPatch({ state: habit.state === "archived" ? "active" : "archived" })}
        >
          {habit.state === "archived" ? "Restore" : "Archive"}
        </button>
        <span className="habitedit__gap" />
        <button className="btn danger" disabled={busy} onClick={onRemove}>
          Forget
        </button>
      </div>

      {/* The record LAST, because it is the tallest thing here and the actions
          must not sit below it — Copy HABIT.md was entirely off-screen at
          1180x800, which only the screenshot showed. */}
      <div className="habitedit__recordhead habitedit__recordhead--cut">
        <span className="eyebrow">The record — the recording, not editable</span>
      </div>
      <RecordedSteps ways={habit.ways} onOpen={onOpenRecording} />
      {record !== "" && <pre className="habitedit__record mono">{record}</pre>}

      {/* The reason in WORDS, not a greyed control with no explanation. */}
      {proseNote !== null && <p className="muted">{proseNote}</p>}

      <label className="habitedit__toggle">
        <input
          type="checkbox"
          checked={habit.showSamples}
          onChange={(e) => onPatch({ showSamples: e.target.checked })}
        />
        <span>
          Show recorded values. Off by default — these are verbatim keystrokes and may include
          anything that was typed, including a password. The file says so too.
        </span>
      </label>
    </div>
  );
}
