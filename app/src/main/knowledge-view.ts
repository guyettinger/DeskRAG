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
 * ## It is not a score
 *
 * Every number that leaves here is a count. A value's evidence is
 * `stabilityOf`'s tier — a WORD and a count of recordings — which may be printed
 * where `FrameResult.score` may not.
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
  stabilityOf,
  DISPLAY_TOPOLOGY,
  FOCUSED_APP,
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
  Observation,
  SessionStartedAt,
  TraceEvent,
} from "deskrag";

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
   * that are not a value any consumer should hold; see its declaration.
   */
  payload: (data: unknown) => Raw | null;
  /** The canonical form as text. Rendered ONCE, here — see `KnowledgeValueDTO.label`. */
  label: (value: Canon) => string;
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
  kind: string;
  title: string;
  attribution: Attribution;
  /**
   * The DETAILED form, always. The screen's shape is this one counted
   * (`summarize`), so there is one fold per fact however many faces read it —
   * the alternative is two paths through the same numbers, which is how they
   * come to disagree.
   */
  read(streams: readonly SessionStream[], startedAt: SessionStartedAt): KnowledgeFactDetailDTO;
  /**
   * Distinct raw payloads, folded or not — what `npm run probe:identity` prints
   * beside the folded count, and the only number the DTO cannot supply (an
   * unidentified payload has no value to be a variant of).
   */
  rawVariants(streams: readonly SessionStream[]): number;
}

const asRecord = (d: unknown): Record<string, unknown> =>
  d !== null && typeof d === "object" ? (d as Record<string, unknown>) : {};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Values, most corroborated first.
 *
 * The fold preserves insertion order and says so; ordering for a reader is the
 * CALLER's business, and this is that caller. Distinct recordings lead, because
 * that is the evidence the tier is computed from; observations and then the
 * label itself break ties, so the order is a deterministic function of the
 * library and not of the order rows came back in.
 */
function byEvidence(a: KnowledgeValueDetailDTO, b: KnowledgeValueDetailDTO): number {
  if (b.stability.sessions !== a.stability.sessions) {
    return b.stability.sessions - a.stability.sessions;
  }
  if (b.observations !== a.observations) return b.observations - a.observations;
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

/** Seal one spec's payload type in, and expose only what a consumer reads. */
function factOf<Raw, Canon>(spec: FactSpec<Raw, Canon>): Fact {
  const { kind, exclusivity, attribution, identity } = spec.declaration;

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
    kind,
    title: spec.title,
    attribution,
    read(streams, startedAt) {
      const folded = foldByIdentity(kind, observations(streams), identity);
      const current = currentValue(folded, exclusivity, startedAt);
      const values = folded.values
        .map(
          (v): KnowledgeValueDetailDTO => ({
            label: spec.label(v.value),
            // Assigned straight in, as `toGraphDTO` does: a drift between the
            // library's `Stability` and `StabilityDTO` is a typecheck failure
            // rather than a runtime surprise.
            stability: stabilityOf(v.sources),
            observations: v.sources.length,
            variants: v.variants.map((raw) => JSON.stringify(raw)),
          }),
        )
        .sort(byEvidence);
      return {
        kind,
        title: spec.title,
        attribution,
        values,
        unidentified: folded.unidentified,
        current: current.value === null ? null : spec.label(current.value),
        reason: current.reason,
        undated: current.undated,
      };
    },
    rawVariants(streams) {
      const seen = new Set<string>();
      for (const o of observations(streams)) seen.add(JSON.stringify(o.value));
      return seen.size;
    },
  };
}

/**
 * A display, as a person reads it: `1920×1080 @2× primary`.
 *
 * The only canonical form that needs rendering at all — `layoutId`, `bundleId`
 * and `urlPrefix` are already strings and pass through verbatim. Joined in the
 * tuple's OWN sorted order, so the string is as deterministic as the key it was
 * folded under and the OS's report order cannot mint a second label.
 */
export function displayLabel(geometry: readonly DisplayGeometry[]): string {
  return geometry
    .map(([, , w, h, scale, primary]) => `${w}×${h} @${scale}×${primary ? " primary" : ""}`)
    .join(" + ");
}

/**
 * The four facts, in the order the screen draws them.
 *
 * Keyboard layout leads because it is the one that ANSWERS: three of the four
 * are `coexisting`, so `currentValue` refuses them, and a screen that opened on
 * three refusals would teach that declining is all this layer does.
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
  }),
  factOf<DisplayTopologyPayload, readonly DisplayGeometry[]>({
    declaration: DISPLAY_TOPOLOGY,
    title: "Display setups",
    payload: (data) => {
      const displays = asRecord(data).displays;
      return Array.isArray(displays)
        ? ({ displays } as DisplayTopologyPayload)
        : null;
    },
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
  factOf<string, string>({
    declaration: VISITED_PAGE,
    // `url_change` stores `{url}`; the identity takes the string itself, which
    // is why the payload reader is a field read rather than the object.
    title: "Sites",
    payload: (data) => str(asRecord(data).url) ?? null,
    label: (v) => v,
  }),
];

/** The detailed form counted: what a card shows, from what a tool discloses. */
export function summarize(fact: KnowledgeFactDetailDTO): KnowledgeFactDTO {
  return {
    ...fact,
    values: fact.values.map(
      (v): KnowledgeValueDTO => ({
        label: v.label,
        stability: v.stability,
        observations: v.observations,
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
function readAll(input: KnowledgeInput): {
  streams: SessionStream[];
  facts: KnowledgeFactDetailDTO[];
} {
  const streams = input.sessions.map((s) => sessionStream(s, input.isExcluded));
  // One pass for the whole screen, not a lookup per source: a value observed in
  // eleven recordings would otherwise scan the list eleven times.
  const starts = new Map<string, number>();
  for (const s of input.sessions) starts.set(s.sessionId, s.startedAt);
  const startedAt: SessionStartedAt = (sessionId) => starts.get(sessionId);
  return { streams, facts: FACTS.map((f) => f.read(streams, startedAt)) };
}

/** Every fact, in full. `knowledgeView` is this counted; `get_fact` reads it whole. */
export function knowledgeFacts(input: KnowledgeInput): KnowledgeFactDetailDTO[] {
  return readAll(input).facts;
}

/** Every environment fact the library holds, with the corpus it was read from. */
export function knowledgeView(input: KnowledgeInput): KnowledgeDTO {
  const { streams, facts } = readAll(input);
  return {
    facts: facts.map(summarize),
    recordings: input.sessions.length,
    excludedApps: [...input.excludedApps],
    excludedEvents: streams.reduce((n, s) => n + s.dropped, 0),
    unattributable: streams.filter((s) => s.unattributable).length,
  };
}
