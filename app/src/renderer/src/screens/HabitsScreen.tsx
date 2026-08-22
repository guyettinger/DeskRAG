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

import React, { useEffect, useMemo, useState } from "react";
import type { HabitDTO, HabitPatch, HabitProposalDTO, HabitsDTO } from "@shared/types";
import { api } from "../api.js";
import { GhostLottie } from "../brand/GhostLottie.js";
import {
  bandHabits,
  bindingChip,
  evidenceLine,
  generateDisabledReason,
  orderProposals,
  proposalCount,
  proposalEvidence,
  proposalTitle,
} from "../habits-view.js";

type Selection = { kind: "habit"; id: string } | { kind: "proposal"; routeKey: string };

function Head({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="page__head habits__head">
      <div className="habits__headtext">
        <span className="eyebrow">Habits</span>
        <h1>What you have done, as instructions</h1>
        <p>
          A habit is one of your recorded flows written as a HABIT.md an agent can load. The
          prose is DeskRAG&rsquo;s or yours; the steps below it are the recording.
        </p>
      </div>
      {children}
    </div>
  );
}

export function HabitsScreen(): React.JSX.Element {
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

  const bands = bandHabits(data.habits);
  const proposals = orderProposals(data.proposals);
  const nothing = data.habits.length === 0 && proposals.length === 0;

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
      <Head>
        <div className="habits__bar">
          <span className="chip mono">
            {data.habits.filter((s) => s.state !== "dismissed").length} kept
          </span>
          <span className="chip mono">{proposals.length} proposed</span>
          <span className="muted">
            {data.prose.available ? `prose: ${data.prose.model}` : "prose: template only"}
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
                  active={habit?.id === s.id}
                  onSelect={() => setSelected({ kind: "habit", id: s.id })}
                />
              ))}
            </Band>
          )}

          {bands.mine.length > 0 && (
            <Band title="Mine">
              {bands.mine.map((s) => (
                <HabitRow
                  key={s.id}
                  habit={s}
                  active={habit?.id === s.id}
                  onSelect={() => setSelected({ kind: "habit", id: s.id })}
                />
              ))}
            </Band>
          )}

          {proposals.length > 0 && (
            <Band title="Proposed">
              {proposals.map((p) => (
                <ProposalRow
                  key={p.routeKey}
                  proposal={p}
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
  active,
  onSelect,
}: {
  habit: HabitDTO;
  active: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const chip = bindingChip(habit);
  return (
    <li>
      <button className={`habit${active ? " is-active" : ""}`} onClick={onSelect}>
        <span className="habit__title">{habit.title}</span>
        <span className="habit__slug mono">{habit.slug}</span>
        <span className="habit__meta">
          <span className="mono">{evidenceLine(habit)}</span>
          <span className="habit__tag mono">{habit.bodySource}</span>
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
  active,
  onSelect,
}: {
  proposal: HabitProposalDTO;
  active: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const count = proposalCount(proposal);
  return (
    <li>
      <button
        className={`habit${active ? " is-active" : ""}`}
        onClick={onSelect}
        title={proposalTitle(proposal)}
      >
        <span className={`habit__count${count.repeated ? " is-repeated" : ""}`}>{count.text}</span>
        <span className="habit__title">{proposal.name ?? proposal.label}</span>
        {proposal.name !== null && <span className="habit__slug mono">{proposal.label}</span>}
        <span className="habit__meta mono">
          {proposal.stepSummary}
          {proposal.variants > 0 && " · merged"}
          {/* Recurrence in WORDS, at every count. `×N` alone is a bare number,
              and it used to be explained only when it was 1 — so the evidence
              was legible exactly where it was weakest. */}
          {` · ${proposalEvidence(proposal)}`}
        </span>
      </button>
    </li>
  );
}

function ProposalPreview({
  proposal,
  busy,
  onAccept,
  onDismiss,
}: {
  proposal: HabitProposalDTO;
  busy: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div className="habitedit__body">
      <h2>{proposal.name ?? proposal.label}</h2>
      {proposal.count === 1 && (
        <p className="banner">
          Recorded once. Kept from a single observation, and nothing has confirmed it repeats — keeping it
          is reasonable, but an agent should not read it as how the task is done.
        </p>
      )}
      <p className="muted">
        This is the record it would produce. The prose above it is written when you keep it.
      </p>
      <pre className="habitedit__record mono">{proposal.preview}</pre>
      <div className="habitedit__actions">
        <button className="btn" disabled={busy} onClick={onAccept}>
          Keep as a habit
        </button>
        <button className="btn" disabled={busy} onClick={onDismiss}>
          Not a habit
        </button>
      </div>
    </div>
  );
}

function HabitEditor({
  habit,
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
  const cut = habit.markdown.lastIndexOf("## Recorded steps");
  const record = cut < 0 ? habit.markdown : habit.markdown.slice(cut);

  return (
    <div className="habitedit__body">
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

      {/* The frontmatter is not on screen — the well below starts at the record —
          so the version this file carries is stated here or nowhere. */}
      <p className="muted mono">
        v{habit.version}
        {habit.history.length > 0 &&
          ` · ${habit.history[habit.history.length - 1]!.what}, ${new Date(
            habit.history[habit.history.length - 1]!.at,
          ).toLocaleDateString()}`}
      </p>

      <div className="habitedit__actions">
        {confirmRegen ? (
          <div className="confirm">
            <p>This replaces the prose you wrote. The recorded steps are unaffected.</p>
            <button className="btn danger" disabled={busy} onClick={onGenerate}>
              Replace it
            </button>
            <button className="btn" onClick={onCancelRegen}>
              Keep mine
            </button>
          </div>
        ) : (
          <button
            className="btn"
            disabled={busy}
            onClick={habit.edited ? onAskRegen : onGenerate}
            title={proseNote ?? undefined}
          >
            {busy ? "Writing…" : "Generate with model"}
          </button>
        )}
        <button className="btn" onClick={onCopy}>
          {copied ? "Copied" : "Copy HABIT.md"}
        </button>
        <button className="btn" disabled={busy} onClick={() => onPatch({ pinned: !habit.pinned })}>
          {habit.pinned ? "Unpin" : "Pin"}
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => onPatch({ state: habit.state === "archived" ? "active" : "archived" })}
        >
          {habit.state === "archived" ? "Restore" : "Archive"}
        </button>
        <button className="btn danger" disabled={busy} onClick={onRemove}>
          Forget
        </button>
      </div>

      {/* The record LAST, because it is the tallest thing here and the actions
          must not sit below it — Copy HABIT.md was entirely off-screen at
          1180x800, which only the screenshot showed. */}
      <div className="habitedit__recordhead">
        <span className="eyebrow">The record — generated, and not editable</span>
      </div>
      <pre className="habitedit__record mono">{record}</pre>

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
