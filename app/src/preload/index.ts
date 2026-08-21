/**
 * Preload — exposes a typed, minimal DeskRagApi on window.deskrag. All heavy work
 * happens in main; this is a thin invoke/subscribe bridge. Context isolation is
 * on, so the renderer only ever sees these functions.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type DeskRagApi,
  type IndexQueueDTO,
  type IndexTickDTO,
  type McpLogEntryDTO,
  type ModelDownloadProgress,
  type PermissionKind,
  type RecordingStatus,
  type RecordingTickDTO,
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
    onTick: (cb: (t: RecordingTickDTO) => void) => subscribe(IPC.recordingTickEvent, cb),
  },
  indexing: {
    queue: () => ipcRenderer.invoke(IPC.indexingQueue),
    reindexSession: (sessionId: string) =>
      ipcRenderer.invoke(IPC.indexingReindexSession, sessionId),
    reindexAll: () => ipcRenderer.invoke(IPC.indexingReindexAll),
    rebuildTraces: () => ipcRenderer.invoke(IPC.indexingRebuildTraces),
    cancel: (jobId: string) => ipcRenderer.invoke(IPC.indexingCancel, jobId),
    retry: (jobId: string) => ipcRenderer.invoke(IPC.indexingRetry, jobId),
    clearFinished: () => ipcRenderer.invoke(IPC.indexingClearFinished),
    onQueue: (cb: (q: IndexQueueDTO) => void) => subscribe(IPC.indexingQueueEvent, cb),
    onTick: (cb: (t: IndexTickDTO) => void) => subscribe(IPC.indexingTickEvent, cb),
  },
  search: {
    query: (input: SearchInput) => ipcRenderer.invoke(IPC.searchQuery, input),
    detail: (frameId: string) => ipcRenderer.invoke(IPC.searchDetail, frameId),
  },
  sessions: {
    list: () => ipcRenderer.invoke(IPC.sessionsList),
    detail: (sessionId: string) => ipcRenderer.invoke(IPC.sessionsDetail, sessionId),
    remove: (sessionId: string) => ipcRenderer.invoke(IPC.sessionsRemove, sessionId),
    tracks: (sessionId: string) => ipcRenderer.invoke(IPC.sessionsTracks, sessionId),
  },
  flows: {
    graph: () => ipcRenderer.invoke(IPC.flowsGraph),
  },
  skills: {
    list: () => ipcRenderer.invoke(IPC.skillsList),
    accept: (routeKey) => ipcRenderer.invoke(IPC.skillsAccept, routeKey),
    dismiss: (routeKey) => ipcRenderer.invoke(IPC.skillsDismiss, routeKey),
    update: (id, patch) => ipcRenderer.invoke(IPC.skillsUpdate, id, patch),
    generate: (id) => ipcRenderer.invoke(IPC.skillsGenerate, id),
    rebind: (id, routeKey) => ipcRenderer.invoke(IPC.skillsRebind, id, routeKey),
    merge: (keepId, mergeId) => ipcRenderer.invoke(IPC.skillsMerge, keepId, mergeId),
    remove: (id) => ipcRenderer.invoke(IPC.skillsRemove, id),
  },
  mcp: {
    status: () => ipcRenderer.invoke(IPC.mcpStatus),
    log: () => ipcRenderer.invoke(IPC.mcpLog),
    onLog: (cb: (entry: McpLogEntryDTO) => void) => subscribe(IPC.mcpLogEvent, cb),
  },
  models: {
    onDownload: (cb: (p: ModelDownloadProgress) => void) =>
      subscribe(IPC.modelDownloadEvent, cb),
  },
  ollama: {
    visionModels: () => ipcRenderer.invoke(IPC.ollamaVisionModels),
    chatModels: () => ipcRenderer.invoke(IPC.ollamaChatModels),
  },
  system: {
    env: () => ipcRenderer.invoke(IPC.systemEnv),
    reset: () => ipcRenderer.invoke(IPC.systemReset),
  },
};

contextBridge.exposeInMainWorld("deskrag", api);
