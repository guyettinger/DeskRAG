/**
 * Registers all ipcMain handlers, bridging renderer calls to the service,
 * settings, and permissions. Recording state + indexing progress are pushed to
 * the renderer via webContents.send on the event channels.
 */

import { ipcMain, type BrowserWindow } from "electron";
import { IPC, type PermissionKind, type SearchInput, type SettingsPatch } from "@shared/types";
import type { DeskRagService } from "./deskrag-service.js";
import type { SettingsStore } from "./settings.js";
import { checkAll, request, openSettings } from "./permissions.js";
import { envInfo } from "./env.js";

export function registerIpc(
  service: DeskRagService,
  settings: SettingsStore,
  getWindow: () => BrowserWindow | null,
): void {
  const send = (channel: string, payload: unknown): void => {
    getWindow()?.webContents.send(channel, payload);
  };
  service.onState((s) => send(IPC.recordingStateEvent, s));
  service.onIndexing((p) => send(IPC.recordingIndexingEvent, p));

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
  ipcMain.handle(IPC.systemEnv, () => envInfo(service));
}
