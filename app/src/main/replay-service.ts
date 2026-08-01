/**
 * The single owner of replay in the app: the ax-exec sidecar's lifetime, the
 * location poller, and the run.
 *
 * WHY THE POLLER USES ax-exec. `locateNode` needs an `app` predicate — nearly
 * every node carries one and cannot verify without it — and `ax-dump` reports no
 * app or window. `ax-exec`'s `dump` reports both in ONE call. Sourcing the tree
 * and the app name separately is the pattern the IR spec rejected by name: it is
 * what made boundary snapshots describe the previous application.
 *
 * The cost, stated rather than buried: a binary capable of clicking is alive
 * whenever the Replay screen is open, not only during an armed run. Its lifetime
 * is exactly `watch()`, it still gates on AXIsProcessTrusted() and still refuses
 * to start without --plan, and nothing posts outside executePlan.
 */

import { AxExecSidecar, executeRun, locateNode, predicatesOf, SwiftKeymapSource } from "deskrag";
import type { AxObservation, Graph, Plan, RunOutcome } from "deskrag";
import type {
  GraphDTO,
  LocationDTO,
  ReplayArmInput,
  ReplayStartInput,
  ReplayStopReason,
  RunEventDTO,
} from "@shared/types";
import { toGraphDTO, toPlanDTO } from "./plan-view.js";

const POLL_MS = 2000;

/**
 * How DeskRAG names itself to the AX layer. `AxObservation.app` is the
 * `localizedName`, which is the app's display name — "Electron" in dev, since
 * that is what an unpackaged Electron reports.
 */
const SELF_NAMES: ReadonlySet<string> = new Set(["DeskRAG", "Electron"]);

/** The app a node claims to be in, if it claims one. */
function appPredicateOf(graph: Graph, nodeId: string): string | undefined {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const value = node?.predicates.find((p) => p.kind === "app")?.args["app"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class ReplayService {
  private sidecar: AxExecSidecar | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastForeign: { at: number; location: LocationDTO } | null = null;
  private readonly locationCbs = new Set<(l: LocationDTO) => void>();
  private readonly eventCbs = new Set<(e: RunEventDTO) => void>();
  private running = false;
  /** Resolves the pending `arm` promise. Non-null only while a review is open. */
  private pendingArm: ((decision: { approve: boolean; override: boolean }) => void) | null = null;
  private override = false;
  /** Distinguishes the two things executeRun reports as "declined". */
  private stopReason: ReplayStopReason | null = null;
  private stopDetail: string | undefined;

  constructor(private readonly getGraph: () => Graph | undefined) {}

  graph(): GraphDTO | null {
    const g = this.getGraph();
    return g === undefined ? null : toGraphDTO(g);
  }

  onLocation(cb: (l: LocationDTO) => void): () => void {
    this.locationCbs.add(cb);
    return () => this.locationCbs.delete(cb);
  }

  onEvent(cb: (e: RunEventDTO) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  private emitEvent(e: RunEventDTO): void {
    for (const cb of this.eventCbs) cb(e);
  }

  /** The screen being open is the whole of the sidecar's liveness condition. */
  watch(on: boolean): void {
    if (on) {
      this.ensureSidecar();
      if (this.timer === null) {
        this.timer = setInterval(() => void this.poll(), POLL_MS);
        void this.poll();
      }
      return;
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Leaving the screen must not kill a run that is mid-flight; the run's own
    // `finally` is what ends it.
    if (!this.running) this.closeSidecar();
  }

  close(): void {
    this.watch(false);
    this.locationCbs.clear();
    this.eventCbs.clear();
  }

  private ensureSidecar(): AxExecSidecar {
    if (this.sidecar === null) {
      this.sidecar = AxExecSidecar.spawn({
        planId: `deskrag-app-${Date.now()}`,
        ...(process.env["ERAG_AX_EXEC_BIN"] !== undefined
          ? { binaryPath: process.env["ERAG_AX_EXEC_BIN"] }
          : {}),
      });
    }
    return this.sidecar;
  }

  private closeSidecar(): void {
    this.sidecar?.close();
    this.sidecar = null;
  }

  private emit(l: LocationDTO): void {
    for (const cb of this.locationCbs) cb(l);
  }

  /**
   * WHEN DESKRAG IS FRONTMOST, THE OBSERVATION DESCRIBES THE REVIEWER.
   * Discard it and re-emit the last FOREIGN reading with its age. Without this
   * the indicator reads "no match" permanently, because looking at it is what
   * breaks it — and with it the workflow works the way a user expects: get the
   * target into the state you want, switch back, and the canvas still shows it.
   */
  private async poll(): Promise<void> {
    let observation: AxObservation;
    try {
      observation = await this.ensureSidecar().dump();
    } catch {
      // A dead sidecar must not kill the poller: drop it and try again next tick.
      this.closeSidecar();
      return;
    }

    if (observation.app !== undefined && SELF_NAMES.has(observation.app)) {
      const last = this.lastForeign;
      this.emit(
        last === null
          ? { candidates: 0, ambiguous: false, staleMs: 0 }
          : { ...last.location, staleMs: Date.now() - last.at },
      );
      return;
    }

    const location = this.locate(observation);
    this.lastForeign = { at: Date.now(), location };
    this.emit(location);
  }

  private locate(observation: AxObservation): LocationDTO {
    const graph = this.getGraph();
    const located =
      graph === undefined
        ? { nodeId: undefined, candidates: 0, ambiguous: false }
        : locateNode(predicatesOf(observation), graph.nodes);
    return {
      ...(located.nodeId !== undefined ? { nodeId: located.nodeId } : {}),
      candidates: located.candidates,
      ambiguous: located.ambiguous,
      ...(observation.app !== undefined ? { app: observation.app } : {}),
      ...(observation.windowTitle !== undefined ? { window: observation.windowTitle } : {}),
    };
  }

  /**
   * `hideWindow` is injected rather than imported so this class never touches
   * Electron — the same reason `Actuator` is injected into `replay/`.
   */
  async start(input: ReplayStartInput, hideWindow: () => void): Promise<void> {
    if (this.running) return;
    const graph = this.getGraph();
    if (graph === undefined) {
      this.emitEvent({ type: "stopped", reached: false, reason: "no-path", detail: "no graph" });
      return;
    }

    // The layout to type through. No fallback: typing text against a layout
    // other than the one it was lifted from is silently wrong text, which is
    // exactly what the capture spec rejected a static table to avoid.
    const keymap = await new SwiftKeymapSource().query();

    this.running = true;
    this.stopReason = null;
    this.stopDetail = undefined;
    // The poller must not compete with the run for the sidecar's turn-taking.
    this.pausePolling();

    let segment = 0;
    // The brittleness override is decided per segment, INSIDE `arm` — so it
    // cannot be a snapshot value on this object. `run.ts` reads `input.override`
    // fresh on each turn, so a getter over a closure variable is what makes a
    // decision taken in segment N actually reach segment N's execution. Passing
    // `override: this.override` would evaluate once, before any review, and the
    // tick would silently do nothing.
    let override = false;
    try {
      const outcome = await executeRun({
        graph,
        actuator: this.ensureSidecar(),
        // Empty layout, not a US-QWERTY guess. `strokesFor` finds no keycode for
        // any character and typing becomes a blocker, which is the intended
        // outcome — same rule as `resolveKeys` at lift time, opposite direction.
        keymap: keymap ?? { layoutId: "", entries: {} },
        goalNodeId: input.goalNodeId,
        ...(input.slotBindings !== undefined ? { slotBindings: input.slotBindings } : {}),
        ...(input.allowLaunch !== undefined ? { allowLaunch: input.allowLaunch } : {}),
        get override(): boolean {
          return override;
        },
        arm: async (plan: Plan) => {
          segment += 1;
          const approved = await this.review(
            plan,
            graph,
            segment,
            hideWindow,
            keymap === undefined,
          );
          override = this.override;
          return approved;
        },
      });
      this.report(outcome);
    } catch (err) {
      this.emitEvent({
        type: "stopped",
        reached: false,
        reason: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.running = false;
      this.pendingArm = null;
      this.resumePolling();
    }
  }

  /**
   * The review gate AND the focus handoff, in that order, inside one callback.
   *
   * This is the whole reason the surface is safe. The reviewer is itself an
   * application: approving means clicking in DeskRAG, which raises its window
   * OVER the target. `app` was met at plan time, so `buildPlan` planned no
   * repair to correct it — execution would post the first click at a coordinate
   * the reviewer's own window now covers.
   *
   * `arm` is async, so everything here completes before `executePlan` posts
   * anything. Approving a plan and then leaving your window over the target is
   * not an approval that means anything.
   */
  private async review(
    plan: Plan,
    graph: Graph,
    segment: number,
    hideWindow: () => void,
    noKeymap: boolean,
  ): Promise<boolean> {
    const handoffApp = appPredicateOf(graph, plan.from);
    const dto = toPlanDTO(plan, graph, segment, handoffApp);
    if (
      noKeymap &&
      plan.steps.some((s) => !("repair" in s) && !("superseded" in s) && s.action.kind === "type")
    ) {
      // Same rule as resolveKeys at lift time, opposite direction: no keymap is
      // a blocker, never a US-QWERTY guess.
      dto.blockers.push({
        reason: "no keyboard layout — typing cannot be replayed",
        scope: "segment",
      });
    }
    this.emitEvent({ type: "segment-planned", plan: dto });

    const decision = await new Promise<{ approve: boolean; override: boolean }>((resolve) => {
      this.pendingArm = resolve;
    });
    this.pendingArm = null;
    if (!decision.approve) {
      this.stopReason = "cancelled";
      return false;
    }
    this.override = decision.override;

    hideWindow();
    this.emitEvent({
      type: "armed",
      segment,
      ...(handoffApp !== undefined ? { app: handoffApp } : {}),
    });
    if (handoffApp === undefined) return true;

    const restored = await this.restoreFocus(handoffApp);
    if (!restored) {
      this.stopReason = "handoff-failed";
      this.stopDetail = handoffApp;
      return false;
    }
    return true;
  }

  /**
   * Raise the target and CONFIRM it, by polling the predicate rather than
   * sleeping — the same rule execute.ts already follows for activation.
   * `launch` is false: a handoff restores a state the plan was reviewed
   * against, and starting an application is not that.
   *
   * A failed handoff stops the run. It must never become a click posted into
   * the reviewer.
   */
  private async restoreFocus(app: string, timeoutMs = 3000): Promise<boolean> {
    const sidecar = this.ensureSidecar();
    try {
      const outcome = await sidecar.activate(app, false);
      if (outcome === "not-running") return false;
    } catch {
      return false;
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if ((await sidecar.dump()).app === app) return true;
      } catch {
        return false;
      }
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private report(outcome: RunOutcome): void {
    const last = outcome.segments[outcome.segments.length - 1];
    if (last !== undefined) {
      this.emitEvent({
        type: "segment-done",
        segment: outcome.segments.length,
        completed: last.outcome.completed,
        ...(last.outcome.failure !== undefined ? { failure: last.outcome.failure } : {}),
        telemetry: last.outcome.telemetry.map((t) => ({
          edgeId: t.edgeId,
          layer: t.layer,
          confidence: t.confidence,
        })),
      });
    }
    // executeRun reports every false `arm` as "declined". Which one it was is
    // known here and nowhere else.
    const reason: ReplayStopReason | undefined =
      outcome.stopped === "declined"
        ? (this.stopReason ?? "cancelled")
        : outcome.stopped === undefined
          ? undefined
          : outcome.stopped;
    this.emitEvent({
      type: "stopped",
      reached: outcome.reached,
      ...(reason !== undefined ? { reason } : {}),
      ...(this.stopDetail !== undefined ? { detail: this.stopDetail } : {}),
    });
  }

  arm(input: ReplayArmInput): void {
    this.pendingArm?.({ approve: input.approve, override: input.override ?? false });
  }

  cancel(): void {
    this.pendingArm?.({ approve: false, override: false });
  }

  private pausePolling(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private resumePolling(): void {
    if (this.timer === null && this.sidecar !== null) {
      this.timer = setInterval(() => void this.poll(), POLL_MS);
    }
  }
}
