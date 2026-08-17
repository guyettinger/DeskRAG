/**
 * Main entry: opens the store-backed service, registers the deskrag:// protocol
 * and IPC, creates the window, and wires a menu-bar tray with recording status.
 * Closing the window hides to the tray (recording keeps running); Quit exits.
 */

import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron";
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
import { resolveAxBin } from "./sidecar-path.js";

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
 * Recording wins the tray title over indexing, because only one of them is
 * capturing something unrepeatable. Indexing still gets its own glyph: it now
 * runs in the background for minutes at a time, and a tray that showed nothing
 * would make the machine's fans the only evidence of it.
 */
function trayTitle(): string {
  if (service.status().state === "recording") return "⏺ REC";
  if (service.indexQueue().runningJobId !== null) return "⏳";
  return "◉";
}

function rebuildTray(): void {
  if (!tray) return;
  const s = service.status();
  const indexing = service.indexQueue().runningJobId !== null;
  tray.setTitle(trayTitle());
  tray.setToolTip(`DeskRAG — ${s.state}${indexing ? " · indexing" : ""}`);
  const menu = Menu.buildFromTemplate([
    { label: "Open DeskRAG", click: () => showWindow() },
    { type: "separator" },
    s.state === "recording"
      ? { label: "Stop Recording", click: () => void service.stopRecording() }
      : {
          label: "Start Recording",
          enabled: s.state === "idle",
          click: () => void service.startRecording(),
        },
    { type: "separator" },
    {
      label: "Quit",
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

function createTray(): void {
  // A template image is black + alpha; macOS inverts it for the menu bar, so
  // one asset covers light and dark. Falls back to an empty image rather than
  // throwing if the generated icon is missing.
  const trayIcon = nativeImage.createFromPath(brandAsset("tray", "trayTemplate.png"));
  if (!trayIcon.isEmpty()) trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon);
  tray.setToolTip("DeskRAG");
  tray.on("click", () => showWindow());
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
  service.onState(() => rebuildTray());

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
