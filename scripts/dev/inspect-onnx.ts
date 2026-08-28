/**
 * Print an ONNX model's input/output names, types, and dims.
 *
 * Used to pin the I/O contract of a community-produced export before writing an
 * adapter against it — guessing the names produces a plausible adapter that only
 * fails at runtime.
 *
 *   npm run dev:inspect-onnx -- <model.onnx>
 */
import ort from "onnxruntime-node";

const path = process.argv[2];
if (!path) {
  console.error("usage: npm run dev:inspect-onnx -- <model.onnx>");
  process.exit(1);
}

const started = Date.now();
const session = await ort.InferenceSession.create(path, {
  executionProviders: ["cpu"],
});
console.log(`loaded in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

/**
 * `inputMetadata` is an ARRAY OF ENTRIES, each carrying its own `name` — not a
 * record keyed by name. This script indexed it as `metadata[name]` and so
 * printed every name with no metadata under it, silently: the one line worth
 * having (`type` and `shape`) was the line that never appeared. Caught by the
 * typecheck the first time this file was compiled, which is the argument for
 * `scripts/` being TypeScript.
 */
const describe = (
  names: readonly string[],
  metadata: readonly ort.InferenceSession.ValueMetadata[],
): void => {
  for (const name of names) {
    const m = metadata.find((e) => e.name === name);
    console.log(`  ${name}`);
    if (m !== undefined) {
      console.log(
        m.isTensor
          ? `      ${m.type} [${m.shape.join(", ")}]`
          : "      (not a tensor)",
      );
    }
  }
};

console.log("INPUTS:");
describe(session.inputNames, session.inputMetadata);
console.log("\nOUTPUTS:");
describe(session.outputNames, session.outputMetadata);
