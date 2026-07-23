/**
 * Preload — exposes a typed, minimal DeskRagApi on window.deskrag. All heavy work
 * happens in main; this is a thin invoke/subscribe bridge. Context isolation is
 * on, so the renderer only ever sees these functions.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type DeskRagApi,
  type IndexingProgress,
  type PermissionKind,
  type RecordingStatus,
  type SearchInput,
  type SettingsPatch,
} from "@shared/types";

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: DeskRagApi = {
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: SettingsPatch) => ipcRenderer.invoke(IPC.settingsSet, patch),
    capabilities: () => ipcRenderer.invoke(IPC.settingsCapabilities),
  },
  permissions: {
    check: () => ipcRenderer.invoke(IPC.permissionsCheck),
    request: (kind: PermissionKind) => ipcRenderer.invoke(IPC.permissionsRequest, kind),
    openSettings: (kind: PermissionKind) => ipcRenderer.invoke(IPC.permissionsOpenSettings, kind),
  },
  recording: {
    start: () => ipcRenderer.invoke(IPC.recordingStart),
    stop: () => ipcRenderer.invoke(IPC.recordingStop),
    status: () => ipcRenderer.invoke(IPC.recordingStatus),
    onState: (cb: (s: RecordingStatus) => void) => subscribe(IPC.recordingStateEvent, cb),
    onIndexing: (cb: (p: IndexingProgress) => void) => subscribe(IPC.recordingIndexingEvent, cb),
  },
  search: {
    query: (input: SearchInput) => ipcRenderer.invoke(IPC.searchQuery, input),
    detail: (frameId: string) => ipcRenderer.invoke(IPC.searchDetail, frameId),
  },
  sessions: {
    list: () => ipcRenderer.invoke(IPC.sessionsList),
  },
  system: {
    env: () => ipcRenderer.invoke(IPC.systemEnv),
  },
};

contextBridge.exposeInMainWorld("deskrag", api);
