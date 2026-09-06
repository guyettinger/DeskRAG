import { describe, expect, it } from "vitest";
import {
  FACTS,
  displayLabel,
  knowledgeFacts,
  knowledgeView,
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
  urls?: string[];
}): KnowledgeSession {
  const events: TraceEvent[] = [
    event(0, "focus_change", RECORDER),
    event(10, "display_change", { displays: [display(opts.displayId, opts.width ?? 1920, 1080)] }),
    event(20, "keymap_change", {
      layoutId: opts.layoutId ?? "com.apple.keylayout.US",
      entries: { a: "a", b: "b" },
    }),
  ];
  const work = opts.workApp ?? { app: "Google Chrome", bundleId: "com.google.Chrome" };
  events.push(event(1000, "focus_change", work));
  let t = 1100;
  for (const url of opts.urls ?? []) {
    events.push(event(t, "url_change", { url }));
    t += 100;
  }
  // Back to the recorder to press Stop, the trailing bracket every session has.
  events.push(event(9000, "focus_change", RECORDER));
  events.push(event(9100, "url_change", { url: "http://localhost:5173/" }));
  return { sessionId, startedAt, events };
}

const input = (sessions: KnowledgeSession[]): KnowledgeInput => ({
  sessions,
  isExcluded,
  excludedApps: ["Electron", "com.github.Electron"],
});

/** One fact by kind. Throws rather than returning undefined: a missing fact is a
 * failure of the projection, and an assertion on `undefined.values` reads as a
 * broken test instead. */
const factOf = (dto: KnowledgeDTO, kind: string): KnowledgeFactDTO => {
  const fact = dto.facts.find((f) => f.kind === kind);
  if (fact === undefined) throw new Error(`no fact ${kind}`);
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
    expect(factOf(dto, "display_change").values[0]!.observations).toBe(3);
    expect(factOf(dto, "keymap_change").values[0]!.observations).toBe(3);
  });

  it("drops a FOCUSED-APP fact's recorder observations", () => {
    // The trailing `localhost:5173` of each recording belongs to the recorder,
    // and on the real library that one site was the most-visited of all.
    const dto = knowledgeView(input(library()));
    const sites = factOf(dto, "url_change");
    expect(sites.values.map((v) => v.label)).not.toContain("localhost:5173");
    expect(dto.excludedEvents).toBeGreaterThan(0);
  });

  it("keeps the applications that are actually worked in", () => {
    const dto = knowledgeView(input(library()));
    const apps = factOf(dto, "focus_change");
    expect(apps.values.map((v) => v.label)).toEqual(["com.google.Chrome"]);
  });

  it("declares which side of that split each fact is on", () => {
    // The DTO carries it because a CARD has to be able to say the exclusion does
    // not apply to it — otherwise the screen states two display setups and
    // cannot explain why the recorder did not cost it one.
    const byKind = Object.fromEntries(FACTS.map((f) => [f.kind, f.attribution]));
    expect(byKind).toEqual({
      keymap_change: "ambient",
      display_change: "ambient",
      focus_change: "focused-app",
      url_change: "focused-app",
    });
  });
});

describe("the fold", () => {
  it("collapses the ids macOS re-mints and discloses how many it collapsed", () => {
    const dto = knowledgeView(input(library()));
    const displays = factOf(dto, "display_change");
    expect(displays.values).toHaveLength(1);
    expect(displays.values[0]!.label).toBe("1920×1080 @2× primary");
    // THREE payloads, one value — the claim the whole cycle rests on, and the
    // count is what makes it checkable rather than asserted.
    expect(displays.values[0]!.variants).toBe(3);
  });

  it("keeps a genuinely different configuration apart", () => {
    const docked = session("s4", 4_000_000, { displayId: "219", width: 3840 });
    const dto = knowledgeView(input([...library(), docked]));
    expect(factOf(dto, "display_change").values).toHaveLength(2);
  });

  it("counts what the identity could not place, and never drops it", () => {
    // `chrome://new-tab-page/` names no site. Three of 44 real observations are
    // that, and reporting 41 with no disclosure would invent a corpus.
    const s = session("s1", 1_000_000, { displayId: "180", urls: ["chrome://new-tab-page/"] });
    const dto = knowledgeView(input([s]));
    const sites = factOf(dto, "url_change");
    expect(sites.values).toHaveLength(0);
    expect(sites.unidentified).toBe(1);
  });

  it("renders a value's label ONCE, so both faces are byte-identical", () => {
    const dto = knowledgeView(input(library()));
    const detail = knowledgeFacts(input(library())).find((f) => f.kind === "display_change")!;
    expect(detail.values[0]!.label).toBe(factOf(dto, "display_change").values[0]!.label);
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
    const layout = factOf(dto, "keymap_change");
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
    const layout = factOf(dto, "keymap_change");
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
    for (const kind of ["display_change", "focus_change", "url_change"]) {
      const fact = factOf(dto, kind);
      expect(fact.current, kind).toBeNull();
      expect(fact.reason, kind).toMatch(/all be true at once/);
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
    expect(factOf(dto, "url_change").values).toHaveLength(1);
  });

  it("says so when nothing has been recorded", () => {
    const dto = knowledgeView(input([]));
    expect(dto.recordings).toBe(0);
    for (const fact of dto.facts) {
      expect(fact.values, fact.kind).toHaveLength(0);
      expect(fact.reason, fact.kind).toMatch(/Nothing has been observed/);
    }
  });
});

describe("labels", () => {
  it("renders a display in its own sorted order, joined", () => {
    expect(
      displayLabel([
        [0, 0, 3840, 2160, 1, false],
        [0, 0, 1728, 1117, 2, true],
      ]),
    ).toBe("3840×2160 @1× + 1728×1117 @2× primary");
  });

  it("never lets the keymap's seventy entries reach a consumer", () => {
    // The reason `keymap_change` has an identity at all: the fold count is 1
    // either way, but a projection decides what a consumer SEES.
    const detail = knowledgeFacts(input(library()))[0]!;
    expect(detail.kind).toBe("keymap_change");
    expect(detail.values[0]!.variants.join("")).not.toMatch(/entries/);
  });
});
