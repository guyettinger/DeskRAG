# Library usage

The pipeline composes explicit stages. Retrieval is a single call over the capstone
`Retriever`; capture is a `CaptureSession` you attach signal producers to.

```ts
import {
  DualStore, BlobStore,
  CaptureSession, KeyframeGate,
  Segmenter, Representer, FrameRepresenter,
  Retriever, TextViewSearcher, BehaviorViewSearcher,
  FakeEmbeddingProvider, BehaviorFeatureExtractor,
} from "deskrag";

const store = await DualStore.open("meta.sqlite", "lancedb");
const blobs = new BlobStore("blobs");

// --- record ---------------------------------------------------------------
// Real producers are imported from their own paths (native / subprocess):
//   ./capture/producers/uiohook-input, /active-window, /ffmpeg-screen
//   ./capture/ax/swift-ax-source  (+ new StoredAxProvider(store).provide for regions)
const session = new CaptureSession(store, { blobStore: blobs, keyframeGate: new KeyframeGate() });
// session.addProducer(new UiohookInputProducer());
// session.addProducer(new ActiveWindowProducer());
// session.addProducer(new FfmpegScreenProducer({ fps: 1 })); // input: auto-detected display
const sessionId = await session.start();
// ... user works ...
await session.stop();

// --- represent ------------------------------------------------------------
const embed = new FakeEmbeddingProvider();            // swap for OllamaTextEmbedding / OnnxTextEmbedding
await new Segmenter(store).segment(sessionId);
await new Representer(store, { digestEmbedder: embed, behavior: new BehaviorFeatureExtractor() }).represent(sessionId);
await new FrameRepresenter(store, { imageEmbedder: embed, blobStore: blobs }).represent(sessionId);

// --- recall ---------------------------------------------------------------
const retriever = new Retriever(store, {
  searchers: [new TextViewSearcher(embed, "digest"), new BehaviorViewSearcher(new BehaviorFeatureExtractor())],
  imageEmbedder: embed,
});
const result = await retriever.retrieve({ text: "debugging the auth dialog" /*, image, behavior */ });
for (const frame of result.frames) {
  console.log(frame.score, frame.segmentId, frame.highlights.map((h) => h.label)); // region bboxes + labels
}
```

## Trace and replay

The same session can be lifted into an executable graph instead of recalled. `trace/`
and `replay/` are **leaves** — they never import `store/`, so the world reaches them
through injected callbacks, and the caller binds those to whatever it has.

```ts
import { liftTrace, mergeTrace, executeRun, AxExecSidecar } from "deskrag";

// --- lift + merge ---------------------------------------------------------
// The environment callbacks (keymapAt, displayIdAt, windowBoundsAt) all resolve
// "latest at-or-before this t_mono" from the session's own event stream — which
// is why layout and display topology are recorded as events, not read as config.
const trace = liftTrace({
  sessionId,
  events,
  endTMono,
  axAt,             // prefer the walk taken FOR a boundary over the nearest one
  regionsAt,
  keymapAt,
  displayIdAt,
  windowBoundsAt,
});
const graph = await mergeTrace(existingGraph, trace);  // every session → ONE graph

// --- plan + run -----------------------------------------------------------
// The ONLY thing here that can act — and it refuses to start without a plan id,
// so a bare invocation is inert.
const sidecar = AxExecSidecar.spawn({ planId });
const outcome = await executeRun({
  graph,
  goalNodeId,
  actuator: sidecar,
  keymap,                                         // required: no fallback layout, ever
  slotBindings: { query: "auth dialog" },
  // The review gate. `replay/` never decides to act — return false and nothing
  // is posted. This is where a UI (or, later, a model) approves a segment.
  arm: async (plan) => await reviewSomehow(plan),
});
```

- **`keymap` is not optional and is never defaulted.** The lift resolved keycode →
  character against a captured layout; typing through a different one is silently
  wrong text. Text the layout cannot produce is a *blocker*, not a guess.
- **`executeRun` loops observe → locate → plan → arm → execute**, re-planning at each
  segment because a plan stops where anchor resolution stops working. `arm` is called
  once per segment, so approval is per segment and never blanket.
- **Merging into one graph is the point.** A second recording of the same task
  branches it or fills a slot; a fresh graph per session would produce disconnected
  chains that never discover a variable. `mergeTrace` seeds a *new* graph's id from
  the session it lifted, so pin the id on write if you want one graph per install.

## Things worth knowing

- **Producers never touch the store**, including for files they write themselves. A
  producer whose subprocess writes directly to disk calls `ctx.reserveBlob(media, codec)`
  before spawning and `ctx.commitBlob(blobId, { tMonoStart, tMonoEnd })` after it exits.
- **`searchSegments` throws on an unregistered namespace**, so a `Retriever` must only
  be given `TextViewSearcher`s whose namespace appears in `store.listVectorSpaces()`.
  Caption/transcript spaces don't exist until something has been indexed with those
  providers. `BehaviorViewSearcher` is always safe — it returns null without a
  behavior vector.
- **Deleting a recording is two calls, in order:** `store.deleteSession(id)` then
  `blobs.removeSession(id)`. The store records where blobs are; it does not own the
  files. Rows first — a row pointing at a deleted file is a broken read, whereas a
  file with no row is just reclaimable disk.

## The test suite is the executable documentation

Each of these demonstrates a slice end to end:

| Test | Demonstrates |
|---|---|
| `test/assemble.test.ts` | full capture → retrieve |
| `test/tier2.test.ts`, `test/tier3.test.ts` | scoped retrieval + highlights |
| `test/dual-store.crash.test.ts` | crash recovery across the two engines |
| `test/ax.test.ts` | the accessibility pipeline |

Prefer running the relevant test file over reasoning about correctness — the suite is
fast and deterministic.
