/**
 * Knowledge — what your recordings say is TRUE of this desktop, as distinct from
 * what happened on it.
 *
 * Every other screen in this app is about moments: a recording, a path, a step.
 * This one is about values. It asks two questions a person actually has — what
 * does my desktop consist of, and what is DeskRAG willing to call current — and
 * most of the time the honest answer to the second is *nothing is*, because a
 * laptop docked some days and not others has two display setups and both are
 * true. THE REFUSAL IS AN ANSWER AND SITS IN THE ANSWER'S SLOT.
 *
 * READS AND NEVER ACTS, and there is nothing here to write: a fact is derived
 * from events already on disk, so the only way to change one is to record. It is
 * also not stored — the whole projection measured 4.63ms on the real library, so
 * it is recomputed on every visit rather than kept in a table.
 *
 * VALUES ARE ORDERED BY RECENT EVIDENCE AND THE CURRENT ONE IS MARKED. Ranking
 * by a raw lifetime count is the defect `docs/research/persistence-layers.md` §4
 * names in `edgeCost`, and it had the same consequence here: a keyboard layout
 * seen in three recordings sat above the one that had replaced it, while the
 * verdict directly above the list said the opposite. Each row carries the date
 * it was last seen, so the order can be checked rather than trusted.
 *
 * NOTHING TRUNCATES. The longest string on this screen is a docked display's
 * geometry, and it wraps rather than gaining an ellipsis — an ellipsis hides a
 * broken layout, which is the rail's rule applied to a column of prose. What a
 * long LIST does instead is fold: past `MAX_FACT_VALUES` the remainder is
 * counted in a caveat, never widened and never silently cut.
 */

import React, { useEffect, useState } from "react";
import type { KnowledgeDTO, KnowledgeFactDTO } from "@shared/types";
import { api } from "../api.js";
import { GhostLottie } from "../brand/GhostLottie.js";
import {
  attributionChip,
  attributionNote,
  caveatLines,
  corpusLines,
  evidenceLine,
} from "../knowledge-cards.js";

/**
 * The same head every other screen carries.
 *
 * Shared by the populated and the empty state rather than written twice: an
 * empty Knowledge still has to say what Knowledge IS, which is exactly when a
 * reader most needs telling. `FlowsHead` makes the same argument.
 */
function KnowledgeHead(): React.JSX.Element {
  return (
    <div className="page__head">
      <span className="eyebrow">Knowledge</span>
      <h1>What your recordings say is true</h1>
      <p>
        The environment every recording observed — the keyboard layout, the display setups, the
        applications, the windows worked in and the sites. Values that are really the same
        thing are folded together, and a fact only names a current value when its values
        cannot all be true at once.
      </p>
    </div>
  );
}

function FactCard({ fact }: { fact: KnowledgeFactDTO }): React.JSX.Element {
  const caveats = caveatLines(fact);
  return (
    <article className="kcard">
      <header className="kcard__head">
        <h2 className="kcard__title">{fact.title}</h2>
        {/* The chip is a WORD; the rule behind it is the title. A card that
            cannot say the exclusion does not apply to it cannot explain why the
            recorder did not cost it a display setup. */}
        <span className="chip" title={attributionNote(fact)}>
          <span className="dot" /> {attributionChip(fact)}
        </span>
      </header>

      {/* ONE SLOT, whether the fact answers or declines. Putting the refusal
          somewhere else would make declining look like an error state, and on
          this library four of the five facts decline. */}
      <p className={`kcard__verdict${fact.current === null ? " is-refused" : ""}`}>
        {fact.current === null ? fact.reason : fact.current}
      </p>
      {fact.current !== null && <p className="kcard__why">{fact.reason}</p>}

      {fact.values.length === 0 ? (
        <p className="kcard__why">Nothing has been observed for this fact yet.</p>
      ) : (
        <ul className="kcard__values">
          {/* KEYED ON THE VALUE'S IDENTITY, never on its label. A label is a
              rendering, and one that collapsed two distinct configurations
              shipped — two rows, one key, and React reconciling them as one. */}
          {fact.values.map((v) => (
            <li
              key={v.key}
              className={`kcard__value${v.isCurrent ? " is-current" : ""}`}
            >
              <span className="kcard__label">{v.label}</span>
              <span className="kcard__evidence mono">{evidenceLine(v)}</span>
            </li>
          ))}
        </ul>
      )}

      {caveats.map((line) => (
        <p key={line} className="kcard__caveat">
          {line}
        </p>
      ))}
    </article>
  );
}

export function KnowledgeScreen(): React.JSX.Element {
  const [dto, setDto] = useState<KnowledgeDTO | undefined>(undefined);

  useEffect(() => {
    void api.knowledge.facts().then(setDto);
  }, []);

  if (dto === undefined)
    return (
      <div className="page">
        <div className="loading">
          <div className="spinner" />
        </div>
      </div>
    );

  if (dto.recordings === 0)
    return (
      <div className="page knowledge">
        <KnowledgeHead />
        <div className="empty">
          <GhostLottie size={104} className="empty__ghost" playing />
          <h3>Nothing observed yet</h3>
          <p>
            These are derived from recordings rather than read from settings, so there is
            nothing to show until a session has been captured.
          </p>
        </div>
      </div>
    );

  return (
    <div className="page knowledge">
      <KnowledgeHead />
      <div className="knowledge__cards">
        {/* KEYED ON THE FACT'S ID: Applications and Windows are both read from
            `focus_change`, so the event kind no longer identifies a card. */}
        {dto.facts.map((fact) => (
          <FactCard key={fact.id} fact={fact} />
        ))}
      </div>
      {/* THE CORPUS, at the foot of the screen rather than in the head: it is
          what the answers above were read from, and a reader who finds their own
          application missing is entitled to that answer without opening
          Settings — `flows()` states the same reasoning for the same list. */}
      <footer className="knowledge__corpus">
        {corpusLines(dto).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </footer>
    </div>
  );
}
