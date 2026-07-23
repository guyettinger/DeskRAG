/**
 * macOS permission helpers. Screen Recording and Accessibility cannot be granted
 * programmatically — we can only read their status and deep-link the user to the
 * right System Settings pane. Microphone can be prompted in-app.
 */

import { systemPreferences, shell } from "electron";
import type {
  PermissionKind,
  PermissionState,
  PermissionStatus,
} from "@shared/types";

const isMac = process.platform === "darwin";

const SETTINGS_PANE: Record<PermissionKind, string> = {
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

function mediaState(kind: "screen" | "microphone"): PermissionState {
  if (!isMac) return "unknown";
  // getMediaAccessStatus: 'not-determined'|'granted'|'denied'|'restricted'|'unknown'
  return systemPreferences.getMediaAccessStatus(kind) as PermissionState;
}

function accessibilityState(): PermissionState {
  if (!isMac) return "unknown";
  return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
}

export function statusFor(kind: PermissionKind): PermissionStatus {
  const state =
    kind === "accessibility" ? accessibilityState() : mediaState(kind);
  return { kind, state, canRequest: isMac && kind === "microphone" };
}

export function checkAll(): PermissionStatus[] {
  return (["screen", "microphone", "accessibility"] as PermissionKind[]).map(statusFor);
}

export async function request(kind: PermissionKind): Promise<PermissionStatus> {
  if (isMac && kind === "microphone") {
    await systemPreferences.askForMediaAccess("microphone");
  }
  return statusFor(kind);
}

export async function openSettings(kind: PermissionKind): Promise<void> {
  await shell.openExternal(SETTINGS_PANE[kind]);
}
