# ColSmol continuation prompt

**Date:** 2026-07-26
**Purpose:** Hand-off prompt for resuming the ColSmol publish work in a fresh
session. Paste the fenced block below as the opening message.

It deliberately points at the plan and the commit messages rather than
restating them, and front-loads the failure modes that cost the previous
session several hours. Update the STATE and REMAINING sections as tasks land.

---

```
Continue the ColSmol work in /Users/guyettinger/Projects/DeskRAG,
branch feat/local-ai-providers.

READ FIRST:
- docs/superpowers/plans/2026-07-25-colsmol-publish.md  (the plan; follow it)
- docs/superpowers/specs/2026-07-25-colsmol-publish-design.md  (why)
- git log 915837e 6978f39  (the OOM fix; messages explain the non-obvious parts)

STATE
The dynamic-tile ColSmol ONNX export is BUILT and VALIDATED, staged at
~/Library/Application Support/deskrag-app/DeskRAG/models/colSmol-256M-dynamic/
(model.onnx + 4 JSONs + README.md model card). Validation passed: tile counts
7/13/5/1 all accepted, parity vs eager PyTorch min cosine 1.000000. All five
sha256/byte values are already recorded in the plan — do not recompute them.

Two crash fixes are committed and verified end-to-end under Electron:
ONNX inference now runs in a utilityProcess, and enableCpuMemArena is off.
ColSmol is ~18.4s and ~1.3GB peak per frame.

Tasks 0-4 are DONE and committed (350b7f2, 9ad62a3, f23fdcb, 5aa18e4). The
artifact is published at guyettinger/colSmol-256M-dynamic-onnx, pinned in the
manifest at commit SHA 93956db0e440eebd497bc776e7bf34a06830b0c6. All four gates
pass. scripts/e2e-local.mjs passes against the real weights (24.5s, both queries
rank correctly). A real 3.5MB download through ModelStore against the published
repo verified redirect-following, streaming progress and the sha256.

REMAINING — Task 5 steps 3, 4, 5, 7 only. They need the GUI and a real
recording, so they cannot be done headlessly:
  3. npm run build && npm run app:dev; Settings -> Local models -> ColSmol.
     Watch the percentage CLIMB (that is the observable proof Task 1 worked).
  4. Confirm five files, no .partial, model.onnx sha256 cf13ca0c...
  5. Record a short session, Stop, confirm indexing completes.
  7. rm -rf the colSmol-256M-dynamic.bak backup, only after 4-6 pass.
The staged copy has ALREADY been moved to colSmol-256M-dynamic.bak (step 2), so
the app will download. Restore it by renaming back if the download misbehaves.

ALSO UNVERIFIED: the user has not yet confirmed a real recording indexes
cleanly since the crash fixes landed. Confirm that before trusting Task 5.

TRAPS THAT COST THIS SESSION HOURS — DO NOT REPEAT
1. Plain Node's malloc accepts allocations Chromium's PartitionAlloc refuses.
   `npm test`, scripts/e2e-local.mjs and bare-node probes therefore pass while
   the app crashes. Verify ONNX memory behaviour by running the Electron binary,
   not node.
2. Electron needs dangerouslyDisableSandbox to launch from the Bash tool, and
   in an ESM main entry `await app.whenReady()` at top level NEVER resolves —
   use .then(). A probe that hangs is probably the harness, not the code.
3. Always run a differential control: strip the fix back out and confirm the
   failure returns. Two wrong diagnoses this session survived because the
   "verification" would have passed either way.
4. Test fakes must structuredClone if they stand in for postMessage. ORT's
   Tensor.data is a prototype getter and is silently lost across the boundary.

Gates: npm run typecheck && npm test && npm --prefix app run typecheck &&
npm --prefix app run test. The app imports dist/, so npm run build after
library changes.
```

---

## Deliberately out of scope

**An int8 ColSmol export.** It is the real fix for both the ~1.3GB floor and
the ~18.4s per frame, rather than merely accommodating them. But it is a new
export, a new parity budget, and a second artifact in the same HuggingFace
repo — it deserves its own brainstorm rather than being smuggled in as a line
item on a publishing plan.

**The ffmpeg capture warnings** seen during recording (`avfoundation` pixel
format override, `MB rate > level limit`). Pre-existing, capture-side, and
unrelated to indexing. Worth their own look.
