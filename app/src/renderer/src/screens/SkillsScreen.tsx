/**
 * Skills — recorded routes kept as SKILL.md files an agent can load.
 *
 * THIS SCREEN WRITES, and it is the only one that writes the user's own text.
 * Everything else in the app either captures, derives, or reads; a skill's
 * title, description and prose exist because someone typed them, which is why
 * the table is AUTHORED and why no re-index may touch it.
 *
 * Two panes, one selection, the Flows precedent. The list bands by what needs
 * answering; the editor shows one skill's prose above a read-only well holding
 * the record, because the file's two halves are written by different things and
 * the screen should not pretend otherwise.
 *
 * The markdown is rendered in MAIN and handed here verbatim. The Copy button
 * copies `skill.markdown` — the same string `get_skill` returns — so the two can
 * never drift.
 */

import React, { useEffect, useMemo, useState } from "react";
import type { SkillDTO, SkillPatch, SkillProposalDTO, SkillsDTO } from "@shared/types";
import { api } from "../api.js";
import { GhostLottie } from "../brand/GhostLottie.js";
import {
  bandSkills,
  bindingChip,
  evidenceLine,
  generateDisabledReason,
  orderProposals,
  proposalCount,
} from "../skills-view.js";

type Selection = { kind: "skill"; id: string } | { kind: "proposal"; routeKey: string };

function Head({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="page__head skills__head">
      <div className="skills__headtext">
        <span className="eyebrow">Skills</span>
        <h1>What you have done, as instructions</h1>
        <p>
          A skill is one of your recorded flows written as a SKILL.md an agent can load. The
          prose is DeskRAG&rsquo;s or yours; the steps below it are the recording.
        </p>
      </div>
      {children}
    </div>
  );
}

export function SkillsScreen(): React.JSX.Element {
  const [data, setData] = useState<SkillsDTO | undefined>(undefined);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState<string | null>(null);

  useEffect(() => {
    void api.skills.list().then(setData);
  }, []);

  const run = (p: Promise<SkillsDTO>): void => {
    setBusy(true);
    void p
      .then(setData)
      .finally(() => setBusy(false));
  };

  const skill = useMemo(
    () =>
      selected?.kind === "skill" ? data?.skills.find((s) => s.id === selected.id) : undefined,
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

  const bands = bandSkills(data.skills);
  const proposals = orderProposals(data.proposals);
  const nothing = data.skills.length === 0 && proposals.length === 0;

  // THREE distinct emptinesses, never one. No graph at all, a graph carrying no
  // provenance (zero routes, and the remedy is a rebuild), and a graph with
  // routes nobody has answered about yet.
  if (nothing) {
    return (
      <div className="page skills">
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
              No recorded routes to build a skill from. A route is a path a recording actually
              walked, so this is empty when the graph carries no provenance — press{" "}
              <b>Rebuild trace graph</b> in Settings &rarr; Maintenance and try again.
            </p>
          )}
        </div>
      </div>
    );
  }

  const patch = (id: string, p: SkillPatch): void => run(api.skills.update(id, p));

  return (
    <div className="page skills">
      <Head>
        <div className="skills__bar">
          <span className="chip mono">
            {data.skills.filter((s) => s.state !== "dismissed").length} kept
          </span>
          <span className="chip mono">{proposals.length} proposed</span>
          <span className="muted">
            {data.prose.available ? `prose: ${data.prose.model}` : "prose: template only"}
          </span>
        </div>
      </Head>

      <div className="skills__stage">
        <aside className="skills__list">
          {bands.attention.length > 0 && (
            <Band title="Needs attention">
              {bands.attention.map((s) => (
                <SkillRow
                  key={s.id}
                  skill={s}
                  active={skill?.id === s.id}
                  onSelect={() => setSelected({ kind: "skill", id: s.id })}
                />
              ))}
            </Band>
          )}

          {bands.mine.length > 0 && (
            <Band title="Mine">
              {bands.mine.map((s) => (
                <SkillRow
                  key={s.id}
                  skill={s}
                  active={skill?.id === s.id}
                  onSelect={() => setSelected({ kind: "skill", id: s.id })}
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
                <SkillRow
                  key={s.id}
                  skill={s}
                  active={skill?.id === s.id}
                  onSelect={() => setSelected({ kind: "skill", id: s.id })}
                />
              ))}
            </Band>
          )}
        </aside>

        <section className="skilledit">
          {skill !== undefined ? (
            <SkillEditor
              skill={skill}
              busy={busy}
              copied={copied}
              proseNote={generateDisabledReason(data.prose)}
              confirmRegen={confirmRegen === skill.id}
              onAskRegen={() => setConfirmRegen(skill.edited ? skill.id : null)}
              onCancelRegen={() => setConfirmRegen(null)}
              onGenerate={() => {
                setConfirmRegen(null);
                run(api.skills.generate(skill.id));
              }}
              onPatch={(p) => patch(skill.id, p)}
              onCopy={() => {
                void navigator.clipboard.writeText(skill.markdown).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                });
              }}
              onRebind={(routeKey) => run(api.skills.rebind(skill.id, routeKey))}
              onRemove={() => {
                setSelected(null);
                run(api.skills.remove(skill.id));
              }}
            />
          ) : proposal !== undefined ? (
            <ProposalPreview
              proposal={proposal}
              busy={busy}
              onAccept={() => {
                setSelected(null);
                run(api.skills.accept(proposal.routeKey));
              }}
              onDismiss={() => {
                setSelected(null);
                run(api.skills.dismiss(proposal.routeKey));
              }}
            />
          ) : (
            <div className="skilledit__blank muted">
              <p>Pick a skill to read or edit it, or a proposal to see what it would produce.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Band({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="skills__band">
      <div className="skills__bandhead">
        <span className="eyebrow">{title}</span>
      </div>
      <ul className="skills__items">{children}</ul>
    </div>
  );
}

function SkillRow({
  skill,
  active,
  onSelect,
}: {
  skill: SkillDTO;
  active: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const chip = bindingChip(skill);
  return (
    <li>
      <button className={`skill${active ? " is-active" : ""}`} onClick={onSelect}>
        <span className="skill__title">{skill.title}</span>
        <span className="skill__slug mono">{skill.slug}</span>
        <span className="skill__meta">
          <span className="mono">{evidenceLine(skill)}</span>
          <span className="skill__tag mono">{skill.bodySource}</span>
          {skill.edited && <span className="skill__tag mono">edited</span>}
          {skill.pinned && <span className="skill__tag mono">pinned</span>}
        </span>
        {chip !== null && <span className="skill__bind mono">{chip}</span>}
      </button>
    </li>
  );
}

function ProposalRow({
  proposal,
  active,
  onSelect,
}: {
  proposal: SkillProposalDTO;
  active: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const count = proposalCount(proposal);
  return (
    <li>
      <button className={`skill${active ? " is-active" : ""}`} onClick={onSelect}>
        <span className={`skill__count${count.repeated ? " is-repeated" : ""}`}>{count.text}</span>
        <span className="skill__title">{proposal.name ?? proposal.label}</span>
        {proposal.name !== null && <span className="skill__slug mono">{proposal.label}</span>}
        <span className="skill__meta mono">
          {proposal.steps} step{proposal.steps === 1 ? "" : "s"}
          {proposal.count === 1 && " · recorded once"}
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
  proposal: SkillProposalDTO;
  busy: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div className="skilledit__body">
      <h2>{proposal.name ?? proposal.label}</h2>
      {proposal.count === 1 && (
        <p className="banner">
          Recorded once. One walk is a single observation, not an established habit — keeping it
          is reasonable, but an agent should not read it as how the task is done.
        </p>
      )}
      <p className="muted">
        This is the record it would produce. The prose above it is written when you keep it.
      </p>
      <pre className="skilledit__record mono">{proposal.preview}</pre>
      <div className="skilledit__actions">
        <button className="btn" disabled={busy} onClick={onAccept}>
          Keep as a skill
        </button>
        <button className="btn" disabled={busy} onClick={onDismiss}>
          Not a skill
        </button>
      </div>
    </div>
  );
}

function SkillEditor({
  skill,
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
  onRemove,
}: {
  skill: SkillDTO;
  busy: boolean;
  copied: boolean;
  proseNote: string | null;
  confirmRegen: boolean;
  onAskRegen: () => void;
  onCancelRegen: () => void;
  onGenerate: () => void;
  onPatch: (p: SkillPatch) => void;
  onCopy: () => void;
  onRebind: (routeKey: string) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const b = skill.binding;
  // The record is not editable here, and the file says the same thing. Splitting
  // the document at the heading is how the screen shows which half is which.
  const cut = skill.markdown.lastIndexOf("## Recorded steps");
  const record = cut < 0 ? skill.markdown : skill.markdown.slice(cut);

  return (
    <div className="skilledit__body">
      {b.note !== null && (
        <div className="banner skilledit__bind">
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

      {skill.generateNote !== null && <p className="banner">{skill.generateNote}</p>}

      <label className="field">
        <span className="field__label">Title</span>
        <input
          className="field__text"
          value={skill.title}
          onChange={(e) => onPatch({ title: e.target.value })}
        />
      </label>

      <label className="field">
        <span className="field__label">
          Description — how an agent decides whether to load this at all
        </span>
        <textarea
          className="field__text"
          rows={2}
          value={skill.description}
          onChange={(e) => onPatch({ description: e.target.value })}
        />
      </label>

      <label className="field">
        <span className="field__label">Name (frontmatter)</span>
        <input
          className="field__text mono"
          value={skill.slug}
          onChange={(e) => onPatch({ slug: e.target.value })}
        />
      </label>

      <label className="field">
        <span className="field__label">
          Prose — yours or the model&rsquo;s. Everything below is generated from the recording
          and cannot be edited here.
        </span>
        <textarea
          className="field__text"
          rows={8}
          value={skill.body}
          onChange={(e) => onPatch({ body: e.target.value })}
        />
      </label>

      <pre className="skilledit__record mono">{record}</pre>

      <div className="skilledit__actions">
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
            onClick={skill.edited ? onAskRegen : onGenerate}
            title={proseNote ?? undefined}
          >
            {busy ? "Writing…" : "Generate with model"}
          </button>
        )}
        <button className="btn" onClick={onCopy}>
          {copied ? "Copied" : "Copy SKILL.md"}
        </button>
        <button className="btn" disabled={busy} onClick={() => onPatch({ pinned: !skill.pinned })}>
          {skill.pinned ? "Unpin" : "Pin"}
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => onPatch({ state: skill.state === "archived" ? "active" : "archived" })}
        >
          {skill.state === "archived" ? "Restore" : "Archive"}
        </button>
        <button className="btn danger" disabled={busy} onClick={onRemove}>
          Forget
        </button>
      </div>

      {/* The reason in WORDS, not a greyed control with no explanation. */}
      {proseNote !== null && <p className="muted">{proseNote}</p>}

      <label className="skilledit__toggle">
        <input
          type="checkbox"
          checked={skill.showSamples}
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
