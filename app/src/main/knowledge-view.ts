/**
 * The projection the Knowledge screen reads: recordings become environment
 * facts, folded to the values that are actually distinct and asked which of
 * them is current.
 *
 * Pure: no Electron, no store, no clock — which is what lets it live in the
 * root test suite rather than being eyeballed in the running app, exactly as
 * `graph-view.ts` does. `DeskRagService.knowledge()` does the I/O and nothing
 * else, mirroring `flows()`.
 *
 * ## Why here and not in `src/knowledge/`
 *
 * The inputs are app-shaped: `TraceEvent`s, a settings-held exclusion list, and
 * session start times. WHICH APPLICATIONS COUNT AS THE RECORDER IS THE APP'S
 * POLICY — `trace/` stays a leaf that has never heard of any particular
 * application, which is why `excludeFocusedApps` takes its predicate injected.
 * Pushing that policy down would run against the direction this repo holds.
 *
 * The objection that would have defeated this — that a pure module in `app/` is
 * unreachable from the root suite and the probes — does not hold: ten test files
 * and nine probes already import `app/src/main/`, `scripts/lib/flows.ts` reaching
 * `graph-view.js` among them. `npm run probe:identity` reads THIS file rather
 * than keeping its own copy of the gathering, because two readers of one rule is
 * the `ax-dump`/`ax-exec` drift hazard by name.
 *
 * ## Nothing is stored, and that is a measurement
 *
 * The whole pipeline below — every event of every recording read, parsed,
 * excluded, folded, resolved — measured **4.63ms** on the real library (12
 * recordings, 5079 events) on 2026-09-06, of which 3.77ms was reading and
 * parsing rows rather than folding them. The fold alone against a synthetic
 * hundredfold corpus: 9200 observations -> 7 values in 34.13ms. Computed per
 * query survives a consumer, so the Knowledge layer still has no table and no
 * `schema.ts` bucket. See docs/internals/persistence.md.
 *
 * THAT BENCHMARK HELD VALUE CARDINALITY CONSTANT — 9200 observations folding to
 * the same 7 values — so it measured the fold's TIME and not the output's SIZE.
 * What grows with a library is values: one further recording took `visited_page`
 * from 17 to 21. The fold stays linear; the surface that fails first is the
 * rendering, which is what `MAX_FACT_VALUES` answers and why a
 * cardinality-scaled re-run of that benchmark is still open.
 *
 * ## A FACT IS ADDRESSED BY ITS `id`, NOT BY THE EVENT IT READS
 *
 * Two declarations now read `focus_change` — `FOCUSED_APP` answers *which
 * applications* and `FOCUSED_WINDOW` answers *which windows* — so the event kind
 * cannot identify a fact. `kind` stays on the DTO as disclosure (which recorded
 * event this was read FROM); `id` is what a card keys on and what `get_fact`
 * takes.
 *
 * ## It is not a score
 *
 * Every number that leaves here is a count or a moment. A value's evidence is
 * `stabilityOf`'s tier — a WORD and a count of recordings — which may be printed
 * where `FrameResult.score` may not. The recency weight that ORDERS the values
 * is a fraction and therefore never leaves this module; what leaves is the rank
 * it produced and the `lastObservedAt` that explains it.
 */

import type {
  KnowledgeDTO,
  KnowledgeFactDTO,
  KnowledgeFactDetailDTO,
  KnowledgeValueDTO,
  KnowledgeValueDetailDTO,
} from "@shared/types";
import {
  currentValue,
  excludeFocusedApps,
  foldByIdentity,
  lastObservedAt,
  stabilityOf,
  stableKey,
  DISPLAY_TOPOLOGY,
  FOCUSED_APP,
  FOCUSED_WINDOW,
  KEYBOARD_LAYOUT,
  VISITED_PAGE,
} from "deskrag";
import type {
  Attribution,
  DisplayGeometry,
  DisplayTopologyPayload,
  ExcludedFocus,
  FocusPayload,
  IdentityDeclaration,
  KeymapPayload,
  KnowledgeSource,
  Observation,
  SessionStartedAt,
  TraceEvent,
  WindowIdentity,
  WindowPayload,
} from "deskrag";
import { DEFAULT_HALF_LIFE_MS, type RecencyOptions } from "./walk-analysis.js";

/**
 * How many values a fact lists before the rest are folded into a count.
 *
 * `MAX_SHARE_SEGMENTS`'s precedent (`index-graph-view.ts`), and pulled in by
 * `FOCUSED_WINDOW`: the largest fact on the real library held 21 values and the
 * window fact lands at 29, on a card and in an MCP reply that both render every
 * value inline. A sliver is FOLDED AND COUNTED, never widened and never
 * silently dropped — `KnowledgeFactDTO.unlisted` is what the count is for.
 *
 * IT APPLIES TO THE COUNTED FORM ONLY, in `summarize`. `get_fact` returns the
 * detailed form uncapped, because checking a fold against a truncated list is
 * not checking it.
 *
 * UNSWEPT, and the same disclosure `RANKING_MIN_HABITS = 5` carries. Twelve is
 * enough to show a fact's shape without becoming the screen.
 */
export const MAX_FACT_VALUES = 12;

/**
 * One recording's events, in both the forms a fact can read.
 *
 * BOTH, because the recorder exclusion is scoped by fact TYPE and not applied
 * once at the top. `sessionStream` builds the pair with a single
 * `excludeFocusedApps` call, reused by every focused-app declaration rather than
 * recomputed per fact — `flows()` carries the same note about not scanning the
 * session list once per source.
 */
export interface SessionStream {
  sessionId: string;
  /** Every event, in `t_mono` order. What an AMBIENT fact reads. */
  all: readonly TraceEvent[];
  /** What survived the recorder exclusion. What a FOCUSED-APP fact reads. */
  kept: readonly TraceEvent[];
  /** Events dropped as the recorder's own. Disclosure, not bookkeeping. */
  dropped: number;
  /** No `focus_change` anywhere, so the exclusion was a true no-op. */
  unattributable: boolean;
}

/** One recording, as this projection needs it. */
export interface KnowledgeSession {
  sessionId: string;
  /** Wall clock. Joined at query time, because `tMono` restarts every session. */
  startedAt: number;
  events: readonly TraceEvent[];
}

export interface KnowledgeInput {
  sessions: readonly KnowledgeSession[];
  /** What counts as the recorder. Injected, as everywhere else in this repo. */
  isExcluded: (focus: ExcludedFocus) => boolean;
  /** The list as it stands NOW, for the footer's disclosure. */
  excludedApps: readonly string[];
  /**
   * The moment to measure staleness against, and the ONE thing here that is not
   * derivable from the recordings.
   *
   * REQUIRED AND INJECTED, exactly as `RecencyOptions.now` is: a rule that calls
   * `Date.now()` internally cannot be tested against a fixture, and the single
   * wall-clock read belongs at the consumer boundary — `DeskRagService`, which
   * is `walkAnalysis`'s own arrangement.
   */
  recency: RecencyOptions;
}

/** One recording's events, split once for every fact that will read them. */
export function sessionStream(
  session: KnowledgeSession,
  isExcluded: (focus: ExcludedFocus) => boolean,
): SessionStream {
  const excluded = excludeFocusedApps(session.events, isExcluded);
  return {
    sessionId: session.sessionId,
    all: session.events,
    kept: excluded.events,
    dropped: excluded.dropped,
    unattributable: excluded.unattributable,
  };
}

/**
 * A declared identity, plus everything a CONSUMER needs that the declaration
 * deliberately does not carry.
 *
 * `title` and `label` live here and not in `src/knowledge/identities.ts`: that
 * is a library file, and it holds what decides sameness. "Display setups" is UI
 * copy, and putting it there would make the library the owner of a screen's
 * wording.
 */
interface FactSpec<Raw, Canon> {
  declaration: IdentityDeclaration<Raw, Canon>;
  /** The screen's word for this fact. */
  title: string;
  /**
   * The payload this identity reads, out of an event's `data`. `null` is an
   * event whose data is not the shape this fact is about — counted nowhere,
   * because it is not an observation of this fact at all. Distinct from an
   * observation the identity cannot PLACE, which is `unidentified`.
   *
   * IT PASSES THE PAYLOAD THROUGH WHOLE unless there is a reason not to. What it
   * returns becomes the fact's VARIANTS, which is the disclosure that makes a
   * fold checkable — `focus_change`'s 63 distinct payloads collapsing to 7 bundle
   * ids is only visible because the window ids and titles survive to here. The
   * one exception is `keymap_change`, whose payload carries ~70 keycode mappings
   * that are not a value any consumer should hold; see its declaration, and see
   * `projected` below, which is how a reader is told.
   */
  payload: (data: unknown) => Raw | null;
  /**
   * The canonical form as text. Rendered ONCE, here — see `KnowledgeValueDTO.label`.
   *
   * IT MUST SEPARATE WHATEVER THE FOLD SEPARATED. A label is not decoration: it
   * is the only form of a value a person ever sees, so a label that collapses two
   * distinct canonical forms shows one setup where there are two and cannot
   * explain itself. `displayLabel` used to drop the origin the identity keeps,
   * and two configurations differing only in where a panel sat printed the same
   * string. `test/knowledge-view.test.ts` asserts injectivity per fact.
   */
  label: (value: Canon) => string;
  /**
   * The payload was trimmed BEFORE the fold, so `variants` are not raw.
   *
   * `get_fact` exists to make a fold checkable by showing the payloads behind it,
   * and for `keyboard_layout` that claim would be false — its reader keeps
   * `layoutId` and drops ~70 keycode entries. A tool that overstates its own
   * evidence is worse than one that discloses the trim, so the flag rides the DTO
   * and the renderer says so.
   */
  projected?: boolean;
}

/**
 * One fact, with its payload type sealed inside.
 *
 * `read` gathers, folds and resolves in one call so `Raw` never escapes this
 * module — the alternative is handing observations out as `unknown` and casting
 * them back, which is a type assertion standing exactly where the fold's
 * correctness lives.
 */
export interface Fact {
  /** What the fact IS. What a card keys on and what `get_fact` takes. */
  id: string;
  /** The event kind it is read FROM. Two facts may share one. */
  kind: string;
  title: string;
  attribution: Attribution;
  /**
   * The DETAILED form, always. The screen's shape is this one counted
   * (`summarize`), so there is one fold per fact however many faces read it —
   * the alternative is two paths through the same numbers, which is how they
   * come to disagree.
   */
  read(
    streams: readonly SessionStream[],
    startedAt: SessionStartedAt,
    recency: RecencyOptions,
  ): KnowledgeFactDetailDTO;
  /**
   * Distinct raw payloads, folded or not — what `npm run probe:identity` prints
   * beside the folded count, and the only number the DTO cannot supply (an
   * unidentified payload has no value to be a variant of).
   *
   * COUNTED WITH `stableKey`, the same rule `foldByIdentity` dedups variants
   * with. It used to use `JSON.stringify`, which is key-order dependent, so two
   * payloads differing only in key order counted as two here and one there —
   * two rules for one question, which is the drift this repo names by name.
   */
  rawVariants(streams: readonly SessionStream[]): number;
}

const asRecord = (d: unknown): Record<string, unknown> =>
  d !== null && typeof d === "object" ? (d as Record<string, unknown>) : {};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * A value's evidence, discounted by age — the ordering term, and never printed.
 *
 * `docs/research/persistence-layers.md` §4 names the defect this repairs: a
 * ranking over a RAW LIFETIME TALLY, where a display setup used ten times last
 * spring and abandoned outranks one used three times last week, forever. The
 * correction is a time term in the function evaluated per query, never a decay
 * applied to what was stored — the paper's own litmus, and the reason nothing
 * below mutates a count.
 *
 * THE EXPRESSION IS THE ONE THAT ALREADY SHIPS, `0.5 ** (Δ / halfLife)` per
 * recording, identical to `edgeCost`'s `evidenceOf` and `walk-analysis`'s
 * `wayWeight`. One half-life constant serves all three.
 *
 * Two rules are inherited whole:
 *
 *  - **Per distinct RECORDING, not per observation.** `stabilityOf` counts
 *    recordings for the same reason: one session that observes a value twelve
 *    times corroborates it once.
 *  - **An UNDATABLE recording keeps its whole vote.** Recency may discount
 *    evidence we can date and must never penalise evidence we merely cannot.
 */
function evidenceWeight(
  sources: readonly KnowledgeSource[],
  startedAt: SessionStartedAt,
  recency: RecencyOptions,
): number {
  const halfLifeMs = recency.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
  const latest = new Map<string, number | null>();
  for (const s of sources) {
    const start = startedAt(s.sessionId);
    const at = start === undefined ? null : start + s.tMono;
    const prev = latest.get(s.sessionId);
    if (prev === undefined || (prev !== null && at !== null && at > prev)) {
      latest.set(s.sessionId, at);
    }
  }
  let weight = 0;
  for (const at of latest.values()) {
    weight += at === null ? 1 : 0.5 ** (Math.max(0, recency.now - at) / halfLifeMs);
  }
  return weight;
}

/** One value, ordered — the weight stays here and the DTO leaves without it. */
interface Ranked {
  dto: KnowledgeValueDetailDTO;
  weight: number;
}

/**
 * Values, most recently corroborated first.
 *
 * The fold preserves insertion order and says so; ordering for a reader is the
 * CALLER's business, and this is that caller. The lead term is recency-weighted
 * evidence rather than a lifetime count, so a value the library has stopped
 * seeing gives way to one it keeps seeing — which is also what puts an
 * `exclusive` fact's CURRENT value at the top, where the row list used to
 * contradict the verdict above it by opening on the superseded one.
 *
 * The weight is a float and therefore cannot be the whole order: recordings,
 * then observations, then the key break ties, so the result is a deterministic
 * function of the library and not of the order rows came back in.
 */
function byRecentEvidence(a: Ranked, b: Ranked): number {
  if (b.weight !== a.weight) return b.weight - a.weight;
  if (b.dto.stability.sessions !== a.dto.stability.sessions) {
    return b.dto.stability.sessions - a.dto.stability.sessions;
  }
  if (b.dto.observations !== a.dto.observations) return b.dto.observations - a.dto.observations;
  return a.dto.key < b.dto.key ? -1 : a.dto.key > b.dto.key ? 1 : 0;
}

/** Seal one spec's payload type in, and expose only what a consumer reads. */
function factOf<Raw, Canon>(spec: FactSpec<Raw, Canon>): Fact {
  const { id, kind, exclusivity, attribution, identity } = spec.declaration;

  const observations = (streams: readonly SessionStream[]): Observation<Raw>[] => {
    const out: Observation<Raw>[] = [];
    for (const stream of streams) {
      // THE ONE BRANCH ON ATTRIBUTION, and it is the whole of §4.2: an ambient
      // fact reads every event, because the display topology while the recorder
      // is frontmost is the same display topology. Reading `kept` here would
      // cost 6 of 12 recordings their display and keymap observations outright.
      const events = attribution === "ambient" ? stream.all : stream.kept;
      for (const event of events) {
        if (event.kind !== kind) continue;
        const value = spec.payload(event.data);
        if (value === null) continue;
        out.push({ value, source: { sessionId: stream.sessionId, tMono: event.tMono } });
      }
    }
    return out;
  };

  return {
    id,
    kind,
    title: spec.title,
    attribution,
    read(streams, startedAt, recency) {
      const folded = foldByIdentity(kind, observations(streams), identity);
      const current = currentValue(folded, exclusivity, startedAt);
      // IDENTITY, NOT LABEL. Two values can only be told apart by the form the
      // fold grouped them under; matching the rendered string would re-introduce
      // exactly the ambiguity an injective label exists to prevent, and would
      // depend on a rendering rule to stay correct.
      const currentKey = current.value === null ? null : stableKey(current.value);
      const ranked = folded.values
        .map((v): Ranked => {
          const key = stableKey(v.value);
          return {
            weight: evidenceWeight(v.sources, startedAt, recency),
            dto: {
              key,
              label: spec.label(v.value),
              isCurrent: currentKey !== null && key === currentKey,
              // Assigned straight in, as `toGraphDTO` does: a drift between the
              // library's `Stability` and `StabilityDTO` is a typecheck failure
              // rather than a runtime surprise.
              stability: stabilityOf(v.sources),
              observations: v.sources.length,
              lastObservedAt: lastObservedAt(v, startedAt),
              variants: v.variants.map((raw) => JSON.stringify(raw)),
            },
          };
        })
        .sort(byRecentEvidence);
      return {
        id,
        kind,
        title: spec.title,
        attribution,
        projected: spec.projected === true,
        // WHOLE, AND THE CAP IS NOT APPLIED HERE. This is the form `get_fact`
        // returns, and its entire job is making a fold checkable rather than
        // asking that it be taken on trust — a checkable fold cannot be a
        // truncated one. The cap belongs to the COUNTED form (`summarize`),
        // which is what the card and `list_facts` render.
        values: ranked.map((r) => r.dto),
        observations: ranked.reduce((n, r) => n + r.dto.observations, 0),
        unlisted: 0,
        unidentified: folded.unidentified,
        current: current.value === null ? null : spec.label(current.value),
        currentSince: current.lastObservedAt,
        reason: current.reason,
      };
    },
    rawVariants(streams) {
      const seen = new Set<string>();
      for (const o of observations(streams)) seen.add(stableKey(o.value));
      return seen.size;
    },
  };
}

/**
 * A display, as a person reads it: `1920×1080 @2× primary (0,0)`.
 *
 * THE ORIGIN IS IN THE STRING BECAUSE THE IDENTITY KEEPS IT. `DISPLAY_TOPOLOGY`
 * folds on all six fields of every panel, so a label rendering four of them is
 * not a shorter way of saying the same thing — it is a different projection.
 *
 * AND THE COLLISION IS ON THE REAL LIBRARY, not a constructed case. Two of its
 * three display configurations are the same docked pair with the external nudged
 * 91px vertically (y = -797 and y = -706); the old label rendered both as
 * `3840×2160 @1× + 1728×1117 @2× primary`. Two values, one string: a duplicate
 * React key, two rows a person cannot tell apart, two identical blocks in
 * `get_fact`, and a `current` field — which is a LABEL — that no longer names
 * one value.
 *
 * Joined in the tuple's OWN sorted order, so the string is as deterministic as
 * the key it was folded under and the OS's report order cannot mint a second
 * label.
 */
export function displayLabel(geometry: readonly DisplayGeometry[]): string {
  return geometry
    .map(([x, y, w, h, scale, primary]) =>
      `${w}×${h} @${scale}×${primary ? " primary" : ""} (${x},${y})`,
    )
    .join(" + ");
}

/**
 * A focused window: `com.apple.TextEdit · Untitled — Edited`.
 *
 * THE APPLICATION LEADS, and that is what makes the label injective: an
 * application name or bundle id carries no ` · `, so the first separator always
 * splits the pair the fold grouped under. Written the other way round, a window
 * titled `a · b` under app `c` and one titled `a` under app `b · c` would render
 * the same string.
 */
export function windowLabel([app, title]: WindowIdentity): string {
  return `${app} · ${title}`;
}

/**
 * The five facts, in the order the screen draws them.
 *
 * Keyboard layout leads because it is the one that ANSWERS: four of the five are
 * `coexisting`, so `currentValue` refuses them, and a screen that opened on four
 * refusals would teach that declining is all this layer does.
 *
 * Applications and Windows sit together because they are the same event read at
 * two grains — 7 values and 29 on the real library — and reading them apart is
 * what `IdentityDeclaration.id` exists for.
 */
export const FACTS: readonly Fact[] = [
  factOf<KeymapPayload, string>({
    declaration: KEYBOARD_LAYOUT,
    title: "Keyboard layout",
    payload: (data) => {
      const layoutId = str(asRecord(data).layoutId);
      // The 70 keycode entries are dropped HERE as well as by the identity —
      // nothing downstream ever holds them, so nothing downstream can print one.
      return layoutId === undefined ? null : { layoutId };
    },
    label: (v) => v,
    projected: true,
  }),
  factOf<DisplayTopologyPayload, readonly DisplayGeometry[]>({
    declaration: DISPLAY_TOPOLOGY,
    title: "Display setups",
    // WHOLE, AND UNCHECKED ON PURPOSE. The shape check belongs to the identity,
    // which coerces with `coerceDisplays` — the function that wrote the row — so
    // a malformed topology is DISCLOSED as unidentified rather than silently
    // becoming a `NaN`-ordered canonical form. Passing the payload through
    // untouched is also what keeps `variants` raw, which is `get_fact`'s whole
    // reason to exist: the seven re-minted ids are visible nowhere else.
    payload: (data) => asRecord(data) as unknown as DisplayTopologyPayload,
    label: displayLabel,
  }),
  factOf<FocusPayload, string>({
    declaration: FOCUSED_APP,
    title: "Applications",
    // WHOLE, window id and title and bounds included. `FOCUSED_APP` names three
    // decoys and drops all of them, and the variants are where that is visible:
    // 63 distinct payloads, 7 applications.
    payload: (data) => {
      const d = asRecord(data);
      if (str(d.app) === undefined && str(d.bundleId) === undefined) return null;
      return d as FocusPayload;
    },
    label: (v) => v,
  }),
  factOf<WindowPayload, WindowIdentity>({
    declaration: FOCUSED_WINDOW,
    title: "Windows",
    // The SAME admission rule as Applications — it names an application — so a
    // focus event with no title is an observation of this fact that the identity
    // cannot place, and lands in `unidentified` rather than vanishing. A payload
    // this reader rejects is counted nowhere at all, which would be the wrong
    // claim: the window was focused, we just cannot name it.
    payload: (data) => {
      const d = asRecord(data);
      if (str(d.app) === undefined && str(d.bundleId) === undefined) return null;
      return d as WindowPayload;
    },
    label: windowLabel,
  }),
  factOf<string, string>({
    declaration: VISITED_PAGE,
    // `url_change` stores `{url}`; the identity takes the string itself, which
    // is why the payload reader is a field read rather than the object.
    title: "Sites",
    payload: (data) => str(asRecord(data).url) ?? null,
    label: (v) => v,
  }),
];

/**
 * The facts a caller may ask for, static and free.
 *
 * `get_fact`'s not-found message names them, and naming them used to cost a
 * second full run of the pipeline — `factKinds(reader.listFacts())` — on an
 * error path. What a fact is CALLED does not depend on the library.
 */
export const KNOWLEDGE_FACT_IDS: readonly string[] = FACTS.map((f) => f.id);

/**
 * The detailed form counted: what a card shows, from what a tool discloses.
 *
 * AND WHERE THE CAP LIVES. A card and an MCP listing render every value inline,
 * and `focused_window` lands at 29 on the real library where the largest fact
 * before it held 21 — so past `MAX_FACT_VALUES` the remainder is FOLDED AND
 * COUNTED, on `IndexShare`'s rule: never widened, never silently cut, and the
 * count says how many. `get_fact` is deliberately not capped; checking a fold
 * against a truncated list is not checking it.
 */
export function summarize(fact: KnowledgeFactDetailDTO): KnowledgeFactDTO {
  return {
    ...fact,
    unlisted: Math.max(0, fact.values.length - MAX_FACT_VALUES),
    values: fact.values.slice(0, MAX_FACT_VALUES).map(
      (v): KnowledgeValueDTO => ({
        key: v.key,
        label: v.label,
        isCurrent: v.isCurrent,
        stability: v.stability,
        observations: v.observations,
        lastObservedAt: v.lastObservedAt,
        variants: v.variants.length,
      }),
    ),
  };
}

/**
 * Every recording split once, and every fact read from the split.
 *
 * ONE `excludeFocusedApps` PER RECORDING, reused by both focused-app
 * declarations rather than recomputed per fact — `flows()` carries the same note
 * about not scanning the session list once per source.
 */
function prepare(input: KnowledgeInput): {
  streams: SessionStream[];
  startedAt: SessionStartedAt;
} {
  const streams = input.sessions.map((s) => sessionStream(s, input.isExcluded));
  // One pass for the whole screen, not a lookup per source: a value observed in
  // eleven recordings would otherwise scan the list eleven times.
  //
  // EVERY OBSERVATION'S RECORDING IS IN THIS MAP BY CONSTRUCTION — the streams
  // are built from these same sessions and `KnowledgeSession.startedAt` is
  // required — so `Current.undated` is structurally zero on this path and the
  // DTO carries no field for it. The library keeps the contract for a caller
  // whose sessions cannot all be dated; this one has none.
  const starts = new Map<string, number>();
  for (const s of input.sessions) starts.set(s.sessionId, s.startedAt);
  return { streams, startedAt: (sessionId) => starts.get(sessionId) };
}

/** Every fact, in full. `knowledgeView` is this counted. */
export function knowledgeFacts(input: KnowledgeInput): KnowledgeFactDetailDTO[] {
  const { streams, startedAt } = prepare(input);
  return FACTS.map((f) => f.read(streams, startedAt, input.recency));
}

/**
 * ONE fact in full, or null when nothing declares it. What `get_fact` reads.
 *
 * Reads the fact asked for and no other — it used to build all of them and throw
 * four fifths away, which is a whole pipeline per tool call.
 *
 * ACCEPTS AN EVENT KIND TOO, but only while it is unambiguous. `display_change`
 * was the address before facts had ids and an agent mid-conversation should not
 * be broken by a rename; `focus_change` now names two facts and resolving it to
 * either would be a guess, so it resolves to neither.
 */
export function knowledgeFactDetail(
  input: KnowledgeInput,
  id: string,
): KnowledgeFactDetailDTO | null {
  const byId = FACTS.find((f) => f.id === id);
  const byKind = FACTS.filter((f) => f.kind === id);
  const fact = byId ?? (byKind.length === 1 ? byKind[0] : undefined);
  if (fact === undefined) return null;
  const { streams, startedAt } = prepare(input);
  return fact.read(streams, startedAt, input.recency);
}

/** Every environment fact the library holds, with the corpus it was read from. */
export function knowledgeView(input: KnowledgeInput): KnowledgeDTO {
  const { streams, startedAt } = prepare(input);
  return {
    facts: FACTS.map((f) => summarize(f.read(streams, startedAt, input.recency))),
    recordings: input.sessions.length,
    excludedApps: [...input.excludedApps],
    excludedEvents: streams.reduce((n, s) => n + s.dropped, 0),
    unattributable: streams.filter((s) => s.unattributable).length,
  };
}
