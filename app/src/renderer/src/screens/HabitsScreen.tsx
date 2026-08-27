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
  HabitForkDTO,
  HabitPatch,
  HabitProposalDTO,
  HabitsDTO,
  HabitWayDTO,
  WalkMarkDTO,
} from "@shared/types";
import { api, timecode, wallClock } from "../api.js";
import { foldFork, waySecs, type ForkRunView } from "../way-fork-view.js";
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
  walkSpan,
} from "../habits-view.js";
import type { LedgerMark } from "../habits-view.js";
import { clampTip } from "./hover-card.js";
import {
  cellLabel,
  DAYS,
  fadeLine,
  HOUR_TICK_SPAN,
  HOUR_TICKS,
  rhythmLabel,
  rhythmNote,
  rhythmOf,
  type PhaseCell,
} from "../habit-rhythm.js";
import { placeLabel, portraitOf } from "../habit-portrait.js";
import {
  appTones,
  liftingRollup,
  rangeText,
  spineRows,
  stripLanes,
  type SpineRow,
  type SpineView,
  type StripView,
} from "../habit-record-view.js";

/** Distance from the mark to its card, and from the card to the window edge —
    the rail's two constants, which the shared `clampTip` reads. */
const TIP_OFFSET = 10;
const TIP_MARGIN = 8;

/**
 * How long the phase grid's card survives the pointer leaving a cell.
 *
 * It exists so a pointer can TRAVEL into the card, which the ledger's never
 * needs to do: an hour holding several walks lists them with their own Open
 * buttons, and a card that closes the instant the cursor leaves the cell is a
 * control nobody can reach.
 */
const TIP_LINGER = 160;

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

      <Portrait data={data} />

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
      <MarkReadout mark={mark} />
    </div>
  );
}

/**
 * What ONE walk says — the ledger's card and the phase grid's, from one source.
 *
 * Two renderers of one readout is the `ax-dump`/`ax-exec` drift hazard by name:
 * the two cards report the same recording, and a field added to `markReadout`
 * that reached only one of them would be a difference nothing fails on. There
 * is no second copy to keep in step because there is no second copy.
 */
function MarkReadout({ mark }: { mark: WalkMarkDTO }): React.JSX.Element {
  const readout = markReadout(mark, { wallClock, timecode });
  return (
    <>
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
    </>
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
/**
 * Where in the WEEK, beside the ledger's where in your life.
 *
 * The ledger draws an absolute wall clock shared by every row, which is what
 * makes a habit practised last week read differently from one practised in
 * March. It cannot say that a habit happens every Tuesday at 9am — and context
 * stability is the measured driver of automaticity, so a habit in phase and one
 * at random currently draw identically.
 *
 * BELOW THE FLOOR IT DRAWS NOTHING AND SAYS WHY. Three walks in 168 cells is
 * decoration, and the author's real kept habit is exactly that case. A strip
 * that merely never appeared would be indistinguishable from one nobody
 * implemented — the `StageSpec.skipReason` rule, one screen over.
 *
 * One hue, `--data-0`, for the reason `Portrait` uses one.
 */
function Rhythm({
  walks,
  onOpen,
}: {
  walks: readonly WalkMarkDTO[];
  onOpen: (sessionId: string, atSec: number) => void;
}): React.JSX.Element | null {
  // Nothing to place at all. Rendered as nothing, exactly as `Ledger` returns
  // null at zero marks — the editor is already saying there are no recordings.
  const [hover, setHover] = useState<{ cell: PhaseCell; day: number; hour: number; x: number; y: number } | null>(
    null,
  );
  // The card can hold BUTTONS when an hour holds several walks, so the pointer
  // must be able to travel into it. A bare `onMouseLeave` on the grid closes it
  // out from under the cursor mid-journey; the timer is what spans the gap, and
  // entering the card cancels it. The ledger's card stays a pure tooltip and
  // needs none of this — it never holds a control.
  const closing = useRef<number | null>(null);
  const hold = (): void => {
    if (closing.current !== null) window.clearTimeout(closing.current);
    closing.current = null;
  };
  const release = (): void => {
    hold();
    closing.current = window.setTimeout(() => setHover(null), TIP_LINGER);
  };
  useEffect(() => () => hold(), []);

  if (walks.length === 0) return null;
  const rhythm = rhythmOf(walks);

  /** Where the card points, from the CELL rather than the cursor, so a keyboard
      focus places it exactly as a hover does — the ledger's rule. */
  const anchor = (el: Element): { x: number; y: number } => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom };
  };

  return (
    <div className="rhythm">
      <span className="eyebrow">In phase</span>
      {rhythm.kind === "too-few" ? (
        <p className="rhythm__note">{rhythm.reason}</p>
      ) : (
        <>
          <div
            className="rhythm__grid"
            role="group"
            aria-label={rhythmLabel(rhythm.grid)}
            onMouseLeave={release}
          >
            {rhythm.grid.cells.map((row, day) => (
              <React.Fragment key={DAYS[day]}>
                <span className="rhythm__day mono">{DAYS[day]}</span>
                {row.map((cell, hour) => {
                  const label = cellLabel(day, hour, cell);
                  const paint = {
                    background: `color-mix(in oklab, var(--data-0) ${25 + Math.round(65 * (cell.count / rhythm.grid.peak))}%, transparent)`,
                  };
                  // An EMPTY hour is not a control. 164 of 168 cells are empty
                  // on a real store, and making every one of them focusable
                  // would put 168 tab stops in front of the four that lead
                  // somewhere.
                  if (cell.count === 0) {
                    return <span key={hour} className="rhythm__cell" title={label} />;
                  }
                  // The EARLIEST walk in the hour — the cell's walks are sorted
                  // oldest first by `rhythmOf`, which sorts rather than trusts
                  // for exactly this read.
                  const first = cell.walks.find((w) => w.walk !== null) ?? null;
                  return (
                    <button
                      key={hour}
                      type="button"
                      // The HIT BOX is the button and the MARK is the span
                      // inside it — the ledger's rule, and the rail's before
                      // it. A cell is the size of the hour it reports.
                      className="rhythm__hit"
                      // Withheld, never offered dead. An orphaned habit has no
                      // live route, so its walks carry no moment; the card says
                      // so in words rather than leaving a control that does
                      // nothing when pressed.
                      disabled={first === null}
                      aria-label={label}
                      title={label}
                      onMouseEnter={(e) => {
                        hold();
                        setHover({ cell, day, hour, ...anchor(e.currentTarget) });
                      }}
                      onMouseLeave={release}
                      onFocus={(e) => {
                        hold();
                        setHover({ cell, day, hour, ...anchor(e.currentTarget) });
                      }}
                      onBlur={release}
                      onClick={() => {
                        if (first?.walk != null) onOpen(first.sessionId, first.walk.atSec);
                      }}
                    >
                      <span className="rhythm__cell" style={paint} />
                    </button>
                  );
                })}
              </React.Fragment>
            ))}
            {/* THE HOUR AXIS, which the grid shipped without. Seven rows of 24
                unlabelled cells could say a habit repeats somewhere mid-week
                and never that it happens at 9am — measured in the running app,
                168 cells and no hour anywhere on screen. A tick spans three
                columns so a two-digit label always has room. */}
            <span className="rhythm__day" aria-hidden="true" />
            {HOUR_TICKS.map((t) => (
              <span
                key={t.hour}
                className="rhythm__tick mono"
                style={{ gridColumn: `span ${HOUR_TICK_SPAN}` }}
              >
                {t.label}
              </span>
            ))}
          </div>
          <p className="rhythm__note">{rhythmNote(rhythm.grid)}</p>
        </>
      )}
      {hover && (
        <CellCard
          cell={hover.cell}
          title={cellLabel(hover.day, hover.hour, hover.cell)}
          x={hover.x}
          y={hover.y}
          onEnter={hold}
          onLeave={release}
          onOpen={onOpen}
        />
      )}
    </div>
  );
}

/**
 * What one hour of the week says, and how to follow it.
 *
 * Measured and clamped through the shared `clampTip`, exactly as the ledger's
 * card is — a card sized by a guess ran off the bottom of the window there, and
 * the arithmetic is shared so the two cannot drift.
 *
 * ONE walk needs no list: the cell itself opens it and the card is a pure
 * readout, identical to the ledger's. SEVERAL walks get a row each with its own
 * Open, because picking one silently would hide the others — the fork
 * instrument's rule that a step keeps its Open wherever it is drawn.
 */
function CellCard({
  cell,
  title,
  x,
  y,
  onEnter,
  onLeave,
  onOpen,
}: {
  cell: PhaseCell;
  title: string;
  x: number;
  y: number;
  onEnter: () => void;
  onLeave: () => void;
  onOpen: (sessionId: string, atSec: number) => void;
}): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

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
  }, [x, y, cell]);

  const many = cell.walks.length > 1;
  return (
    <div
      className="ledger__tip"
      ref={cardRef}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        left: pos?.left ?? x + TIP_OFFSET,
        top: pos?.top ?? y + TIP_OFFSET,
        // Hidden for the one frame between mount and measurement, so it never
        // appears at an unclamped position and jumps.
        visibility: pos ? undefined : "hidden",
      }}
    >
      <div className="ledger__tip-when">{title}</div>
      {cell.walks.map((w) =>
        many ? (
          <div key={w.sessionId} className="rhythm__tip-walk">
            <MarkReadout mark={w} />
            {w.walk === null ? (
              <span className="habitsteps__noopen">no moment to open</span>
            ) : (
              <button
                type="button"
                className="btn ghost rhythm__tip-open"
                onClick={() => onOpen(w.sessionId, w.walk!.atSec)}
              >
                Open
              </button>
            )}
          </div>
        ) : (
          <MarkReadout key={w.sessionId} mark={w} />
        ),
      )}
    </div>
  );
}

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
 * Where the ways fork.
 *
 * COLOUR CARRIES SPINE-VERSUS-FORK, NEVER WAY IDENTITY. Ways are told apart by
 * their printed letter and their lane position, so hue is never the only
 * channel and the palette does not have to stretch to N ways. The band is
 * `--data-6`, the one unclaimed indexed slot — `--data-0` is C2's portrait,
 * `--data-2`/`--data-3` are C1's deviated and short, and 1/4/5/7 are the
 * semantic aliases.
 *
 * A step keeps its "Open" wherever it is drawn: C1's rule that the record is
 * verifiable rather than merely trusted does not weaken inside a fork.
 */
function WayForkView({
  ways,
  fork,
  onOpen,
}: {
  ways: readonly HabitWayDTO[];
  fork: HabitForkDTO;
  onOpen: (sessionId: string, atSec: number) => void;
}): React.JSX.Element {
  const view = foldFork(fork, ways);
  return (
    <div className="wayfork">
      <p className="wayfork__lead">
        These recordings took different paths. The numbered steps are the part every way has in
        common; the band beneath a step is where they differ.
      </p>
      <div className="wayfork__chips">
        {ways.map((w) => (
          <span key={w.letter} className="wayfork__chip">
            <b>Way {w.letter}</b> · {w.steps.length} step{w.steps.length === 1 ? "" : "s"} ·{" "}
            {w.sessionIds.length === 1 ? "1 recording" : `${w.sessionIds.length} recordings`}
            {w.totalsMs.length > 0 && <> · {w.totalsMs.map(waySecs).join(", ")}</>}
          </span>
        ))}
      </div>
      {view.leading.length > 0 && <ForkBand runs={view.leading} />}
      <ol className="wayfork__spine">
        {view.steps.map((s) => (
          <li key={s.n} className="wayfork__step">
            <span className="wayfork__places">
              {/* The number is DRAWN, not left to the <ol> marker: the row is a
                  flex container, which removes the list-item display and takes
                  the marker with it. The lead sentence and the rendered file
                  both say "the numbered steps", so a silent marker would make
                  the screen contradict the file it is drawn beside. */}
              <span className="wayfork__n">{s.n}.</span> {s.from} → {s.to}
            </span>
            <div className="wayfork__ats">
              {s.at.map((a) => {
                const at = ways[a.way]?.steps[a.step]?.firstAt ?? null;
                return (
                  <span key={a.way} className="wayfork__at">
                    Way {a.letter}
                    {at === null ? (
                      <span className="wayfork__noopen">no moment to open</span>
                    ) : (
                      <button
                        type="button"
                        className="btn ghost wayfork__open"
                        onClick={() => onOpen(at.sessionId, at.atSec)}
                      >
                        Open
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
            {s.after.length > 0 && <ForkBand runs={s.after} />}
          </li>
        ))}
      </ol>
      <p className="wayfork__verdict">
        {fork.verdict.kind === "named" ? fork.verdict.text : fork.verdict.reason}
      </p>
    </div>
  );
}

/**
 * One gap, one line per way. Every way appears, empty run included.
 *
 * `ForkBand`, not `Band`: this file already has a `Band` for the list's own
 * sections. A class name is a repo-wide identifier in `styles.css` and a
 * component name is a file-wide one here.
 */
function ForkBand({ runs }: { runs: readonly ForkRunView[] }): React.JSX.Element {
  return (
    <div className="wayfork__band">
      {runs.map((r) => (
        <p key={r.way} className="wayfork__run">
          Way {r.letter}: {r.phrase}
        </p>
      ))}
    </div>
  );
}

/**
 * THE RECORD: one masthead, one strip, one spine, three qualifiers.
 *
 * This section is a SECOND RENDERER of facts main already rendered into
 * `HABIT.md` — the shape `WayForkView` established, safe only because neither
 * parses the other's output and both read one projection. `Copy HABIT.md` and
 * `get_habit` still hand out `habit.markdown` byte for byte; nothing here
 * reaches it.
 *
 * IT DRAWS THE SEQUENCE EXACTLY ONCE. It used to draw it twice — a step list
 * numbered by `step.index + 1`, then a `Where the time goes` block numbered by
 * its own position — and those two could disagree, because `habitTimings` drops
 * steps carrying no duration and one dropped step shifted every number below it.
 * The spine merges them and joins on `HabitStepTimingDTO.stepIndex`, so the
 * question "how long did step 3 take" is answered on step 3's own row.
 *
 * EVERY BLOCK STATES ITS ABSENCE, the `StageSpec.skipReason` rule: a section
 * that merely never appeared would be indistinguishable from one nobody
 * implemented.
 */
function HabitRecordSection({
  habit,
  onOpen,
}: {
  habit: HabitDTO;
  onOpen: (sessionId: string, atSec: number) => void;
}): React.JSX.Element {
  const tones = appTones(habit.apps);
  // The BASELINE Way is the one the timings are measured on, so the strip and
  // the spine must read the same one or a lane would be segmented by steps the
  // spine never lists. Falling back to the first Way keeps a single-Way habit
  // (which has no baseline letter until it has two recordings) drawable.
  const baseWay =
    habit.ways.find((w) => w.letter === habit.timings?.wayLetter) ?? habit.ways[0] ?? null;

  const strip =
    baseWay === null
      ? null
      : stripLanes(
          baseWay,
          habit.timings,
          habit.binding.walks.map((w) => ({
            sessionId: w.sessionId,
            at: w.at,
            atSec: w.walk?.atSec ?? null,
          })),
          tones,
          habit.binding.recordings,
        );

  const spine: SpineView | null =
    baseWay === null || habit.fork !== null ? null : spineRows(baseWay, habit.timings, tones);

  return (
    <>
      <RecordLede habit={habit} tones={tones} baseWay={baseWay} />
      <HabitStrip strip={strip} reason={stripReason(habit)} onOpen={onOpen} />
      {/* ONE of these, never both: the fork instrument already draws the shared
          steps, and drawing the spine beside it would put the sequence on the
          page twice — the defect this whole section exists to undo. */}
      {spine !== null && (
        <HabitSpine view={spine} recordings={habit.binding.recordings} onOpen={onOpen} />
      )}
      {habit.fork !== null && (
        <WayForkView ways={habit.ways} fork={habit.fork} onOpen={onOpen} />
      )}
      <HabitRecord habit={habit} />
    </>
  );
}

/**
 * Why there is no strip, in words.
 *
 * Composed here rather than inside the projection because it is a sentence for
 * a reader, and `habit-record-view.ts` computes geometry. Every branch names a
 * CONDITION the reader can act on, never "no data".
 */
function stripReason(habit: HabitDTO): string {
  if (habit.ways.length === 0) {
    return "This habit has no live route, so there is nothing to draw. Its binding is described below.";
  }
  if (habit.binding.recordings < 2) {
    return "Only one recording is timed, so there is no second run to compare it against. Record this work again and its shape appears here.";
  }
  if (habit.timings === null) {
    return "These recordings took paths too different to share a baseline, so there is no common shape to draw. The steps below are still each recording's own.";
  }
  return "No step carries a recorded span, so there is nothing to place on an axis.";
}

/**
 * The glance: how many recordings, how many steps, how long, and where.
 *
 * FOUR FACTS AND A CHAIN, above everything. The section used to open on a step
 * list, so "what is this habit, roughly" could only be answered by reading all
 * of it. The app chain doubles as the strip's legend key — the swatches are the
 * same tone slots, learned before the strip is reached.
 */
function RecordLede({
  habit,
  tones,
  baseWay,
}: {
  habit: HabitDTO;
  tones: Map<string, number>;
  baseWay: HabitWayDTO | null;
}): React.JSX.Element {
  const recordings = habit.binding.recordings;
  const steps = baseWay?.steps.length ?? 0;
  // Across EVERY Way, because the range is about the work and not about one
  // path through it. A range, never a mean: both ends are spans a recording
  // actually produced.
  const span = rangeText(habit.ways.flatMap((w) => w.totalsMs));

  return (
    <div className="hlede">
      <p className="hlede__facts">
        {recordings === 1 ? "1 recording" : `${recordings} recordings`}
        {steps > 0 && <> · {steps === 1 ? "1 step" : `${steps} steps`}</>}
        {span !== null && <> · {span}</>}
      </p>
      {habit.apps.length > 0 && (
        <p className="hlede__chain">
          {habit.apps.map((app, i) => (
            <React.Fragment key={app}>
              {i > 0 && <span className="hlede__arrow" aria-hidden="true">→</span>}
              <span className="hlede__app" data-tone={`app-${tones.get(app) ?? 0}`}>
                <span className="hlede__swatch" aria-hidden="true" />
                {app}
              </span>
            </React.Fragment>
          ))}
        </p>
      )}
    </div>
  );
}

/**
 * The shape of each run: one lane per recording, on ONE shared domain.
 *
 * The lanes are what the `Evidence` block's bare wall-clock chips used to be —
 * the same recordings, openable the same way, with the shape of the run
 * attached. A shared domain is the whole reason a stack of lanes is a reading:
 * rescaling each to its own extent draws a fast run and a slow one identically,
 * which is the ledger's rule one level up.
 *
 * A LANE'S EXTENT IS WHAT IT DREW — its step spans plus the idle between them —
 * never the whole-walk duration, which would leave segments stopping short of a
 * stated end and assert an unmeasured remainder.
 */
function HabitStrip({
  strip,
  reason,
  onOpen,
}: {
  strip: StripView | null;
  reason: string;
  onOpen: (sessionId: string, atSec: number) => void;
}): React.JSX.Element {
  if (strip === null) {
    return (
      <section className="hstrip hstrip--empty">
        <span className="eyebrow">How the runs went</span>
        <p className="hrecord__note">{reason}</p>
      </section>
    );
  }
  return (
    <section className="hstrip">
      <span className="eyebrow">How the runs went</span>
      <ol className="hstrip__lanes">
        {strip.lanes.map((lane) => {
          const atSec = lane.atSec;
          return (
            <li key={lane.sessionId} className="hstrip__lane">
              <span className="hstrip__when mono">
                {lane.at === null ? "unknown" : wallClock(lane.at)}
              </span>
              <span className="hstrip__track">
                {lane.segments.map((seg, i) => (
                  <span
                    key={i}
                    className={`hstrip__seg hstrip__seg--${seg.kind}`}
                    data-tone={seg.toneSlot === null ? "neutral" : `app-${seg.toneSlot}`}
                    style={{ left: `${seg.leftPct}%`, width: `${seg.widthPct}%` }}
                    title={seg.kind === "idle" ? `${seg.text} idle` : `${seg.place} — ${seg.text}`}
                  />
                ))}
              </span>
              <span className="hstrip__total mono">{lane.totalText}</span>
              {/* Said in words, never a greyed control with no reason. */}
              {atSec === null ? (
                <span className="habitsteps__noopen">no moment to open</span>
              ) : (
                <button
                  type="button"
                  className="btn ghost hstrip__open"
                  onClick={() => onOpen(lane.sessionId, atSec)}
                >
                  Open
                </button>
              )}
            </li>
          );
        })}
      </ol>
      <div className="hstrip__legend">
        {strip.legend.map((l) => (
          <span key={l.app} className="hstrip__key" data-tone={`app-${l.toneSlot}`}>
            <span className="hstrip__swatch" aria-hidden="true" />
            {l.app}
          </span>
        ))}
        <span className="hstrip__key hstrip__key--idle">
          <span className="hstrip__swatch" aria-hidden="true" />
          idle
        </span>
      </div>
      {/* Counted, never dropped: a reader comparing three marks on the ledger
          against two lanes here is owed the reason. */}
      {strip.elsewhere > 0 && (
        <p className="hrecord__note">
          {strip.elsewhere === 1
            ? "1 more recording took another way"
            : `${strip.elsewhere} more recordings took another way`}
          , so it is not drawn on this axis. The ways are below.
        </p>
      )}
    </section>
  );
}

/**
 * The steps, their cost and their agreement — one row each.
 *
 * A PLACE IS PRINTED ONCE. A route of N steps passes through N+1 places, but
 * `from → to` on every row prints 2N of them: step *i*'s `to` is step *i+1*'s
 * `from`, so consecutive rows read as near-duplicate strings and the eye cannot
 * find where the work actually moves. Each row is therefore the place the step
 * ARRIVES in, with the origin drawn once above. Where the chain genuinely
 * breaks — a `missing` step — the row falls back to `from → to` and says so.
 *
 * Ledger marks have been able to open a recording since `c205413`; the steps —
 * the part a person is actually asked to trust — could not, so the record was
 * trusted rather than verifiable. A step with no moment is DRAWN and states its
 * reason, the `StageSpec.skipReason` rule.
 */
function HabitSpine({
  view,
  recordings,
  onOpen,
}: {
  view: SpineView;
  recordings: number;
  onOpen: (sessionId: string, atSec: number) => void;
}): React.JSX.Element | null {
  if (view.rows.length === 0) return null;
  // THE BAR COLUMN IS RESERVED ONLY WHERE THERE ARE BARS. A habit recorded once
  // has no timings at all, and the column still held a third of the pane —
  // measured in the running app: every step's place and its Open button crammed
  // left of an empty 34%. An empty reserved column reads as a thing that failed
  // to load.
  const timed = view.rows.some((r) => r.runs.length > 0);
  return (
    <section className="hspine" data-bars={timed ? "yes" : "no"}>
      <span className="eyebrow">What happens, in order</span>
      {view.origin !== null && (
        <p className="hspine__origin">
          <span className="hspine__node hspine__node--origin" aria-hidden="true" />
          <span className="hspine__place">{view.origin}</span>
          {/* Beside the name it qualifies, not in the bar column three hundred
              pixels away — measured on screen, where it read as a stray label. */}
          <span className="hspine__originnote">where it starts</span>
        </p>
      )}
      <ol className="hspine__list">
        {view.rows.map((row) => (
          <SpineStep
            key={`${row.n}-${row.edgeId}`}
            row={row}
            recordings={recordings}
            onOpen={onOpen}
          />
        ))}
      </ol>
    </section>
  );
}

function SpineStep({
  row,
  recordings,
  onOpen,
}: {
  row: SpineRow;
  recordings: number;
  onOpen: (sessionId: string, atSec: number) => void;
}): React.JSX.Element {
  const at = row.firstAt;
  return (
    <li className="hspine__step">
      <span className="hspine__n mono">{row.n}</span>
      <span
        className="hspine__node"
        data-tone={row.toneSlot === null ? "neutral" : `app-${row.toneSlot}`}
        aria-hidden="true"
      />
      <div className="hspine__body">
        <div className="hspine__head">
          <span className="hspine__place">
            {row.missing
              ? `edge ${row.edgeId} is not in the graph (index defect)`
              : row.brokenFrom === null
                ? row.place
                : `${row.brokenFrom} → ${row.place}`}
          </span>
          {at === null ? (
            <span className="habitsteps__noopen">
              No recording carries this step, so there is no moment to open
            </span>
          ) : (
            <button
              type="button"
              className="btn ghost hspine__open"
              onClick={() => onOpen(at.sessionId, at.atSec)}
            >
              Open this moment
            </button>
          )}
        </div>
        {/* SUMMARIZED BY KIND, with every line one disclosure away. A step can
            carry fourteen action lines, and fourteen lines of monospace says
            nothing at a glance about whether this is the expensive step. */}
        {row.summary === "" ? (
          <p className="hspine__actions muted">(no actions recorded on this edge)</p>
        ) : (
          <details className="hspine__detail">
            <summary>{row.summary}</summary>
            <ul className="hspine__verbatim mono">
              {row.actions.map((a, i) => (
                <li key={i}>
                  {a.action}
                  {a.target === "—" || a.target === "" ? "" : ` — ${a.target}`}
                </li>
              ))}
            </ul>
          </details>
        )}
        {/* The pause AFTER the step, never folded into its cost: a step's
            duration is its own extent, and the hesitation before the next move
            belongs to neither neighbour. */}
        {row.idleText !== null && <p className="hspine__idle">then {row.idleText} idle</p>}
        {/* THE COUNT IS THE EDGE'S OWN, and it can EXCEED the route's.
            `observations` counts every recording that walked this edge anywhere
            in the graph, so a route recorded once can hold a step walked by
            four — measured in the running app, a 1-recording habit whose step 2
            read `walked by all 4 recordings`. "All" asserted the two numbers
            were the same when they were not; the bare count says what was
            observed and claims nothing further. */}
        <p className="hspine__count">
          {row.everyRecording
            ? row.observations === 1
              ? "walked once"
              : `walked by ${row.observations} recordings`
            : `walked by ${row.observations} of the route's ${recordings} recordings`}
        </p>
      </div>
      <span className="hspine__bars">
        {row.runs.map((run, i) => (
          <span key={i} className="hspine__barrow">
            {/* The bar is the reading and the number is the fact — the portrait
                band's rule. A bar carries no printed number ON it. */}
            <span className="hspine__bar">
              <span className="hspine__fill" style={{ width: `${run.share * 100}%` }} />
            </span>
            <span className="hspine__ms mono">{run.text}</span>
          </span>
        ))}
      </span>
    </li>
  );
}

/**
 * The three qualifiers, under the instruments that answer first.
 *
 * `Where the time goes` is GONE from here: it is the spine's bar column now,
 * on the same row as the step it times. What remains is what the sequence
 * cannot say for itself — what changes between runs, what the evidence does not
 * cover, and where it came from.
 *
 * The recordings themselves are the strip's lanes, so this block no longer
 * lists them: the same wall clocks, openable the same way, with the shape of
 * each run attached instead of standing alone as chips.
 */
function HabitRecord({ habit }: { habit: HabitDTO }): React.JSX.Element {
  const lifting = liftingRollup(habit.ways);
  const span = walkSpan(habit.binding.walks);
  const dropped = droppedEarlyLine(habit);

  return (
    <div className="hrecord">
      <section className="hrecord__block">
        <span className="eyebrow">What changes each time</span>
        {habit.slots.length === 0 ? (
          <p className="hrecord__note">
            Nothing was typed on this route, so it has no recorded inputs.
          </p>
        ) : (
          <>
            <ul className="hrecord__slots">
              {habit.slots.map((slot) => (
                <li key={slot.name} className="hrecord__slot">
                  <code className="hrecord__slotname">{slot.name}</code>
                  {/* The words are composed in MAIN by the record's own
                      `slotNote`, so the file and this cannot disagree. */}
                  <span className="hrecord__slotnote">{slot.note}</span>
                </li>
              ))}
            </ul>
            {/* The values are NOT here and cannot be: a DTO has no per-habit
                toggle, so it carries no values at all. Said rather than left
                to be noticed as an absence. */}
            <p className="hrecord__note">
              {habit.showSamples
                ? "The recorded values are printed in the file, not here."
                : "The recorded values are not printed. Turn on “Show recorded values” below if you need them in the file."}
            </p>
          </>
        )}
      </section>

      <section className="hrecord__block">
        <span className="eyebrow">What this can&rsquo;t tell you</span>
        {habit.cautions.length === 0 && lifting === null && dropped === null ? (
          <p className="hrecord__note">Nothing qualifies this evidence.</p>
        ) : (
          <>
            <ul className="hrecord__cautions">
              {habit.cautions.map((c) => (
                <li key={c}>{c}</li>
              ))}
              {dropped !== null && <li>{dropped}</li>}
            </ul>
            {/* ROLLED UP, never dropped. Fifty-six of these buried the five
                bullets above on the real store; they are still every one of
                them, one disclosure away, and still every one of them in the
                file. A `<details>` because the browser already owns this
                behaviour and a hand-rolled toggle would owe it a label, a
                keyboard path and an expanded state. */}
            {lifting !== null && (
              <details className="hrecord__lifting">
                <summary>{lifting.summary}</summary>
                <ul className="hrecord__cautions mono">
                  {lifting.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>

      <section className="hrecord__block">
        <span className="eyebrow">Where this came from</span>
        <p className="hrecord__note">
          {evidenceLine(habit)}
          {span !== null && ` · ${span}`} · on this machine
        </p>
        <p className="hrecord__note mono">{habit.binding.routeLabel}</p>
      </section>
    </div>
  );
}

/**
 * The answer to the question the `<h1>` has always asked.
 *
 * "What you do repeatedly" has headed a file list since Habits shipped. This
 * says where that repeated work actually happens, and how much of what you
 * record recurs at all — `post.md`'s second lesson, made glanceable.
 *
 * A BAR CARRIES NO PRINTED NUMBER. The bar length is the reading and
 * `placeLabel` is the fact, exactly as a ledger mark is a position and
 * `markLabel` is the sentence — so a pointer and a screen reader are told the
 * same thing. A count in the gutter would be the `×N` glyph again, which was
 * deleted for being the one of three statements that could only be read as a
 * number.
 *
 * ONE HUE at varying lightness, never the indexed palette: C1 owns `--data-2`
 * and `--data-3` for conformance, and a violet app bar a few hundred pixels
 * above a violet "went another way" mark would assert a relationship that does
 * not exist.
 */
function Portrait({ data }: { data: HabitsDTO }): React.JSX.Element | null {
  const portrait = portraitOf(data);
  // Nothing recurs. The band draws nothing rather than an empty frame — this
  // is not an insufficiency state, because there is no reading being withheld.
  if (portrait.empty) return null;
  return (
    <section className="portrait" aria-label="Where your repeated work happens">
      <ul className="portrait__places">
        {portrait.places.map((place) => {
          const label = placeLabel(place);
          return (
            <li key={place.app} className="portrait__place" title={label} aria-label={label}>
              <span className="portrait__app">{place.app}</span>
              <span className="portrait__bar">
                <span
                  className="portrait__fill"
                  style={{
                    // A floor of 2%, so the lightest place is still a mark
                    // rather than nothing. It never reaches zero because a
                    // place with no recordings is not in `places` at all.
                    width: `${Math.max(place.share * 100, 2)}%`,
                    background: `color-mix(in oklab, var(--data-0) ${25 + Math.round(65 * place.share)}%, transparent)`,
                  }}
                />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="portrait__coverage mono">{portrait.coverage}</p>
    </section>
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
        {/* OUTSIDE `.habitedit__evidence`, which is capped at 420px so the
            ledger and its meta line do not stretch across the pane. The grid
            wants the whole width: 24 columns inside 400px gave 15px cells with
            no room for an hour axis, which is why it shipped without one. */}
        <Rhythm walks={b.walks} onOpen={onOpenRecording} />
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
        <span className="eyebrow">What the recording shows</span>
      </div>
      {/* The policy in a SENTENCE, not in the heading. A title should name the
          thing; "the recording, not editable" is a rule about it, and it stood
          where the name belonged. The drawn seam above already says it once in
          the layout — this says it in words for anyone who does not read a
          hairline as a boundary. */}
      <p className="muted habitedit__recordnote">
        Generated from the recordings. Not written by a model, and not editable here.
      </p>
      <HabitRecordSection habit={habit} onOpen={onOpenRecording} />

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
