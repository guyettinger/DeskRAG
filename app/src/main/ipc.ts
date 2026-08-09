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
import { checkAll, request, openSettings } from "./permissions.js";
import { envInfo } from "./env.js";

export function registerIpc(
  service: DeskRagService,
  settings: SettingsStore,
  getWindow: () => BrowserWindow | null,
  resetApp: () => Promise<void>,
): void {
  const send = (channel: string, payload: unknown): void => {
    getWindow()?.webContents.send(channel, payload);
  };
  service.onState((s) => send(IPC.recordingStateEvent, s));
  service.onIndexing((p) => send(IPC.recordingIndexingEvent, p));
  service.onModelDownload((p) => send(IPC.modelDownloadEvent, p));

  ipcMain.handle(IPC.settingsGet, () => settings.view());
  ipcMain.handle(IPC.settingsSet, (_e, patch: SettingsPatch) => settings.apply(patch));
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
  ipcMain.handle(IPC.sessionsReindex, () => service.reindexTraces());
  ipcMain.handle(IPC.sessionsReindexSearch, () => service.reindexSearch());
  ipcMain.handle(IPC.sessionsTracks, (_e, sessionId: string) => service.sessionTracks(sessionId));

  /**
   * The Flows screen, in one read-only call. There is deliberately no watch, no
   * start, and no arm: the executor still exists in the library but nothing in
   * the app can reach it, which is what keeps `ax-exec` unspawned.
   */
  ipcMain.handle(IPC.flowsGraph, () => service.flows());

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
