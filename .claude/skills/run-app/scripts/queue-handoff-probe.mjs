/**
 * The one thing the suite structurally cannot check: that a recording can start
 * WHILE the last one indexes, and that indexing yields to it.
 *
 * `nextRunnable` is unit-tested and pure, so it proves the RULE. It cannot prove
 * the rule is wired to anything — that `isRecording()` reaches the gate, that
 * the record button is really live, that the pause reaches the screen. Only
 * driving the app answers those, which is the same reason the AX role prefix and
 * the silent microphone both shipped.
 *
 * THIS RECORDS THE SCREEN, twice, for a few seconds each. The recordings land in
 * the real library and index normally afterwards.
 */
import { launchApp, gotoScreen } from "./launch.mjs";

const out = (label, value) => console.log(`${String(label).padEnd(44)} ${value}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a condition over the IPC surface.
 *
 * NOT `page.waitForFunction(async () => ...)`. An async predicate returns a
 * PROMISE, which is always truthy, so the wait resolves on its first tick and
 * the probe samples before anything has happened — it reported "no job was
 * enqueued" against a store that had one moments later. Every wait here is
 * driven from node, where `await` means what it says.
 */
async function until(fn, { timeout = 60_000, every = 250, what = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(every);
  }
}

const queueState = (page) =>
  page.evaluate(async () => {
    const q = await window.deskrag.indexing.queue();
    return {
      running: q.runningJobId,
      held: q.held,
      heldMessage: q.heldMessage,
      jobs: q.jobs.map((j) => ({ id: j.id, kind: j.kind, state: j.state, done: j.done, total: j.total })),
    };
  });

const recState = (page) => page.evaluate(() => window.deskrag.recording.status());

const { app, page } = await launchApp();
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  out(`${ok ? "PASS" : "FAIL"}  ${name}`, detail);
};

try {
  await gotoScreen(page, "Record");
  await page.waitForSelector(".recbtn", { timeout: 20_000 });

  const before = await queueState(page);
  out("jobs already in the queue", before.jobs.length);

  // --- 1. record, briefly ---------------------------------------------------
  console.log("\n=== recording #1 ===");
  await page.click(".recbtn");
  await page.waitForFunction(() => document.querySelector(".recbtn.is-live") !== null, {
    timeout: 20_000,
  });
  check("recording started", (await recState(page)).state === "recording");
  // Away from the Record screen: its readout displays MILLISECONDS, so leaving
  // it on screen changes every sampled frame and defeats keyframe decimation.
  await gotoScreen(page, "Indexing");
  await sleep(7000);

  // --- 2. stop, and the button must come back IMMEDIATELY -------------------
  console.log("\n=== stop #1 ===");
  const t0 = Date.now();
  await gotoScreen(page, "Record");
  await page.click(".recbtn.is-live");
  await page.waitForFunction(() => document.querySelector(".recbtn.is-live") === null, {
    timeout: 30_000,
  });
  const stopMs = Date.now() - t0;
  // The old code awaited the WHOLE pipeline inside this call — minutes.
  out("stop -> idle", `${stopMs}ms`);
  check("stop returns without waiting for indexing", stopMs < 15_000, `${stopMs}ms`);
  check(
    "record button live again immediately",
    !(await page.evaluate(() => document.querySelector(".recbtn")?.hasAttribute("disabled"))),
  );
  check("recording state is idle, not 'indexing'", (await recState(page)).state === "idle");

  // --- 3. a job appeared ----------------------------------------------------
  await until(
    async () => (await queueState(page)).jobs.some((j) => !before.jobs.some((b) => b.id === j.id)),
    { timeout: 30_000, what: "a new job" },
  );
  const q1 = await queueState(page);
  const fresh = q1.jobs.filter((j) => !before.jobs.some((b) => b.id === j.id));
  out("new jobs", JSON.stringify(fresh.map((j) => `${j.kind}/${j.state}`)));
  check("a record job was enqueued on stop", fresh.length === 1 && fresh[0].kind === "record");

  // Wait for it to actually be running, so the pause has something to pause.
  const picked = await until(async () => (await queueState(page)).running !== null, {
    timeout: 60_000,
    what: "the worker to claim it",
  });
  check("the worker picked it up", picked, picked ? "" : "still queued after 60s");

  // --- 4. THE POINT: record again while it indexes --------------------------
  console.log("\n=== recording #2, while #1 indexes ===");
  await page.click(".recbtn");
  await page.waitForFunction(() => document.querySelector(".recbtn.is-live") !== null, {
    timeout: 20_000,
  });
  check("a SECOND recording started while indexing", (await recState(page)).state === "recording");

  // The gate polls every 500ms and holds between stages, so give it a beat.
  await gotoScreen(page, "Indexing");
  await until(async () => (await queueState(page)).held === "recording", {
    timeout: 30_000,
    what: "the queue to hold",
  });
  const held = await queueState(page);
  const banner = await page.evaluate(
    () => document.querySelector(".jobs .banner")?.textContent?.trim() ?? null,
  );
  out("queue.held", held.held);
  out("banner on screen", banner ?? "(none)");
  check("the queue reports it is holding for the recording", held.held === "recording");
  check("the screen SAYS so", (banner ?? "").toLowerCase().includes("recording"));
  // NOT "no job is running". The gate is checked BETWEEN stages and the slowest
  // stage measured 14m 16s, so a stage already in flight keeps running — what
  // must be true is that the screen says which of the two situations this is.
  check(
    held.running === null
      ? "with nothing mid-stage, the screen says it is paused"
      : "with a stage mid-flight, the screen says it pauses after it",
    held.running === null
      ? /^paused/i.test(banner ?? "")
      : /current stage/i.test(banner ?? ""),
    banner ?? "(none)",
  );

  await sleep(4000);

  // --- 5. stop #2, and the hold releases ------------------------------------
  console.log("\n=== stop #2 ===");
  await gotoScreen(page, "Record");
  await page.click(".recbtn.is-live");
  await page.waitForFunction(() => document.querySelector(".recbtn.is-live") === null, {
    timeout: 30_000,
  });
  // The gate polls every 500ms, so the release is not instantaneous.
  await until(async () => (await queueState(page)).held !== "recording", {
    timeout: 30_000,
    what: "the hold to release",
  });
  const after = await queueState(page);
  out("queue after both stops", JSON.stringify(after.jobs.map((j) => `${j.kind}/${j.state}`)));
  check("the hold released once recording stopped", after.held !== "recording");

  await gotoScreen(page, "Indexing");
  await page.screenshot({ path: process.env["SHOT"] ?? "/tmp/queue-handoff.png" });
  console.log(`\nscreenshot -> ${process.env["SHOT"] ?? "/tmp/queue-handoff.png"}`);

  // Let the tail of stop #2 settle before closing. `stopRecording` returns the
  // UI to idle BEFORE it stamps `ended_at` and enqueues — closing here is what
  // orphaned a real recording the first time this probe ran.
  await until(async () => (await queueState(page)).jobs.length >= before.jobs.length + 2, {
    timeout: 20_000,
    what: "the second job to be enqueued",
  });
  const settled = await queueState(page);
  check("both recordings ended up queued", settled.jobs.length >= before.jobs.length + 2,
    JSON.stringify(settled.jobs.map((j) => `${j.kind}/${j.state}`)));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`} (${results.length} checks)`);
  for (const f of failed) console.log(`  FAIL: ${f.name}`);
} finally {
  await app.close();
}
