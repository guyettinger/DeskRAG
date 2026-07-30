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
// session.addProducer(new FfmpegScreenProducer({ input: "1", fps: 1 }));
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
