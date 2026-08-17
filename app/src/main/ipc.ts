/**
 * Registers all ipcMain handlers, bridging renderer calls to the service,
 * settings, and permissions. Recording state + indexing progress are pushed to
 * the renderer via webContents.send on the event channels.
 */

import { ipcMain, type BrowserWindow } from "electron";
import {
  IPC,
  type PermissionKind,
  type SearchInput,
  type SettingsPatch,
} from "@shared/types";
import type { DeskRagService } from "./deskrag-service.js";
import type { SettingsStore } from "./settings.js";
import type { McpExperienceServer } from "./mcp/server.js";
import { checkAll, request, openSettings } from "./permissions.js";
import { envInfo } from "./env.js";

export function registerIpc(
  service: DeskRagService,
  settings: SettingsStore,
  getWindow: () => BrowserWindow | null,
  resetApp: () => Promise<void>,
  mcp: McpExperienceServer,
): void {
  const send = (channel: string, payload: unknown): void => {
    getWindow()?.webContents.send(channel, payload);
  };
  service.onState((s) => send(IPC.recordingStateEvent, s));
  // Same split as the two indexing channels: state changes twice per recording,
  // the per-signal counters change every second while one runs.
  service.onRecordingTick((t) => send(IPC.recordingTickEvent, t));
  // Two indexing channels, not one. The snapshot fires on transitions; the tick
  // fires per frame inside the patch stage, and re-serialising the whole queue
  // at that rate would be waste.
  service.onIndexQueue((q) => send(IPC.indexingQueueEvent, q));
  service.onIndexTick((t) => send(IPC.indexingTickEvent, t));
  service.onModelDownload((p) => send(IPC.modelDownloadEvent, p));

  ipcMain.handle(IPC.settingsGet, () => settings.view());
  ipcMain.handle(IPC.settingsSet, async (_e, patch: SettingsPatch) => {
    const view = settings.apply(patch);
    // Only when the MCP half of the patch is present — this fires on every
    // keystroke in every Settings field, and `applySettings` is a no-op unless
    // something it cares about actually changed.
    if (patch.mcp) await mcp.applySettings(view.mcp.enabled, view.mcp.port);
    return view;
  });
  ipcMain.handle(IPC.settingsCapabilities, () => service.capabilities());

  ipcMain.handle(IPC.permissionsCheck, () => checkAll());
  ipcMain.handle(IPC.permissionsRequest, (_e, kind: PermissionKind) => request(kind));
  ipcMain.handle(IPC.permissionsOpenSettings, (_e, kind: PermissionKind) => openSettings(kind));

  ipcMain.handle(IPC.recordingStart, () => service.startRecording());
  ipcMain.handle(IPC.recordingStop, () => service.stopRecording());
  ipcMain.handle(IPC.recordingStatus, () => service.status());

  ipcMain.handle(IPC.searchQuery, (_e, input: SearchInput) => service.search(input));
  ipcMain.handle(IPC.searchDetail, (_e, frameId: string) => service.detail(frameId));

  ipcMain.handle(IPC.sessionsList, () => service.listSessions());
  ipcMain.handle(IPC.sessionsDetail, (_e, sessionId: string) => service.sessionDetail(sessionId));
  ipcMain.handle(IPC.sessionsRemove, (_e, sessionId: string) => service.removeSession(sessionId));
  ipcMain.handle(IPC.sessionsTracks, (_e, sessionId: string) => service.sessionTracks(sessionId));

  // Every one of these ENQUEUES and returns. None runs the pipeline inline, and
  // none refuses because a recording is in progress — that is the whole point of
  // the queue, and it also closes a real hole: `sessions:reindex-all` had no
  // guard here at all, so anything that could invoke it twice ran two library
  // rebuilds over the same recordings. Enqueue is idempotent per kind+session.
  ipcMain.handle(IPC.indexingQueue, () => service.indexQueue());
  ipcMain.handle(IPC.indexingReindexSession, (_e, sessionId: string) =>
    service.reindexSession(sessionId),
  );
  ipcMain.handle(IPC.indexingReindexAll, () => service.reindexAll());
  ipcMain.handle(IPC.indexingRebuildTraces, () => service.rebuildTraces());
  ipcMain.handle(IPC.indexingCancel, (_e, jobId: string) => service.cancelIndexJob(jobId));
  ipcMain.handle(IPC.indexingRetry, (_e, jobId: string) => service.retryIndexJob(jobId));
  ipcMain.handle(IPC.indexingClearFinished, () => service.clearFinishedIndexJobs());

  /**
   * The Flows screen, in one read-only call. There is deliberately no watch, no
   * start, and no arm: the executor still exists in the library but nothing in
   * the app can reach it, which is what keeps `ax-exec` unspawned.
   */
  ipcMain.handle(IPC.flowsGraph, () => service.flows());

  /**
   * The MCP endpoint, reported to the window that hosts its settings.
   *
   * Read-only in this direction too: there is no channel that invokes a tool.
   * The renderer watches what agents have asked — the activity log is the gate
   * on an endpoint that carries no token — and can start, stop or move the
   * listener only through the settings above.
   */
  ipcMain.handle(IPC.mcpStatus, () => mcp.status(settings.view().mcp.enabled));
  ipcMain.handle(IPC.mcpLog, () => mcp.entries());

  /**
   * Vision-capable models resident on this machine. Sourced from Ollama's
   * /api/tags rather than a hardcoded list: its library now includes
   * cloud-hosted entries, and offering one in a "local" picker would route
   * screenshots off the device. Only names cross the bridge.
   */
  ipcMain.handle(IPC.ollamaVisionModels, async (): Promise<string[]> => {
    const { listVisionModels } = await import("deskrag");
    return listVisionModels(settings.view().providers.ollamaHost);
  });

  /** Chat-capable models — the ones that can compose and name levels. */
  ipcMain.handle(IPC.ollamaChatModels, async (): Promise<string[]> => {
    const { listSummaryModels } = await import("deskrag");
    return listSummaryModels(settings.view().providers.ollamaHost);
  });

  ipcMain.handle(IPC.systemEnv, () => envInfo(service));
  ipcMain.handle(IPC.systemReset, () => resetApp());
}
