/**
 * Main entry: opens the store-backed service, registers the deskrag:// protocol
 * and IPC, creates the window, and wires a menu-bar tray with recording status.
 * Closing the window hides to the tray (recording keeps running); Quit exits.
 *
 * IT ALSO HIDES ITSELF WHILE RECORDING, and the tray is the control surface for
 * the duration. Not for tidiness: the window producer polls the frontmost
 * application, so an app left on screen while it records films its own UI and
 * ends up bracketing every route it captures. That is fixed properly at lift
 * time (`trace/exclude.ts` — which also repairs recordings already taken); this
 * just stops producing the problem in the first place.
 *
 * WHICH MAKES THE TRAY A WHOLE CONTROL SURFACE, not a shortcut into the window.
 * Starting and stopping both happen here with nothing shown: a stop initiated
 * from the menu leaves the window exactly where the user left it, and the
 * ghost's own face reports what happened next. The face is the only thing in
 * the menu bar — there is no `setTitle`, because a second glyph beside the mark
 * said what the mark can say itself, and because a menu-bar pixel that CHANGES
 * during a capture is what let this app's own window defeat `mpdecimate`
 * (docs/internals/capture.md). Nothing up there animates, and nothing ticks.
 */

import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron";
import type { NativeImage } from "electron";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { DeskRagService } from "./deskrag-service.js";
import { SettingsStore, dataDir } from "./settings.js";
import { registerIpc } from "./ipc.js";
import { McpExperienceServer } from "./mcp/server.js";
import { ServiceExperienceReader } from "./mcp/reader.js";
import { IPC } from "@shared/types";
import { registerScheme, registerProtocol } from "./protocol.js";
import { ensureToolPath } from "./tool-path.js";
import { resolveAxBin, resolveSidecar } from "./sidecar-path.js";
import { trayFaceAsset, trayIndexing, trayStatusLine, trayTooltip } from "./tray-face.js";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let service: DeskRagService;
let mcp: McpExperienceServer | undefined;
let dir: string;
let quitting = false;

/**
 * Wipes the app data dir and relaunches. `DualStore`/LanceDB are opened once at
 * startup and nothing else in the app re-opens them live, so a relaunch is the
 * safe way back to a clean process rather than re-opening in place.
 *
 * Refused while capture is running, and ALSO while a job is being indexed —
 * that second guard arrived with the queue and is not optional. Indexing used to
 * be a value of the recording state, so one check covered both; now the queue
 * drains in the background and this would otherwise delete the store out from
 * under a running stage mid-write.
 */
async function resetApp(): Promise<void> {
  if (service.status().state !== "idle") {
    throw new Error("Stop the current recording before resetting.");
  }
  if (service.indexQueue().runningJobId !== null) {
    throw new Error("Indexing is in progress — wait for the queue to finish before resetting.");
  }
  quitting = true;
  service.close();
  rmSync(dir, { recursive: true, force: true });
  app.relaunch();
  app.exit(0);
}

registerScheme(); // must precede app.whenReady

// Before anything can spawn: a packaged launch has no Homebrew on PATH, which
// is what makes ffmpeg (audio + screen) and whisper-cli look missing.
ensureToolPath();

// The AX sidecar is REQUIRED for capture, not just for accessibility: the
// device timebase comes from `ax-dump --clock`, and without it a frame can only
// be stamped with its arrival time — measured 3.05s later than its capture time
// on a real screen device. So it is resolved in both shapes:
//   packaged -> Contents/Resources/ax-dump  (electron-builder extraResources)
//   dev      -> <repo>/native/ax-dump       (npm run build:ax)
// An explicit ERAG_AX_BIN always wins.
if (!process.env["ERAG_AX_BIN"]) {
  const found = resolveAxBin(process.resourcesPath, __dirname, existsSync);
  if (found) process.env["ERAG_AX_BIN"] = found;
}

// The computer-audio sidecar, resolved the same two ways. Unlike ax-dump this
// one is OPTIONAL: capture runs without it, and the Record card says the signal
// is unavailable rather than the session refusing to start.
if (!process.env["ERAG_AUDIO_TAP_BIN"]) {
  const found = resolveSidecar("audio-tap", process.resourcesPath, __dirname, existsSync);
  if (found) process.env["ERAG_AUDIO_TAP_BIN"] = found;
}

// `ax-exec` is DELIBERATELY NOT RESOLVED HERE. It is the binary that can click,
// and the app no longer has anything that spawns it: the Flows screen reads the
// stored graph and nothing observes or acts on the live desktop. The executor
// still exists in the library, exercised by the suite and `scripts/replay-probe`
// — pointing an env var at it from the app would be the first step back toward
// a click-capable child process being alive while a window is merely open.

/**
 * Icons live in app/build/, outside the bundle. In dev the main bundle runs
 * from app/out/main; packaged, resources sit beside it. Try both.
 */
function brandAsset(...segments: string[]): string {
  const candidates = [
    join(__dirname, "../../build", ...segments),
    join(process.resourcesPath ?? "", "build", ...segments),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "DeskRAG",
    // EXACTLY the renderer's --ink. It was #0f1115 — one digit off, so the frame
    // Electron paints before the renderer's first paint was a different
    // near-black from the one that replaced it.
    backgroundColor: "#0f1216",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    icon: brandAsset("icon.png"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  });

  win.on("ready-to-show", () => win?.show());
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

/**
 * The four faces, loaded once. A template image is black + alpha; macOS inverts
 * it for the menu bar, so one asset per face covers light and dark.
 *
 * A MISSING VARIANT FALLS BACK TO THE IDLE GHOST rather than to nothing: a blank
 * menu-bar item is indistinguishable from the app having quit, which is the
 * worst thing the tray could claim while a recording is running.
 */
const trayImages = new Map<string, NativeImage>();

function loadTrayImages(): NativeImage {
  const idle = nativeImage.createFromPath(brandAsset("tray", "trayTemplate.png"));
  if (!idle.isEmpty()) idle.setTemplateImage(true);
  // Enumerated through `trayFaceAsset` itself, so there is no second list of
  // face names to go stale against the one the emitter writes.
  for (const recording of [false, true]) {
    for (const indexing of [false, true]) {
      const base = trayFaceAsset(recording, indexing);
      const img = nativeImage.createFromPath(brandAsset("tray", `${base}.png`));
      if (!img.isEmpty()) img.setTemplateImage(true);
      trayImages.set(base, img.isEmpty() ? idle : img);
    }
  }
  return idle;
}

/**
 * Stopping from the tray must NOT summon the window.
 *
 * The menu bar is the control surface precisely because the window is out of
 * the way; a stop that yanks it back defeats the reason the control is here.
 * Clearing the flag first makes `restoreAfterRecording` a no-op for this stop
 * and leaves it intact for the other path — the user who reopened the window
 * mid-recording and pressed the button there.
 *
 * What answers "where did my recording go?" is the ghost: `stopRecording`
 * enqueues, the queue starts, and the face picks up its indexing dots.
 */
function stopFromTray(): void {
  hiddenForRecording = false;
  void service.stopRecording();
}

function rebuildTray(): void {
  if (!tray) return;
  const s = service.status();
  const queue = service.indexQueue();
  const recording = s.state === "recording";
  const face = trayImages.get(trayFaceAsset(recording, trayIndexing(queue)));
  if (face && !face.isEmpty()) tray.setImage(face);
  tray.setToolTip(trayTooltip(s, queue));
  // The toggle comes FIRST. It is the reason this menu exists while the window
  // is hidden, and putting "Open DeskRAG" at the top invites the mis-click this
  // surface is meant to avoid. Sentence case throughout, matching the record
  // button's own labels, so one action keeps one name across both surfaces.
  const menu = Menu.buildFromTemplate([
    { label: trayStatusLine(s, queue), enabled: false },
    { type: "separator" },
    recording
      ? { label: "Stop recording", click: () => stopFromTray() }
      : { label: "Start recording", click: () => void service.startRecording() },
    { label: "Open DeskRAG", click: () => showWindow() },
    { type: "separator" },
    {
      label: "Quit DeskRAG",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function showWindow(): void {
  if (!win) createWindow();
  win?.show();
  win?.focus();
}

/**
 * True while the window is hidden BECAUSE a recording is running, as opposed to
 * hidden because the user closed it to the tray.
 *
 * Without the distinction, stopping a recording would yank a window back onto
 * the screen that the user had deliberately put away.
 */
let hiddenForRecording = false;

/**
 * Hide for the duration of a recording, and come back when it ends.
 *
 * Coming back is the deliberate half. A window that vanishes on Record and never
 * returns is the worse failure of the two, and the moment a recording stops is
 * exactly when there is something to show — the recording has just been handed
 * to the indexing queue. Re-showing focuses this app and can emit one last
 * `focus_change` inside `stopRecording`'s tail; the lift filter drops it, which
 * is that filter working rather than a leak.
 */
function hideForRecording(): void {
  if (!win || !win.isVisible()) return;
  hiddenForRecording = true;
  win.hide();
}

function restoreAfterRecording(): void {
  if (!hiddenForRecording) return;
  hiddenForRecording = false;
  showWindow();
}

function createTray(): void {
  const idle = loadTrayImages();
  tray = new Tray(idle.isEmpty() ? nativeImage.createEmpty() : idle);
  tray.setToolTip("DeskRAG");
  // NO `click` HANDLER ON macOS. A tray with a context menu already opens it on
  // left-click, so the handler that used to sit here ALSO showed the window —
  // the window came up behind the menu on the one gesture meant to avoid it.
  // Elsewhere a bare left-click does nothing at all, so there it pops the menu.
  if (process.platform !== "darwin") tray.on("click", () => tray?.popUpContextMenu());
  rebuildTray();
}

app.whenReady().then(async () => {
  dir = dataDir();
  const settings = new SettingsStore(dir);
  service = new DeskRagService(dir, settings);
  await service.open();

  registerProtocol(service);

  // The MCP endpoint, after the store is open — every tool reads through the
  // service, so there is nothing to serve before then. A bind failure is
  // recorded on the status rather than thrown: an agent endpoint that cannot
  // listen must not stop the app from opening.
  mcp = new McpExperienceServer({
    reader: new ServiceExperienceReader(service),
    port: settings.view().mcp.port,
    version: app.getVersion(),
    onLog: (entry) => win?.webContents.send(IPC.mcpLogEvent, entry),
  });
  if (settings.view().mcp.enabled) await mcp.start();

  registerIpc(service, settings, () => win, resetApp, mcp);
  // Hiding runs from the HOOK, not from here: `onState` fires once every
  // producer is up, by which point the first 500ms window poll has already seen
  // this app frontmost. Restoring has no such race and belongs on the state.
  service.onRecordingWillStart = hideForRecording;
  service.onState((s) => {
    rebuildTray();
    if (s.state === "idle") restoreAfterRecording();
  });
  // THE QUEUE NEEDS ITS OWN SUBSCRIPTION. `rebuildTray` used to run only from
  // `onState`, so the indexing glyph only ever refreshed when a recording
  // transition happened to coincide with one — it was stale the rest of the
  // time. Now that indexing is half of what the ghost's face says, that is a
  // defect rather than a curiosity.
  service.onIndexQueue(() => rebuildTray());

  // An unpackaged macOS dev run shows Electron's own dock icon otherwise.
  if (process.platform === "darwin" && app.dock) {
    const dockIcon = nativeImage.createFromPath(brandAsset("icon.png"));
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
  }

  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on("window-all-closed", () => {
  // Stay alive in the tray; do not quit on macOS window close.
});

app.on("before-quit", (event) => {
  quitting = true;
  // A STOP IN FLIGHT IS THE ONE THING WORTH DELAYING A QUIT FOR. `stopRecording`
  // returns the UI to idle before it has shut the producers down, stamped
  // `ended_at` and enqueued the job — that is what makes the record button live
  // again immediately. Closing the store straight through that window loses all
  // three: measured by driving the app, quitting ~150ms after pressing stop left
  // a real recording with no end stamp and no indexing job. It settles in well
  // under a second, and `app.quit()` re-fires this handler once it has.
  const pending = service?.pendingStop();
  if (pending) {
    event.preventDefault();
    void pending.catch(() => {}).then(() => app.quit());
    return;
  }
  // Closing the listener is fire-and-forget: a socket the OS is about to reclaim
  // anyway must not delay the quit.
  void mcp?.stop();
  service?.close();
});
