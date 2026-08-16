# Internals

The measured detail behind DeskRAG's invariants — one file per subsystem, written
for someone about to change the code.

`CLAUDE.md` at the repo root states each rule in a sentence and points here. These
files carry **the measurement that produced the rule**, which is the part you need
before you change anything: most were paid for twice, and several were invisible to
`npm test` and only found by driving a real recording.

| file | covers |
| --- | --- |
| [capture.md](./capture.md) | the ffmpeg producers, the device-clock bridge, keyframe decimation, AX walks, where `action` cuts |
| [represent-and-retrieve.md](./represent-and-retrieve.md) | the six views, region proposal, the frame↔segment link, RRF, evidence lanes, FTS |
| [hierarchy.md](./hierarchy.md) | the fixed Action → Task → Process → Session ladder, and every prompt measurement taken against it |
| [trace-and-replay.md](./trace-and-replay.md) | Trace IR, node identity, the anchor ladder, and the executor |
| [models.md](./models.md) | local providers, the barrel rule, ONNX tiling, patch-highlight geometry |
| [app-main.md](./app-main.md) | the process boundary, the indexing pipeline table, re-indexing, whisper, packaging, MCP |
| [app-ui.md](./app-ui.md) | the Library player, the track rail, Flows, and the one global stylesheet |

## How to read a claim here

Every number is a measurement from a real recording or a real run, not an estimate.
Where a rule reverses an earlier one, both are kept and the reversal says why — the
history is the argument. If a measurement looks wrong, **re-measure it** (most have a
committed probe: `npm run probe:latency`, `probe:decimate`, `probe:highlight`,
`probe:patchgeom`, `probe:mcp`) rather than reasoning about the code.

For the design reasoning behind a subsystem, see the specs in
[../superpowers/specs/](../superpowers/specs/). For the user-facing picture, start at
[../architecture.md](../architecture.md).
