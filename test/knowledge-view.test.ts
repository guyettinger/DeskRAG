import { describe, expect, it } from "vitest";
import {
  FACTS,
  MAX_FACT_VALUES,
  displayLabel,
  knowledgeFactDetail,
  knowledgeFacts,
  knowledgeView,
  sessionStream,
  windowLabel,
  type KnowledgeInput,
  type KnowledgeSession,
} from "../app/src/main/knowledge-view.js";
import type { KnowledgeDTO, KnowledgeFactDTO } from "../app/src/shared/types.js";
import { excludedByName } from "../src/trace/exclude.js";
import type { TraceEvent } from "../src/trace/types.js";

/**
 * The Knowledge layer's first consumer, tested where it is pure.
 *
 * `deskrag-service.ts` imports electron, so the root suite cannot construct it —
 * which is exactly why the fold, the fact-scoped exclusion and all three
 * refusals live in `knowledge-view.ts` and not in a service method. Everything
 * below would otherwise be reachable only by launching the app.
 *
 * REACHING INTO `app/src/main/` is the established shape here, not a shortcut:
 * ten test files and nine probes already do it.
 */

const RECORDER = { app: "Electron", bundleId: "com.github.Electron" };
const isExcluded = excludedByName(["Electron", "com.github.Electron"]);

const event = (tMono: number, kind: string, data: unknown): TraceEvent => ({
  tMono,
  kind,
  x: null,
  y: null,
  data,
});

/** One display, in the shape `ActiveWindowProducer` emits. */
const display = (id: string, w: number, h: number): unknown => ({
  id,
  x: 0,
  y: 0,
  w,
  h,
  scale: 2,
  primary: true,
});

/**
 * A recording shaped like every real one: it opens in the recorder, where the
 * environment is sampled, and only then reaches the work.
 *
 * That order is the whole of §4.2 — the ambient facts are sampled while the
 * recorder is still frontmost, so an exclusion applied to every event would take
 * them with it.
 */
function session(sessionId: string, startedAt: number, opts: {
  displayId: string;
  width?: number;
  layoutId?: string;
  workApp?: { app: string; bundleId: string };
  title?: string;
  urls?: string[];
}): KnowledgeSession {
  const events: TraceEvent[] = [
    event(0, "focus_change", { ...RECORDER, title: "DeskRAG — Recorder" }),
    event(10, "display_change", { displays: [display(opts.displayId, opts.width ?? 1920, 1080)] }),
    event(20, "keymap_change", {
      layoutId: opts.layoutId ?? "com.apple.keylayout.US",
      entries: { a: "a", b: "b" },
    }),
  ];
  const work = opts.workApp ?? { app: "Google Chrome", bundleId: "com.google.Chrome" };
  events.push(event(1000, "focus_change", { ...work, title: opts.title ?? "News" }));
  let t = 1100;
  for (const url of opts.urls ?? []) {
    events.push(event(t, "url_change", { url }));
    t += 100;
  }
  // Back to the recorder to press Stop, the trailing bracket every session has.
  events.push(event(9000, "focus_change", { ...RECORDER, title: "DeskRAG — Recorder" }));
  events.push(event(9100, "url_change", { url: "http://localhost:5173/" }));
  return { sessionId, startedAt, events };
}

/**
 * Far enough after every fixture recording to be realistic, and near enough that
 * the default half-life leaves them all effectively equal.
 *
 * DELIBERATE: recency must not perturb the tests that are about something else.
 * The fixtures span ~9e6 ms against a 14-day half-life of ~1.2e9, so every
 * weight is within a whisker of 1 and the order falls back to recordings — the
 * behaviour the tests below the recency block are asserting.
 */
const NOW = 10_000_000;

const input = (sessions: KnowledgeSession[], now = NOW): KnowledgeInput => ({
  sessions,
  isExcluded,
  excludedApps: ["Electron", "com.github.Electron"],
  recency: { now },
});

/** One fact by ID. Throws rather than returning undefined: a missing fact is a
 * failure of the projection, and an assertion on `undefined.values` reads as a
 * broken test instead.
 *
 * BY ID AND NOT BY KIND, because `focused_app` and `focused_window` both read
 * `focus_change` and a lookup by kind would silently return whichever came
 * first. */
const factOf = (dto: KnowledgeDTO, id: string): KnowledgeFactDTO => {
  const fact = dto.facts.find((f) => f.id === id);
  if (fact === undefined) throw new Error(`no fact ${id}`);
  return fact;
};

const library = (): KnowledgeSession[] => [
  session("s1", 1_000_000, { displayId: "180", urls: ["https://news.google.com/topics/x"] }),
  session("s2", 2_000_000, { displayId: "185", urls: ["https://news.google.com/foo"] }),
  session("s3", 3_000_000, { displayId: "206", urls: ["https://www.linkedin.com/feed/"] }),
];

describe("the recorder exclusion is scoped by fact type", () => {
  it("keeps an AMBIENT fact's observations, which are all sampled inside the recorder", () => {
    // MEASURED on the real library: excluding these costs 6 of 12 recordings
    // their display and keymap observations outright. Every observation here is
    // stamped before the first non-recorder focus, so a blanket exclusion would
    // return an empty fact and the screen would say the desktop has no displays.
    const dto = knowledgeView(input(library()));
    expect(factOf(dto, "display_topology").values[0]!.observations).toBe(3);
    expect(factOf(dto, "keyboard_layout").values[0]!.observations).toBe(3);
  });

  it("drops a FOCUSED-APP fact's recorder observations", () => {
    // The trailing `localhost:5173` of each recording belongs to the recorder,
    // and on the real library that one site was the most-visited of all.
    const dto = knowledgeView(input(library()));
    const sites = factOf(dto, "visited_page");
    expect(sites.values.map((v) => v.label)).not.toContain("localhost:5173");
    expect(dto.excludedEvents).toBeGreaterThan(0);
  });

  it("keeps the applications that are actually worked in", () => {
    const dto = knowledgeView(input(library()));
    const apps = factOf(dto, "focused_app");
    expect(apps.values.map((v) => v.label)).toEqual(["com.google.Chrome"]);
  });

  it("declares which side of that split each fact is on", () => {
    // The DTO carries it because a CARD has to be able to say the exclusion does
    // not apply to it — otherwise the screen states two display setups and
    // cannot explain why the recorder did not cost it one.
    const byId = Object.fromEntries(FACTS.map((f) => [f.id, f.attribution]));
    expect(byId).toEqual({
      keyboard_layout: "ambient",
      display_topology: "ambient",
      focused_app: "focused-app",
      focused_window: "focused-app",
      visited_page: "focused-app",
    });
  });
});

describe("the fold", () => {
  it("collapses the ids macOS re-mints and discloses how many it collapsed", () => {
    const dto = knowledgeView(input(library()));
    const displays = factOf(dto, "display_topology");
    expect(displays.values).toHaveLength(1);
    expect(displays.values[0]!.label).toBe("1920×1080 @2× primary (0,0)");
    // THREE payloads, one value — the claim the whole cycle rests on, and the
    // count is what makes it checkable rather than asserted.
    expect(displays.values[0]!.variants).toBe(3);
  });

  it("keeps a genuinely different configuration apart", () => {
    const docked = session("s4", 4_000_000, { displayId: "219", width: 3840 });
    const dto = knowledgeView(input([...library(), docked]));
    expect(factOf(dto, "display_topology").values).toHaveLength(2);
  });

  it("counts what the identity could not place, and never drops it", () => {
    // `chrome://new-tab-page/` names no site. Three of 44 real observations are
    // that, and reporting 41 with no disclosure would invent a corpus.
    const s = session("s1", 1_000_000, { displayId: "180", urls: ["chrome://new-tab-page/"] });
    const dto = knowledgeView(input([s]));
    const sites = factOf(dto, "visited_page");
    expect(sites.values).toHaveLength(0);
    expect(sites.unidentified).toBe(1);
  });

  it("renders a value's label ONCE, so both faces are byte-identical", () => {
    const dto = knowledgeView(input(library()));
    const detail = knowledgeFactDetail(input(library()), "display_topology")!;
    expect(detail.values[0]!.label).toBe(factOf(dto, "display_topology").values[0]!.label);
    // And the detailed form carries the payloads themselves, which is the only
    // place the re-minted ids are visible.
    expect(detail.values[0]!.variants.join("\n")).toMatch(/"180"[\s\S]*"185"/);
  });
});

describe("what is current", () => {
  it("answers for the one EXCLUSIVE fact", () => {
    // Without this the screen shows three refusals and nothing else, which
    // teaches that refusing is all the layer does.
    const dto = knowledgeView(input(library()));
    const layout = factOf(dto, "keyboard_layout");
    expect(layout.current).toBe("com.apple.keylayout.US");
    expect(layout.reason).toMatch(/only value observed/);
  });

  it("supersedes when the layout actually changes", () => {
    const dto = knowledgeView(
      input([
        session("s1", 1_000_000, { displayId: "180" }),
        session("s2", 2_000_000, { displayId: "185", layoutId: "com.apple.keylayout.Dvorak" }),
      ]),
    );
    const layout = factOf(dto, "keyboard_layout");
    expect(layout.current).toBe("com.apple.keylayout.Dvorak");
    // The older value still STANDS — it is not deleted, only not current.
    expect(layout.values).toHaveLength(2);
  });

  it("refuses all three COEXISTING facts, with a reason rather than a null", () => {
    const docked = session("s4", 4_000_000, {
      displayId: "219",
      width: 3840,
      workApp: { app: "TextEdit", bundleId: "com.apple.TextEdit" },
    });
    const dto = knowledgeView(input([...library(), docked]));
    for (const id of ["display_topology", "focused_app", "focused_window", "visited_page"]) {
      const fact = factOf(dto, id);
      expect(fact.current, id).toBeNull();
      expect(fact.reason, id).toMatch(/all be true at once/);
    }
  });
});

describe("the corpus is disclosed before the answers", () => {
  it("counts the recordings, the excluded events and the excluded names", () => {
    const dto = knowledgeView(input(library()));
    expect(dto.recordings).toBe(3);
    expect(dto.excludedApps).toEqual(["Electron", "com.github.Electron"]);
    expect(dto.unattributable).toBe(0);
  });

  it("reports a recording with no focus events as unattributable, and excludes nothing", () => {
    // `active-win` off. `excludeFocusedApps` is a NO-OP there by design — this
    // rule must never be the reason a library reads as empty — so the count is
    // the only thing that says the exclusion did not run.
    const blind: KnowledgeSession = {
      sessionId: "s9",
      startedAt: 5_000_000,
      events: [event(0, "url_change", { url: "http://localhost:5173/" })],
    };
    const dto = knowledgeView(input([blind]));
    expect(dto.unattributable).toBe(1);
    expect(dto.excludedEvents).toBe(0);
    // And the recorder's own site survives, which is the cost of that no-op and
    // is disclosed rather than hidden.
    expect(factOf(dto, "visited_page").values).toHaveLength(1);
  });

  it("says so when nothing has been recorded", () => {
    const dto = knowledgeView(input([]));
    expect(dto.recordings).toBe(0);
    for (const fact of dto.facts) {
      expect(fact.values, fact.id).toHaveLength(0);
      expect(fact.reason, fact.id).toMatch(/Nothing has been observed/);
    }
  });
});

/**
 * A LABEL MUST SEPARATE WHATEVER THE FOLD SEPARATED.
 *
 * This is the guard the whole cycle turns on. `displayLabel` used to render four
 * of the six fields the identity keeps, so two configurations differing only in
 * where a panel sat printed one string — measured: two values, one label. On the
 * screen that is a duplicate React key and two rows nobody can tell apart; in
 * `get_fact` it is two identical blocks; and `KnowledgeFactDTO.current` is a
 * label, so it stops naming one value.
 *
 * Written per FACT rather than per label function, so a sixth declaration is
 * covered the day it is added rather than the day someone remembers.
 */
describe("every label is injective over the canonical form", () => {
  /** Distinct canonical forms for every declared fact, as recordings. */
  const distinguishing = (): KnowledgeSession[] => [
    // Two display setups that differ ONLY in the second panel's origin — the
    // exact pair the old label collapsed.
    {
      sessionId: "d1",
      startedAt: 1_000_000,
      events: [
        event(0, "focus_change", { app: "Work", bundleId: "com.work", title: "One" }),
        event(10, "display_change", {
          displays: [
            { id: "1", x: 0, y: 0, w: 1920, h: 1080, scale: 2, primary: true },
            { id: "2", x: 1920, y: 0, w: 2560, h: 1440, scale: 1, primary: false },
          ],
        }),
        event(20, "keymap_change", { layoutId: "com.apple.keylayout.US", entries: {} }),
        event(30, "url_change", { url: "https://example.com/a" }),
      ],
    },
    {
      sessionId: "d2",
      startedAt: 2_000_000,
      events: [
        event(0, "focus_change", { app: "Work", bundleId: "com.work", title: "Two" }),
        event(10, "display_change", {
          displays: [
            { id: "9", x: 0, y: 0, w: 1920, h: 1080, scale: 2, primary: true },
            { id: "8", x: 1920, y: 60, w: 2560, h: 1440, scale: 1, primary: false },
          ],
        }),
        event(20, "keymap_change", { layoutId: "com.apple.keylayout.Dvorak", entries: {} }),
        event(30, "url_change", { url: "https://example.com/b" }),
      ],
    },
  ];

  it("gives every distinct value a distinct label, on every fact", () => {
    for (const fact of knowledgeFacts(input(distinguishing()))) {
      const labels = new Set(fact.values.map((v) => v.label));
      expect(labels.size, `${fact.id} collapsed two values into one label`).toBe(
        fact.values.length,
      );
    }
  });

  it("keeps two display setups apart that differ only in a panel's origin", () => {
    // The reproduction, kept as its own case so a regression names itself.
    const displays = factOf(knowledgeView(input(distinguishing())), "display_topology");
    expect(displays.values).toHaveLength(2);
    expect(displays.values.map((v) => v.label)).toEqual([
      "1920×1080 @2× primary (0,0) + 2560×1440 @1× (1920,60)",
      "1920×1080 @2× primary (0,0) + 2560×1440 @1× (1920,0)",
    ]);
  });

  it("gives every distinct value a distinct KEY, which is what a list is keyed on", () => {
    for (const fact of knowledgeView(input(distinguishing())).facts) {
      const keys = new Set(fact.values.map((v) => v.key));
      expect(keys.size, fact.id).toBe(fact.values.length);
    }
  });

  it("puts the application first in a window label, so the split is unambiguous", () => {
    // A title may contain ` · `; a bundle id may not, so leading with it is what
    // makes the pair recoverable and the label injective.
    expect(windowLabel(["com.apple.TextEdit", "Untitled — Edited"])).toBe(
      "com.apple.TextEdit · Untitled — Edited",
    );
  });
});

/**
 * ORDERING BY A RAW LIFETIME TALLY IS §4'S DEFECT, and it had §4's consequence
 * here: a superseded value opened the list while the verdict above it named the
 * value that had replaced it.
 */
describe("values are ordered by recent evidence", () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** Three recordings on US, then one on Dvorak a fortnight later. */
  const switched = (): KnowledgeSession[] => [
    session("s1", 100 * DAY, { displayId: "180" }),
    session("s2", 101 * DAY, { displayId: "185" }),
    session("s3", 102 * DAY, { displayId: "206" }),
    session("s4", 140 * DAY, { displayId: "219", layoutId: "com.apple.keylayout.Dvorak" }),
  ];

  it("puts the current value first, even where the superseded one has more recordings", () => {
    const dto = knowledgeView(input(switched(), 141 * DAY));
    const layout = factOf(dto, "keyboard_layout");
    expect(layout.current).toBe("com.apple.keylayout.Dvorak");
    // The row order used to be the exact opposite of the verdict above it.
    expect(layout.values[0]!.label).toBe("com.apple.keylayout.Dvorak");
    expect(layout.values[0]!.stability.sessions).toBe(1);
    expect(layout.values[1]!.stability.sessions).toBe(3);
  });

  it("marks the current row rather than leaving it to be matched by label", () => {
    const layout = factOf(knowledgeView(input(switched(), 141 * DAY)), "keyboard_layout");
    expect(layout.values.filter((v) => v.isCurrent).map((v) => v.label)).toEqual([
      "com.apple.keylayout.Dvorak",
    ]);
  });

  it("marks nothing on a fact that refuses", () => {
    const displays = factOf(knowledgeView(input(switched(), 141 * DAY)), "display_topology");
    expect(displays.current).toBeNull();
    expect(displays.values.some((v) => v.isCurrent)).toBe(false);
  });

  it("dates every value, so the order can be checked instead of trusted", () => {
    const layout = factOf(knowledgeView(input(switched(), 141 * DAY)), "keyboard_layout");
    expect(layout.values[0]!.lastObservedAt).toBe(140 * DAY + 20);
    expect(layout.currentSince).toBe(140 * DAY + 20);
  });

  it("falls back to recordings when everything is equally fresh — a null result is a result", () => {
    // Far past every half-life: all weights collapse together and the lifetime
    // tally decides again, which is what makes the term's effect legible.
    const layout = factOf(knowledgeView(input(switched(), 100_000 * DAY)), "keyboard_layout");
    expect(layout.values[0]!.stability.sessions).toBe(3);
    // And it is STILL not the current one — supersession is a different question
    // from how a list is ordered.
    expect(layout.current).toBe("com.apple.keylayout.Dvorak");
  });

  it("never leaks the weight it ordered by", () => {
    // The weight is a fraction. `FrameResult.score`'s rule: what leaves is the
    // rank it produced and the date that explains it.
    const json = JSON.stringify(knowledgeView(input(switched(), 141 * DAY)));
    expect(json).not.toMatch(/"weight"|"score"/);
  });
});

/**
 * The window fact — the second identity over `focus_change`, and the reason a
 * fact is addressed by an id rather than by the event it reads.
 */
describe("two facts over one event kind", () => {
  const windows = (): KnowledgeSession[] => [
    session("s1", 1_000_000, { displayId: "180", title: "report.md — Edited" }),
    session("s2", 2_000_000, { displayId: "185", title: "report.md — Edited" }),
    session("s3", 3_000_000, { displayId: "206", title: "notes.md" }),
  ];

  it("reads applications and windows from the same events at two grains", () => {
    const dto = knowledgeView(input(windows()));
    expect(factOf(dto, "focused_app").values.map((v) => v.label)).toEqual(["com.google.Chrome"]);
    expect(factOf(dto, "focused_window").values.map((v) => v.label)).toEqual([
      "com.google.Chrome · report.md — Edited",
      "com.google.Chrome · notes.md",
    ]);
  });

  it("inherits the recorder exclusion, so the Recorder's own window is not a window", () => {
    const labels = factOf(knowledgeView(input(windows())), "focused_window").values.map(
      (v) => v.label,
    );
    expect(labels.join("\n")).not.toMatch(/Recorder/);
  });

  it("counts a focus event with no title rather than dropping it", () => {
    // The window WAS focused; we just cannot name it. That is an observation the
    // identity could not place, which is `unidentified` — not a payload this
    // fact is uninterested in, which would be counted nowhere.
    const s: KnowledgeSession = {
      sessionId: "s9",
      startedAt: 1_000_000,
      events: [
        event(0, "focus_change", { app: "Work", bundleId: "com.work" }),
        event(10, "focus_change", { app: "Work", bundleId: "com.work", title: "Doc" }),
      ],
    };
    const dto = knowledgeView(input([s]));
    expect(factOf(dto, "focused_window").unidentified).toBe(1);
    expect(factOf(dto, "focused_window").values).toHaveLength(1);
    // The APPLICATION fact places both, because it never needed a title.
    expect(factOf(dto, "focused_app").values[0]!.observations).toBe(2);
  });

  it("is addressable by id, and by kind only while a kind names one fact", () => {
    const i = input(windows());
    expect(knowledgeFactDetail(i, "focused_window")?.title).toBe("Windows");
    expect(knowledgeFactDetail(i, "focused_app")?.title).toBe("Applications");
    // `display_change` was the address before facts had ids, and it still is.
    expect(knowledgeFactDetail(i, "display_change")?.id).toBe("display_topology");
    // `focus_change` names TWO, so resolving it either way would be a guess.
    expect(knowledgeFactDetail(i, "focus_change")).toBeNull();
    expect(knowledgeFactDetail(i, "nope")).toBeNull();
  });
});

/**
 * The reader coerces with the function that WROTE the row, and the counted form
 * caps while the detailed form does not.
 */
describe("what the projection refuses to trust", () => {
  const withDisplays = (displays: unknown): KnowledgeSession => ({
    sessionId: "s1",
    startedAt: 1_000_000,
    events: [
      event(0, "focus_change", { app: "Work", bundleId: "com.work", title: "One" }),
      event(10, "display_change", { displays }),
    ],
  });

  it("drops a display whose geometry is not a geometry, rather than folding NaN", () => {
    // `compareGeometry` subtracts, so a missing field returns NaN from the
    // comparator and the sort order — and therefore the CANONICAL FORM — becomes
    // implementation-defined. A non-deterministic identity is the one failure
    // this module exists to prevent, so the reader coerces with `coerceDisplays`,
    // the same function that wrote the row.
    const dto = knowledgeView(
      input([
        withDisplays([
          { id: "1", x: 0, y: 0, w: 1920, h: 1080, scale: 2, primary: true },
          { id: "2", x: 0, w: 2560, h: 1440, scale: 1 },
        ]),
      ]),
    );
    const displays = factOf(dto, "display_topology");
    expect(displays.values).toHaveLength(1);
    expect(displays.values[0]!.label).toBe("1920×1080 @2× primary (0,0)");
  });

  it("treats a topology that coerces to nothing as unplaceable, not as no screens", () => {
    const dto = knowledgeView(input([withDisplays([{ id: "1", x: "left" }])]));
    expect(factOf(dto, "display_topology").values).toHaveLength(0);
    expect(factOf(dto, "display_topology").unidentified).toBe(1);
  });

  it("counts a raw payload the way the fold does, not with a second rule", () => {
    // `JSON.stringify` is key-order dependent and `stableKey` is not, so the
    // probe's `raw` column and the DTO's `variants` used to answer one question
    // two ways.
    const streams = [
      sessionStream(
        {
          sessionId: "s1",
          startedAt: 1,
          events: [
            event(0, "focus_change", { app: "Calc", bundleId: "com.apple.calculator" }),
            event(1, "focus_change", { bundleId: "com.apple.calculator", app: "Calc" }),
          ],
        },
        () => false,
      ),
    ];
    const apps = FACTS.find((f) => f.id === "focused_app")!;
    const detail = apps.read(streams, () => 1, { now: NOW });
    expect(apps.rawVariants(streams)).toBe(detail.values[0]!.variants.length);
    expect(apps.rawVariants(streams)).toBe(1);
  });
});

describe("a long fact folds rather than becoming the screen", () => {
  /** One recording that visits many sites, so `visited_page` exceeds the cap. */
  const many = (n: number): KnowledgeSession => ({
    sessionId: "s1",
    startedAt: 1_000_000,
    events: [
      event(0, "focus_change", { app: "Work", bundleId: "com.work", title: "One" }),
      ...Array.from({ length: n }, (_, i) =>
        event(100 + i, "url_change", { url: `https://site${i}.example.com/` }),
      ),
    ],
  });

  it("caps the COUNTED form and says how many it folded", () => {
    const over = MAX_FACT_VALUES + 5;
    const sites = factOf(knowledgeView(input([many(over)])), "visited_page");
    expect(sites.values).toHaveLength(MAX_FACT_VALUES);
    expect(sites.unlisted).toBe(5);
    // The evidence is a FACT-level count, so it does not shrink with the list.
    expect(sites.observations).toBe(over);
  });

  it("does NOT cap the detailed form — a fold cannot be checked against a truncation", () => {
    const over = MAX_FACT_VALUES + 5;
    const detail = knowledgeFactDetail(input([many(over)]), "visited_page")!;
    expect(detail.values).toHaveLength(over);
    expect(detail.unlisted).toBe(0);
  });

  it("says nothing when there is nothing to fold", () => {
    expect(factOf(knowledgeView(input(library())), "visited_page").unlisted).toBe(0);
  });
});

describe("labels", () => {
  it("renders a display in its own sorted order, joined", () => {
    expect(
      displayLabel([
        [0, 0, 3840, 2160, 1, false],
        [0, 2160, 1728, 1117, 2, true],
      ]),
    ).toBe("3840×2160 @1× (0,0) + 1728×1117 @2× primary (0,2160)");
  });

  it("never lets the keymap's seventy entries reach a consumer", () => {
    // The reason `keymap_change` has an identity at all: the fold count is 1
    // either way, but a projection decides what a consumer SEES.
    const detail = knowledgeFacts(input(library()))[0]!;
    expect(detail.id).toBe("keyboard_layout");
    expect(detail.values[0]!.variants.join("")).not.toMatch(/entries/);
    // And it SAYS the payloads were trimmed, because `get_fact` otherwise
    // promises raw evidence it is not showing.
    expect(detail.projected).toBe(true);
  });
});
