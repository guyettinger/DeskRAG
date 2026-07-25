/**
 * Print an ONNX model's input/output names, types, and dims.
 *
 * Used to pin the I/O contract of a community-produced export before writing an
 * adapter against it — guessing the names produces a plausible adapter that only
 * fails at runtime.
 *
 *   node scripts/inspect-onnx.mjs <model.onnx>
 */
import ort from "onnxruntime-node";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/inspect-onnx.mjs <model.onnx>");
  process.exit(1);
}

const started = Date.now();
const session = await ort.InferenceSession.create(path, {
  executionProviders: ["cpu"],
});
console.log(`loaded in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

const describe = (names, metadata) => {
  for (const name of names) {
    const m = metadata?.[name] ?? metadata?.get?.(name);
    console.log(`  ${name}`);
    if (m) console.log(`      ${JSON.stringify(m)}`);
  }
};

console.log("INPUTS:");
describe(session.inputNames, session.inputMetadata);
console.log("\nOUTPUTS:");
describe(session.outputNames, session.outputMetadata);
